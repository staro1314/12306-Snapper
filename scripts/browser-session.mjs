import http from "node:http";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const host = "127.0.0.1";
const port = 3211;
const profileDir = path.resolve(".browser-session/profile");
const statusFile = path.resolve(".browser-session/status.json");
const loginUrl = "https://kyfw.12306.cn/otn/resources/login.html";
const ORDER_CONFIRM_REQUEST_TIMEOUT_MS = 30_000;
const ORDER_QUEUE_TIMEOUT_MS = 5 * 60_000;
const ORDER_QUEUE_RESPONSE_TIMEOUT_MS = 35_000;
// The observed protocol profile has completed a real pending-order acceptance run.
// Real submission is therefore available by default, but every task still needs explicit
// per-task authorization. Set the environment variable to 0 as an emergency kill switch.
const realSubmissionEnabled = process.env.FAST_12306_ENABLE_REAL_SUBMISSION !== "0";
let context;
let page;
let polling;
let browserHeadless = false;
let suppressCloseRecovery = false;
let recoveryTimer;
// Closing the visible official window is not a logout. Remember that this
// process has observed a valid official session so the same persistent profile
// can be reopened headlessly even if the page is between two status checks at
// the exact moment Chrome closes.
let authenticatedSessionObserved = false;
const observations = [];
let passengerSnapshot = [];
const passengerSecrets = new Map();
let officialClock = null;
let latestQuery = null;
let lastOfficialQueryStartedAt = 0;
let securityState = null;
let orderExecutionInProgress = false;
let orderQueueState = { status: "IDLE", orderRef: null, waitTime: null, confirmPath: null, queueAcceptedAt: null, queueAcceptedDurationMs: null, updatedAt: new Date().toISOString() };
let status = { state: "idle", message: "尚未打开 12306 官方登录页", updatedAt: new Date().toISOString() };

const seatOptionLabel = (label) => ({
  "商务座": "商务座", "特等座": "特等座", "一等座": "一等座", "二等座": "二等座",
  "软卧": "软卧", "硬卧": "硬卧", "软座": "软座", "硬座": "硬座", "无座": "硬座",
})[label] ?? label;

const ticketTypeLabel = (passenger) => {
  const name = String(passenger?.passenger_type_name ?? "");
  if (name.includes("学生")) return "学生票";
  if (name.includes("儿童")) return "儿童票";
  return "成人票";
};

async function ensurePassengerSelected(targetPage, passenger) {
  const label = targetPage.locator("label:visible").filter({ hasText: String(passenger.passenger_name) }).first();
  if (!(await label.count())) throw new Error("确认页未找到所选乘车人");
  const controlId = await label.getAttribute("for");
  const checkbox = controlId ? targetPage.locator(`input[type="checkbox"][id="${controlId.replaceAll('"', '\\"')}"]`) : label.locator('input[type="checkbox"]');
  if (!(await checkbox.count())) throw new Error("确认页乘车人控件结构不兼容");
  if (!(await checkbox.isChecked())) await checkbox.click({ force: true });
}

async function updateStatus(state, message) {
  status = { state, message, updatedAt: new Date().toISOString() };
  await mkdir(path.dirname(statusFile), { recursive: true });
  await writeFile(statusFile, JSON.stringify(status, null, 2), "utf8");
}

async function inspectLoginState() {
  if (!page || page.isClosed()) return updateStatus("closed", "登录浏览器已关闭");
  try {
    const result = await page.evaluate(async () => {
      const visibleLogout = Boolean(document.querySelector("#J-header-logout, .header-logout"));
      try {
        const response = await fetch("/otn/login/conf", { method: "POST", credentials: "include" });
        const body = await response.json();
        const value = body?.data?.loginCheck ?? body?.data?.is_login ?? body?.data?.flag;
        return { visibleLogout, value, qrResultCode: typeof window.popup_s === "undefined" ? null : String(window.popup_s), nowStr: body?.data?.nowStr ?? null, nowValue: body?.data?.now ?? null, security: { isSweepLogin: body?.data?.is_sweep_login ?? null, isUamLogin: body?.data?.is_uam_login ?? null, isLoginPassCode: body?.data?.is_login_passCode ?? null, isMessagePassCode: body?.data?.is_message_passCode ?? null, isPhoneCheck: body?.data?.is_phone_check ?? null } };
      } catch { return { visibleLogout, value: null, qrResultCode: typeof window.popup_s === "undefined" ? null : String(window.popup_s) }; }
    });
    const epochCandidate = Number(result.nowValue);
    officialClock = { nowStr: typeof result.nowStr === "string" ? result.nowStr : officialClock?.nowStr ?? null, epochMs: Number.isFinite(epochCandidate) && epochCandidate > 1_000_000_000_000 ? epochCandidate : null };
    securityState = result.security;
    if (result.visibleLogout || result.value === "Y" || result.value === true) {
      authenticatedSessionObserved = true;
      await updateStatus("logged_in", "已确认当前 12306 官方会话登录成功");
    } else if (result.qrResultCode === "1") {
      await updateStatus("awaiting_login", "二维码已扫描，请在铁路 12306 App 中确认登录");
    } else if (result.qrResultCode === "2") {
      await updateStatus("starting", "App 已确认，正在完成 12306 官方会话认证");
    } else if (result.qrResultCode === "3") {
      await updateStatus("awaiting_login", "二维码已失效，请刷新后重新扫描");
    } else if (result.qrResultCode === "5") {
      await updateStatus("user_action_required", "12306 返回登录系统异常，请刷新二维码重试");
    } else {
      await updateStatus("awaiting_login", "请扫描系统内的 12306 官方二维码");
    }
  } catch (error) {
    await updateStatus("user_action_required", `无法确认登录状态，请检查官方窗口：${error.message}`);
  }
}

async function captureLoginQrCode() {
  if (!page || page.isClosed()) await startBrowser({ headless: true });
  await inspectLoginState();
  if (status.state === "logged_in") return { state: status.state, message: status.message, qrDataUrl: null };
  if (new URL(page.url()).pathname !== new URL(loginUrl).pathname) {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  }
  await page.evaluate(() => {
    const jquery = window.jQuery;
    if (jquery && typeof jquery.popup_createQr === "function") jquery.popup_createQr();
  });
  await page.waitForFunction(() => {
    const image = document.querySelector("#J-qrImg");
    return image instanceof HTMLImageElement && (image.currentSrc || image.src).startsWith("data:image/");
  }, null, { timeout: 10000 });
  const officialQrDataUrl = await page.locator("#J-qrImg").getAttribute("src");
  if (officialQrDataUrl?.startsWith("data:image/")) {
    return {
      state: status.state,
      message: "请使用铁路 12306 App 扫描二维码",
      qrDataUrl: officialQrDataUrl,
    };
  }
  const qrSelectors = ["#J-qrImg", ".qr-img img", "img[src*='qr']", ".qr-img", ".login-code img", "canvas"];
  let qrTarget = null;
  for (const selector of qrSelectors) {
    const candidate = page.locator(selector).first();
    if (await candidate.count() && await candidate.isVisible().catch(() => false)) {
      qrTarget = candidate;
      break;
    }
  }
  if (!qrTarget) {
    await page.waitForTimeout(1200);
    for (const selector of qrSelectors) {
      const candidate = page.locator(selector).first();
      if (await candidate.count() && await candidate.isVisible().catch(() => false)) {
        qrTarget = candidate;
        break;
      }
    }
  }
  if (!qrTarget) throw new Error("12306 官方登录页未返回可识别的二维码");
  const png = await qrTarget.screenshot({ type: "png" });
  return {
    state: status.state,
    message: "请使用铁路 12306 App 扫描二维码",
    qrDataUrl: `data:image/png;base64,${png.toString("base64")}`,
  };
}

async function ensureSearchPage() {
  if (!page || page.isClosed()) throw new Error("请先打开并登录 12306");
  const currentPath = new URL(page.url()).pathname;
  const ready = currentPath === "/otn/leftTicket/init" && await page.evaluate(() => typeof window.station_names === "string" && Boolean(document.querySelector("#query_ticket"))).catch(() => false);
  if (ready) return;
  await page.goto("https://kyfw.12306.cn/otn/leftTicket/init", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.station_names === "string" && Boolean(document.querySelector("#query_ticket")), null, { timeout: 15000 });
}

function summarizeShape(value) {
  if (Array.isArray(value)) return { kind: "array", length: value.length, itemKeys: value[0] && typeof value[0] === "object" ? Object.keys(value[0]).sort() : [] };
  if (value && typeof value === "object") return { kind: "object", keys: Object.keys(value).sort() };
  return { kind: typeof value };
}

function parseTicketCandidate(row) {
  const fields = String(row).split("|");
  return {
    // Kept only in this local sidecar process. It is required by the official
    // submitOrderRequest call and is deliberately stripped from every API response/log.
    secretStr: fields[0] ?? "",
    trainInternalRef: fields[2] ?? "",
    trainCode: fields[3] ?? "",
    fromStationCode: fields[6] ?? "",
    toStationCode: fields[7] ?? "",
    departureTime: fields[8] ?? "",
    arrivalTime: fields[9] ?? "",
    duration: fields[10] ?? "",
    canBook: fields[11] === "Y",
    seats: {
      business: fields[32] ?? "",
      firstClass: fields[31] ?? "",
      secondClass: fields[30] ?? "",
      premiumSoftSleeper: fields[21] ?? "",
      softSleeper: fields[23] ?? "",
      hardSleeper: fields[28] ?? "",
      softSeat: fields[24] ?? "",
      hardSeat: fields[29] ?? "",
      noSeat: fields[26] ?? "",
      other: fields[22] ?? "",
    },
  };
}

function publicTicketCandidate(candidate) {
  const { secretStr: _secretStr, ...safe } = candidate;
  return safe;
}

function attachReadOnlyObserver(targetPage) {
  targetPage.on("response", async (response) => {
    try {
      const url = new URL(response.url());
      if (url.hostname !== "kyfw.12306.cn") return;
      const contentType = response.headers()["content-type"] ?? "";
      const entry = { method: response.request().method(), path: url.pathname, status: response.status(), resourceType: response.request().resourceType(), contentType: contentType.split(";")[0], observedAt: new Date().toISOString() };
      if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
        try { entry.redirectPath = new URL(response.headers().location, response.url()).pathname; } catch { entry.redirectPath = "UNPARSEABLE"; }
      }
      if (contentType.includes("json")) {
        const body = await response.json();
        entry.responseShape = summarizeShape(body);
        if (body?.data !== undefined) {
          entry.dataShape = summarizeShape(body.data);
          if (body.data && typeof body.data === "object" && !Array.isArray(body.data)) {
            entry.nestedShapes = Object.fromEntries(Object.entries(body.data)
              .filter(([, value]) => Array.isArray(value))
              .map(([key, value]) => [key, summarizeShape(value)]));
          }
        }
        if (url.pathname === "/otn/passengers/query" && Array.isArray(body?.data?.datas)) {
          entry.passengerStatusCodes = {
            isBuyTicket: [...new Set(body.data.datas.map((item) => String(item.is_buy_ticket)))],
            isActive: [...new Set(body.data.datas.map((item) => String(item.is_active)))],
            passengerFlag: [...new Set(body.data.datas.map((item) => String(item.passenger_flag)))],
          };
          passengerSnapshot = body.data.datas.map((item, index) => {
            const identitySeed = item.passenger_uuid || item.allEncStr || `${item.passenger_name}:${item.passenger_id_no}`;
            const name = String(item.passenger_name ?? "乘车人");
            const typeName = String(item.passenger_type_name ?? "成人");
            const passengerRef = `p_${createHash("sha256").update(String(identitySeed)).digest("hex").slice(0, 16)}`;
            passengerSecrets.set(passengerRef, item);
            return {
              passengerRef,
              displayName: `${Array.from(name)[0] ?? "乘"}${"*".repeat(Math.max(1, Array.from(name).length - 1))}`,
              ticketType: typeName.includes("学生") ? "student" : typeName.includes("儿童") ? "child" : "adult",
              ticketTypeLabel: typeName,
              priority: index + 1,
              // The authenticated passenger list is the source of truth for records that the
              // official booking page can present. is_active is retained as an observation only:
              // it is not equivalent to whether the passenger can be selected on the order page.
              // The order preflight remains the final guard because it checks the live official form.
              officialActive: item.is_active === true || item.is_active === "Y" || item.is_active === "1" || item.is_active === 1,
              verified: true,
            };
          });
        }
        if (url.pathname === "/passport/web/checkqr") {
          const qrResultCode = String(body?.result_code ?? "");
          if (qrResultCode === "1") await updateStatus("awaiting_login", "二维码已扫描，请在铁路 12306 App 中确认登录");
          else if (qrResultCode === "2") await updateStatus("starting", "App 已确认，正在完成 12306 官方会话认证");
          else if (qrResultCode === "3") await updateStatus("awaiting_login", "二维码已失效，请刷新后重新扫描");
          else if (qrResultCode === "5") await updateStatus("user_action_required", "12306 返回登录系统异常，请刷新二维码重试");
        }
      }
      observations.push(entry);
      if (observations.length > 300) observations.splice(0, observations.length - 300);
    } catch { /* A failed metadata read must never interfere with the official page. */ }
  });
}

async function startBrowser({ headless = false } = {}) {
  if (context) {
    if (browserHeadless && !headless) {
      suppressCloseRecovery = true;
      await context.close();
      suppressCloseRecovery = false;
      context = undefined;
      page = undefined;
    } else {
      const pages = context.pages();
      page = pages[0] ?? await context.newPage();
      if (!headless) await page.bringToFront();
      return status;
    }
  }
  if (headless && authenticatedSessionObserved) {
    await updateStatus("logged_in", "官方窗口已关闭，正在后台恢复并复核 12306 会话");
  } else {
    await updateStatus("starting", headless ? "正在恢复后台 12306 会话" : "正在启动持久化 Chrome");
  }
  await mkdir(profileDir, { recursive: true });
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless,
    // 12306 initializes the QR panel from layout dimensions. A headless
    // context with the visible-window `null` viewport collapses it to 0x0.
    viewport: headless ? { width: 1280, height: 900 } : null,
    args: headless ? [] : ["--start-maximized"],
  });
  browserHeadless = headless;
  page = context.pages()[0] ?? await context.newPage();
  for (const openPage of context.pages()) attachReadOnlyObserver(openPage);
  context.on("page", attachReadOnlyObserver);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  if (headless && authenticatedSessionObserved) {
    await updateStatus("logged_in", "登录窗口已关闭，后台正在复核并保持 12306 会话");
  } else {
    await updateStatus(headless ? "starting" : "awaiting_login", headless ? "登录窗口已关闭，后台正在保持会话" : "请在打开的 12306 官方窗口中扫码并完成必要核验");
  }
  polling = setInterval(inspectLoginState, 2000);
  context.on("close", () => {
    clearInterval(polling);
    polling = undefined;
    context = undefined;
    page = undefined;
    if (!suppressCloseRecovery && authenticatedSessionObserved) {
      clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => startBrowser({ headless: true }).catch((error) => updateStatus("closed", `官方窗口已关闭，后台会话恢复失败：${error.message}`)), 800);
    } else if (!suppressCloseRecovery) {
      updateStatus("closed", "登录浏览器已关闭");
    }
  });
  return status;
}

async function logoutBrowser() {
  clearTimeout(recoveryTimer);
  suppressCloseRecovery = true;
  if (polling) clearInterval(polling);
  polling = undefined;
  passengerSnapshot = [];
  passengerSecrets.clear();
  authenticatedSessionObserved = false;
  if (context) {
    await context.clearCookies();
    await context.close();
  }
  suppressCloseRecovery = false;
  context = undefined;
  page = undefined;
  browserHeadless = false;
  await updateStatus("idle", "已退出 12306，会话已从本机浏览器清除");
  return status;
}

function send(response, code, payload) {
  response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function updateQueueState(patch) {
  orderQueueState = { ...orderQueueState, ...patch, updatedAt: new Date().toISOString() };
  return orderQueueState;
}

async function monitorOfficialQueue(confirmPath) {
  const deadline = Date.now() + ORDER_QUEUE_TIMEOUT_MS;
  let lastWaitTime = null;
  try {
    while (Date.now() < deadline) {
      const waitResponse = await page.waitForResponse((candidate) => candidate.url().includes("/confirmPassenger/queryOrderWaitTime"), { timeout: Math.min(ORDER_QUEUE_RESPONSE_TIMEOUT_MS, deadline - Date.now()) }).catch(() => null);
      if (!waitResponse) continue;
      const waitBody = await waitResponse.json().catch(() => null);
      const orderId = waitBody?.data?.orderId;
      lastWaitTime = Number.isFinite(waitBody?.data?.waitTime) ? waitBody.data.waitTime : lastWaitTime;
      updateQueueState({ waitTime: lastWaitTime });
      if (orderId) return updateQueueState({ status: "PAYMENT_PENDING", orderRef: `o_${createHash("sha256").update(String(orderId)).digest("hex").slice(0, 16)}`, waitTime: lastWaitTime, confirmPath });
      if (lastWaitTime != null && lastWaitTime < 0) break;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await page.waitForTimeout(2000);
      const pending = await page.evaluate(async () => {
        try {
          const officialResponse = await fetch("/otn/queryOrder/queryMyOrderNoComplete", { method: "POST", credentials: "include", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" }, body: "_json_att=" });
          const body = await officialResponse.json();
          const orders = Array.isArray(body?.data?.orderDBList) ? body.data.orderDBList : Array.isArray(body?.data?.orders) ? body.data.orders : [];
          const order = orders[0];
          return body?.status === true && order ? String(order.sequence_no ?? order.order_id ?? order.orderId ?? "") : "";
        } catch { return ""; }
      });
      if (pending) return updateQueueState({ status: "PAYMENT_PENDING", orderRef: `o_${createHash("sha256").update(pending).digest("hex").slice(0, 16)}`, waitTime: lastWaitTime, confirmPath });
    }
    return updateQueueState({ status: "UNKNOWN", orderRef: null, waitTime: lastWaitTime, confirmPath });
  } catch (error) {
    return updateQueueState({ status: "UNKNOWN", orderRef: null, waitTime: lastWaitTime, confirmPath, error: String(error?.message ?? error).slice(0, 160) });
  }
}

http.createServer(async (request, response) => {
  try {
    const hostHeader = String(request.headers.host ?? "").split(":")[0].replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(hostHeader)) return send(response, 403, { error: "仅允许本机访问浏览器会话服务" });
    const origin = request.headers.origin;
    if (origin) {
      let originHost = "";
      try { originHost = new URL(origin).hostname; } catch { return send(response, 403, { error: "请求来源无效" }); }
      if (!["127.0.0.1", "localhost", "::1"].includes(originHost)) return send(response, 403, { error: "拒绝非本机网页调用" });
    }
    if (request.method === "GET" && request.url === "/status") return send(response, 200, status);
    if (request.method === "POST" && request.url === "/logout") return send(response, 200, await logoutBrowser());
    if (request.method === "GET" && request.url === "/capabilities") return send(response, 200, { queryEnabled: true, realSubmissionEnabled });
    if (request.method === "GET" && request.url === "/order/queue-status") return send(response, 200, { source: "12306_OFFICIAL", ...orderQueueState });
    if (request.method === "GET" && request.url === "/official-clock") return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", now: officialClock?.epochMs ?? officialClock?.nowStr ?? null });
    if (request.method === "GET" && request.url === "/stations") {
      await ensureSearchPage();
      const stations = await page.evaluate(() => {
        if (typeof window.station_names !== "string") throw new Error("当前官方站点表不可用");
        return window.station_names.split("@").filter(Boolean).map((row) => row.split("|")[1]).filter(Boolean);
      });
      return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", stations: [...new Set(stations)] });
    }
    if (request.method === "POST" && request.url === "/sale-time") {
      const input = await readJsonBody(request);
      const stationName = String(input.stationName ?? "").trim().replace(/站$/, "");
      if (!stationName || stationName.length > 30) return send(response, 400, { error: "起售车站名称无效" });
      const officialUrl = new URL("https://mobile.12306.cn/weixin/wxcore/queryQssj"); officialUrl.searchParams.set("stationName", stationName);
      const officialResponse = await fetch(officialUrl, { headers: { "Cache-Control": "no-cache" } });
      const body = await officialResponse.json().catch(() => null);
      if (!officialResponse.ok || body?.status !== true || !Array.isArray(body?.data)) return send(response, 409, { classification: "INCOMPATIBLE", error: "12306 官方起售时间响应不兼容" });
      const match = body.data.find((item) => String(item?.name ?? "").replace(/站$/, "") === stationName);
      if (!match || !/^\d{2}:\d{2}$/.test(String(match.value ?? ""))) return send(response, 404, { error: "官方未返回该车站的起售时间" });
      return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", stationName, saleTime: String(match.value) });
    }
    if (request.method === "GET" && request.url === "/security-state") return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", ...securityState });
    if (request.method === "POST" && request.url === "/preflight") {
      const input = await readJsonBody(request);
      await inspectLoginState();
      if (status.state !== "logged_in") return send(response, 409, { classification: "USER_ACTION_REQUIRED", error: "12306 登录状态无效" });
      if (!Array.isArray(input.passengerRefs) || !input.passengerRefs.length || input.passengerRefs.some((ref) => !passengerSecrets.get(ref))) return send(response, 409, { classification: "USER_ACTION_REQUIRED", error: "乘车人引用未同步或已失效" });
      if (!securityState || securityState.isSweepLogin !== "Y" || securityState.isUamLogin !== "Y") return send(response, 409, { classification: "USER_ACTION_REQUIRED", error: "当前会话需要 App 或 UAM 核验" });
      const conflictCheck = await page.evaluate(async () => {
        try {
          const result = await fetch("/otn/queryOrder/queryMyOrderNoComplete", { method: "POST", credentials: "include", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" }, body: "_json_att=" });
          const body = await result.json();
          if (body?.status !== true) return "UNKNOWN";
          return body.data == null ? "EMPTY" : "PRESENT";
        } catch { return "UNKNOWN"; }
      });
      if (conflictCheck === "PRESENT") return send(response, 409, { classification: "CONFLICTING_ORDER", error: "官方账号存在未完成订单，请先人工核对" });
      if (conflictCheck === "UNKNOWN") return send(response, 409, { classification: "INCOMPATIBLE", error: "无法确认官方未完成订单状态" });
      await ensureSearchPage();
      return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", compatible: true, officialClock, conflictCheck });
    }
    if (request.method === "POST" && request.url === "/start") {
      const input = await readJsonBody(request);
      return send(response, 200, await startBrowser({ headless: input.visible === false }));
    }
    if (request.method === "GET" && request.url === "/login/qr") return send(response, 200, await captureLoginQrCode());
    if (request.method === "GET" && request.url === "/observe/network") return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", entries: observations });
    if (request.method === "GET" && request.url === "/passengers") return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", passengers: passengerSnapshot });
    if (request.method === "GET" && request.url === "/observe/account-links") {
      if (!page || page.isClosed()) return send(response, 409, { error: "请先打开并登录 12306" });
      const links = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]"))
        .map((link) => ({ text: (link.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40), href: link.getAttribute("href") ?? "" }))
        .filter((link) => /passenger|contact|常用|乘车人/i.test(`${link.text} ${link.href}`))
        .map((link) => { try { return { text: link.text, path: new URL(link.href, location.href).pathname }; } catch { return { text: link.text, path: "" }; } })
        .filter((link) => link.path));
      return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", currentPath: new URL(page.url()).pathname, links });
    }
    if (request.method === "DELETE" && request.url === "/observe/network") { observations.length = 0; return send(response, 204, {}); }
    if (request.method === "POST" && request.url === "/observe/passengers-page") {
      if (!page || page.isClosed()) return send(response, 409, { error: "请先打开并登录 12306" });
      observations.length = 0;
      const passengerResponse = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/otn/passengers/query", { timeout: 15000 }).catch(() => null);
      await page.goto("https://kyfw.12306.cn/otn/view/passengers.html", { waitUntil: "domcontentloaded" });
      await passengerResponse;
      await page.waitForTimeout(250);
      return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", page: "/otn/view/passengers.html", passengers: passengerSnapshot, entries: observations });
    }
    if (request.method === "POST" && request.url === "/observe/search-page") {
      if (!page || page.isClosed()) return send(response, 409, { error: "请先打开并登录 12306" });
      observations.length = 0;
      await ensureSearchPage();
      return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", page: "/otn/leftTicket/init", entries: observations });
    }
    if (request.method === "POST" && request.url === "/observe/query") {
      if (!page || page.isClosed()) return send(response, 409, { error: "请先打开并登录 12306" });
      const input = await readJsonBody(request);
      if (![input.fromStation, input.toStation, input.travelDate].every((value) => typeof value === "string" && value.length > 0 && value.length < 40)) return send(response, 400, { error: "查询参数无效" });
      await ensureSearchPage();
      const stationCodes = await page.evaluate(({ fromStation, toStation }) => {
        const stationText = window.station_names;
        if (typeof stationText !== "string") throw new Error("当前页面未加载官方站点表");
        const stations = stationText.split("@").filter(Boolean).map((row) => row.split("|")).map((row) => ({ name: row[1], code: row[2] }));
        const fromCode = stations.find((station) => station.name === fromStation)?.code;
        const toCode = stations.find((station) => station.name === toStation)?.code;
        if (!fromCode || !toCode) throw new Error("官方站点表中未找到发站或到站");
        return { fromCode, toCode };
      }, input);
      await page.evaluate(({ fromStation, toStation, travelDate, fromCode, toCode }) => {
        const set = (selector, value) => { const element = document.querySelector(selector); if (!element) throw new Error(`查询表单缺少 ${selector}`); element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); };
        set("#fromStationText", fromStation); set("#fromStation", fromCode); set("#toStationText", toStation); set("#toStation", toCode); set("#train_date", travelDate);
      }, { ...input, ...stationCodes });
      const remainingCooldown = 5100 - (Date.now() - lastOfficialQueryStartedAt);
      if (remainingCooldown > 0) await page.waitForTimeout(remainingCooldown);
      const responsePromise = page.waitForResponse((candidate) => /\/otn\/leftTicket\/query/.test(new URL(candidate.url()).pathname), { timeout: 15000 });
      lastOfficialQueryStartedAt = Date.now();
      await page.locator("#query_ticket").click();
      const apiResponse = await responsePromise;
      if (apiResponse.status() >= 300 && apiResponse.status() < 400) {
        let redirectPath = "UNAVAILABLE";
        try { redirectPath = new URL(apiResponse.headers().location, apiResponse.url()).pathname; } catch { /* Return a safe classification without the raw Location value. */ }
        return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", path: new URL(apiResponse.url()).pathname, status: apiResponse.status(), compatible: false, classification: "QUERY_REDIRECTED", redirectPath });
      }
      if (!(apiResponse.headers()["content-type"] ?? "").includes("json")) return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", path: new URL(apiResponse.url()).pathname, status: apiResponse.status(), compatible: false, classification: "UNEXPECTED_CONTENT_TYPE" });
      const body = await apiResponse.json();
      const rows = Array.isArray(body?.data?.result) ? body.data.result : [];
      if (body?.status !== true) {
        const safeText = JSON.stringify(body?.messages ?? body?.validateMessagesShowId ?? "");
        const classification = /频繁|稍后|busy|rate/i.test(safeText) ? "RATE_LIMITED" : /登录|验证|login|uam/i.test(safeText) ? "USER_ACTION_REQUIRED" : "INCOMPATIBLE";
        return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", path: new URL(apiResponse.url()).pathname, status: apiResponse.status(), success: false, compatible: false, classification });
      }
      latestQuery = { input, candidates: rows.map(parseTicketCandidate) };
      const result = { path: new URL(apiResponse.url()).pathname, status: apiResponse.status(), responseKeys: Object.keys(body).sort(), dataKeys: body?.data && typeof body.data === "object" ? Object.keys(body.data).sort() : [], resultCount: rows.length, stationMapCount: body?.data?.map && typeof body.data.map === "object" ? Object.keys(body.data.map).length : null, success: body?.status === true, candidates: latestQuery.candidates.map(publicTicketCandidate) };
      return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", ...result });
    }
    if (request.method === "POST" && request.url === "/observe/order-initialize") {
      if (!page || page.isClosed() || !latestQuery) return send(response, 409, { error: "请先完成一次余票查询" });
      const input = await readJsonBody(request);
      if (input.confirmObservation !== true || typeof input.trainCode !== "string") return send(response, 400, { error: "订单初始化观测参数无效" });
      const train = latestQuery.candidates.find((candidate) => candidate.trainCode === input.trainCode && candidate.canBook);
      if (!train) return send(response, 409, { error: "最近查询中没有该可预订车次" });
      observations.length = 0;
      // Do not click the rendered train row. That path waits for table event handlers and a
      // browser redirect. Submit the exact secret from the immediately preceding official query,
      // then load the official confirmation page only after 12306 accepts initialization.
      const initialization = await page.evaluate(async ({ secretStr, query }) => {
        const readValue = (selector, fallback) => document.querySelector(selector)?.value || fallback;
        const body = new URLSearchParams({
          secretStr: decodeURIComponent(secretStr),
          train_date: query.travelDate,
          back_train_date: readValue("#back_train_date", query.travelDate),
          tour_flag: readValue("#tour_flag", "dc"),
          purpose_codes: readValue("#purpose_codes", "ADULT"),
          query_from_station_name: query.fromStation,
          query_to_station_name: query.toStation,
          undefined: "",
        });
        const officialResponse = await fetch("/otn/leftTicket/submitOrderRequest", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
          body: body.toString(),
        });
        const payload = await officialResponse.json().catch(() => null);
        return { status: officialResponse.status, accepted: payload?.status === true, message: String(payload?.messages?.[0] ?? payload?.validateMessages?.[0] ?? "").replace(/\s+/g, " ").slice(0, 160) };
      }, { secretStr: train.secretStr, query: latestQuery.input });
      if (!initialization.accepted) return send(response, 409, { classification: "ORDER_INITIALIZATION_REJECTED", error: initialization.message ? `12306 订单初始化未通过：${initialization.message}` : "12306 订单初始化未通过" });
      await page.goto("https://kyfw.12306.cn/otn/confirmPassenger/initDc", { waitUntil: "domcontentloaded", timeout: 15000 });
      const currentPath = new URL(page.url()).pathname;
      if (currentPath !== "/otn/confirmPassenger/initDc") return send(response, 409, { classification: "INCOMPATIBLE", error: "订单初始化后未进入官方确认页面" });
      return send(response, 200, { source: "12306_OFFICIAL_OBSERVATION", trainCode: input.trainCode, submitInitPath: "/otn/leftTicket/submitOrderRequest", submitInitStatus: initialization.status, currentPath, entries: observations });
    }
    if (request.method === "GET" && request.url === "/observe/order-endpoints") {
      if (!page || page.isClosed()) return send(response, 409, { error: "请先打开并登录 12306" });
      const endpoints = await page.evaluate(async () => {
        const scripts = Array.from(document.scripts).map((script) => script.src).filter((src) => src && src.includes("kyfw.12306.cn"));
        const paths = new Set();
        for (const scriptUrl of scripts) {
          try {
            const text = await (await fetch(scriptUrl, { credentials: "include" })).text();
            for (const match of text.matchAll(/['\"]([^'\"?#]*(?:submit|confirm|queue|order|pay)[^'\"?#]*)/gi)) {
              const value = match[1];
              if (value.includes("/") && value.length < 180) paths.add(value);
            }
          } catch { /* One optional script must not fail the complete read-only inventory. */ }
        }
        return [...paths].sort();
      });
      return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", endpoints });
    }
    if (request.method === "POST" && request.url === "/observe/orders-page") {
      if (!page || page.isClosed()) return send(response, 409, { error: "请先打开并登录 12306" });
      observations.length = 0;
      await page.goto("https://kyfw.12306.cn/otn/view/train_order.html", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3500);
      return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", page: new URL(page.url()).pathname, entries: observations });
    }
    if (request.method === "POST" && request.url === "/orders/reconcile") {
      if (!page || page.isClosed()) return send(response, 409, { error: "请先打开并登录 12306" });
      const load = async () => {
        const responsePromise = page.waitForResponse((candidate) => candidate.url().includes("/queryOrder/queryMyOrderNoComplete"), { timeout: 10000 }).catch(() => null);
        await page.goto("https://kyfw.12306.cn/otn/view/train_order.html", { waitUntil: "domcontentloaded" });
        return responsePromise;
      };
      let officialResponse = await load();
      if (!officialResponse) { await page.waitForTimeout(1500); officialResponse = await load(); }
      if (!officialResponse) return send(response, 409, { classification: "USER_ACTION_REQUIRED", error: "官方订单页面要求重新核验登录" });
      const body = await officialResponse.json();
      if (body?.status !== true) return send(response, 409, { classification: "ORDER_RECONCILIATION_REJECTED", error: "官方未支付订单查询失败" });
      if (body.data == null) return send(response, 200, { source: "12306_OFFICIAL", classification: "EMPTY", orders: [] });
      const rawOrders = Array.isArray(body.data?.orderDBList) ? body.data.orderDBList : Array.isArray(body.data?.orders) ? body.data.orders : null;
      if (!rawOrders) return send(response, 200, { source: "12306_OFFICIAL", classification: "UNKNOWN_STRUCTURE", dataKeys: typeof body.data === "object" ? Object.keys(body.data).sort() : [] });
      const orders = rawOrders.map((order) => {
        const rawRef = order.sequence_no ?? order.order_id ?? order.orderId ?? "unknown";
        const tickets = Array.isArray(order.tickets) ? order.tickets : Array.isArray(order.ticketList) ? order.ticketList : [];
        const refs = tickets.map((ticket) => {
          const name = ticket.passengerDTO?.passenger_name ?? ticket.passenger_name;
          for (const [ref, passenger] of passengerSecrets) if (passenger.passenger_name === name) return ref;
          return null;
        }).filter(Boolean);
        return { orderRef: `o_${createHash("sha256").update(String(rawRef)).digest("hex").slice(0, 16)}`, status: "PAYMENT_PENDING", passengerRefs: refs, paymentDeadline: order.lose_time ?? order.pay_limit_time ?? null };
      });
      return send(response, 200, { source: "12306_OFFICIAL", classification: "PAYMENT_PENDING", orders });
    }
    if (request.method === "POST" && request.url === "/orders/open") {
      if (!page || page.isClosed()) return send(response, 409, { error: "请先打开并登录 12306" });
      await page.goto("https://kyfw.12306.cn/otn/view/train_order.html", { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      return send(response, 200, { source: "12306_OFFICIAL", page: new URL(page.url()).pathname });
    }
    if (request.method === "GET" && request.url === "/observe/confirm-profile") {
      if (!page || page.isClosed() || !new URL(page.url()).pathname.includes("/confirmPassenger/initDc")) return send(response, 409, { error: "当前不在确认乘车人页面" });
      const profile = await page.evaluate(() => ({
        tokenPresent: typeof window.globalRepeatSubmitToken === "string" && window.globalRepeatSubmitToken.length > 10,
        ticketInfoKeys: window.ticketInfoForPassengerForm && typeof window.ticketInfoForPassengerForm === "object" ? Object.keys(window.ticketInfoForPassengerForm).sort() : [],
        seatMetadata: Object.fromEntries(Object.entries({
          ...(window.ticketInfoForPassengerForm?.queryLeftTicketRequestDTO ?? {}),
          ...(window.ticketInfoForPassengerForm?.queryLeftNewDetailDTO ?? {}),
          ...(window.ticketInfoForPassengerForm?.orderRequestDTO ?? {}),
        }).filter(([key, value]) => /seat/i.test(key) && ["string", "number", "boolean"].includes(typeof value)).map(([key, value]) => [key, String(value).slice(0, 80)])),
        inputNames: [...new Set(Array.from(document.querySelectorAll("input[name]")).map((element) => element.getAttribute("name")).filter(Boolean))].sort(),
        selectNames: [...new Set(Array.from(document.querySelectorAll("select[name]")).map((element) => element.getAttribute("name")).filter(Boolean))].sort(),
        seatOptions: [...new Set(Array.from(document.querySelectorAll('select[name="confirmTicketType"] option')).map((option) => option.textContent?.trim()).filter(Boolean))],
        actionIds: Array.from(document.querySelectorAll("button[id],a[id],input[type=button][id]")).map((element) => element.id).filter((id) => /submit|confirm|queue|passenger|ticket/i.test(id)).sort(),
      }));
      return send(response, 200, { source: "12306_OFFICIAL_OBSERVATION", ...profile });
    }
    if (request.method === "POST" && request.url === "/observe/order-ready") {
      if (!page || page.isClosed() || !new URL(page.url()).pathname.includes("/confirmPassenger/initDc")) return send(response, 409, { classification: "INCOMPATIBLE", error: "当前不在确认乘车人页面" });
      const input = await readJsonBody(request);
      if (!Array.isArray(input.passengerRefs) || !input.passengerRefs.length || typeof input.seatTypeLabel !== "string") return send(response, 400, { error: "订单就绪校验需要乘车人和席别" });
      if (!securityState || securityState.isSweepLogin !== "Y" || securityState.isUamLogin !== "Y") return send(response, 409, { classification: "USER_ACTION_REQUIRED", error: "当前会话需要重新完成 App 或 UAM 核验" });
      const tokenPresent = await page.evaluate(() => typeof window.globalRepeatSubmitToken === "string" && window.globalRepeatSubmitToken.length > 10);
      if (!tokenPresent) return send(response, 409, { classification: "INCOMPATIBLE", error: "确认页动态令牌缺失" });
      for (const passengerRef of input.passengerRefs) {
        const passenger = passengerSecrets.get(passengerRef);
        if (!passenger) return send(response, 409, { classification: "USER_ACTION_REQUIRED", error: "乘车人引用已失效，请重新同步" });
        try { await ensurePassengerSelected(page, passenger); }
        catch { return send(response, 409, { classification: "INCOMPATIBLE", error: "确认页未找到所选乘车人" }); }
      }
      const seatSelect = page.locator('select[id^="seatType_"]');
      const ticketTypeSelect = page.locator('select[name="confirmTicketType"]');
      if ((await seatSelect.count()) < input.passengerRefs.length || (await ticketTypeSelect.count()) < input.passengerRefs.length) return send(response, 409, { classification: "INCOMPATIBLE", error: "确认页席别或票种选择器数量与乘车人不一致" });
      const seatSupported = await seatSelect.first().locator("option").evaluateAll((options, expected) => options.some((option) => option.textContent?.trim().includes(expected)), seatOptionLabel(input.seatTypeLabel));
      if (!seatSupported) return send(response, 409, { classification: "INCOMPATIBLE", error: "确认页不支持所选席别" });
      for (let index = 0; index < input.passengerRefs.length; index += 1) {
        const passenger = passengerSecrets.get(input.passengerRefs[index]);
        const supported = await ticketTypeSelect.nth(index).locator("option").evaluateAll((options, expected) => options.some((option) => option.textContent?.trim().includes(expected)), ticketTypeLabel(passenger));
        if (!supported) return send(response, 409, { classification: "INCOMPATIBLE", error: "确认页不支持乘车人的票种" });
      }
      return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", compatible: true, tokenPresent: true, passengerCount: input.passengerRefs.length, seatSupported: true });
    }
    if (request.method === "POST" && request.url === "/order/execute") {
      if (!realSubmissionEnabled) return send(response, 423, { error: "真实提交环境门禁未启用" });
      if (orderExecutionInProgress || orderQueueState.status === "QUEUING") return send(response, 409, { classification: "ORDER_EXECUTION_BUSY", error: "已有订单正在提交或排队，账号级提交锁已拒绝并发执行" });
      if (!page || page.isClosed() || !new URL(page.url()).pathname.includes("/confirmPassenger/initDc")) return send(response, 409, { error: "当前不在确认乘车人页面" });
      const input = await readJsonBody(request);
      if (input.confirmRealSubmission !== true || !Array.isArray(input.passengerRefs) || !input.passengerRefs.length || typeof input.seatTypeLabel !== "string") return send(response, 400, { error: "真实提交需要明确确认、乘车人和席别" });
      if (!securityState || securityState.isSweepLogin !== "Y" || securityState.isUamLogin !== "Y") return send(response, 409, { classification: "USER_ACTION_REQUIRED", error: "当前会话需要重新完成 App 或 UAM 核验" });
      orderExecutionInProgress = true;
      updateQueueState({ status: "IDLE", orderRef: null, waitTime: null, confirmPath: null, queueAcceptedAt: null, queueAcceptedDurationMs: null, error: null });
      try {
        for (const passengerRef of input.passengerRefs) {
          const passenger = passengerSecrets.get(passengerRef);
          if (!passenger) return send(response, 409, { error: "乘车人引用已失效，请重新同步" });
          try { await ensurePassengerSelected(page, passenger); }
          catch { return send(response, 409, { error: "确认页未找到所选乘车人" }); }
      }
      const seatSelect = page.locator('select[id^="seatType_"]');
      const ticketTypeSelect = page.locator('select[name="confirmTicketType"]');
      const seatSelectCount = await seatSelect.count();
      if (seatSelectCount < input.passengerRefs.length || (await ticketTypeSelect.count()) < input.passengerRefs.length) return send(response, 409, { classification: "INCOMPATIBLE", error: "确认页席别或票种选择器数量与乘车人不一致" });
      const seatOption = await seatSelect.first().locator("option").evaluateAll((options, expected) => options.map((option) => ({ value: option.value, text: option.textContent?.trim() ?? "" })).find((option) => option.text.includes(expected)), seatOptionLabel(input.seatTypeLabel));
      if (!seatOption) return send(response, 409, { error: "确认页不支持所选席别" });
      for (let index = 0; index < input.passengerRefs.length; index += 1) {
        await seatSelect.nth(index).selectOption(seatOption.value);
        const passenger = passengerSecrets.get(input.passengerRefs[index]);
        const expectedTicketType = ticketTypeLabel(passenger);
        const ticketOption = await ticketTypeSelect.nth(index).locator("option").evaluateAll((options, expected) => options.map((option) => ({ value: option.value, text: option.textContent?.trim() ?? "" })).find((option) => option.text.includes(expected)), expectedTicketType);
        if (!ticketOption) return send(response, 409, { classification: "INCOMPATIBLE", error: "确认页不支持乘车人的票种" });
        await ticketTypeSelect.nth(index).selectOption(ticketOption.value);
      }
        const checkPromise = page.waitForResponse((candidate) => candidate.url().includes("/confirmPassenger/checkOrderInfo"), { timeout: 15000 }).catch(() => null);
        await page.locator("#submitOrder_id").click();
        const checkResponse = await checkPromise;
        const checkBody = checkResponse ? await checkResponse.json().catch(() => null) : null;
        const finalButton = page.locator("#qr_submit_id");
        if (checkBody && checkBody?.data?.submitStatus !== true) return send(response, 409, { classification: "ORDER_CHECK_REJECTED", error: "官方订单预检查未通过" });
        let finalVisible = await finalButton.isVisible().catch(() => false);
        if (!finalVisible) {
          const knownNotice = page.locator('.dhtmlx_window_active').filter({ hasText: "购买往返优惠票的旅客" }).filter({ hasText: "是否继续" });
          const noticeDeadline = Date.now() + 5000;
          let noticeVisible = false;
          while (Date.now() < noticeDeadline) {
            finalVisible = await finalButton.isVisible().catch(() => false);
            if (finalVisible) break;
            noticeVisible = await knownNotice.isVisible().catch(() => false);
            if (noticeVisible) break;
            await page.waitForTimeout(200);
          }
          if (!finalVisible && noticeVisible) {
            const noticeConfirm = knownNotice.locator('button,input[type="button"],a').filter({ hasText: "确认" }).last();
            if (!(await noticeConfirm.isVisible().catch(() => false))) return send(response, 409, { classification: "INCOMPATIBLE", error: "官方优惠票提示缺少可识别的确认按钮" });
            await noticeConfirm.click();
          }
          if (!finalVisible) {
            const appeared = await finalButton.waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);
            if (!appeared) {
              const activeDialog = await page.evaluate(() => {
                const candidates = Array.from(document.querySelectorAll('.dhtmlx_window_active,.up-box')).filter((element) => { const style = getComputedStyle(element); return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0; });
                return candidates.map((element) => ({ text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 220), buttons: Array.from(element.querySelectorAll('button,input[type="button"],a')).filter((button) => { const style = getComputedStyle(button); return style.display !== 'none' && style.visibility !== 'hidden' && button.getClientRects().length > 0; }).map((button) => `${button.id || '-'}:${(button.textContent || button.value || '').trim().replace(/\s+/g, ' ').slice(0, 40)}`).filter(Boolean).slice(0, 8) })).slice(0, 3);
              });
              return send(response, 409, { classification: "INCOMPATIBLE", error: `官方订单核对弹窗未出现：${JSON.stringify(activeDialog)}` });
            }
          }
          finalVisible = true;
        }
        if (!finalVisible) return send(response, 409, { classification: "INCOMPATIBLE", error: "官方订单核对弹窗未出现" });
        const enableDeadline = Date.now() + 2000;
        while (Date.now() < enableDeadline && !(await finalButton.isEnabled().catch(() => false))) await page.waitForTimeout(20);
        if (!(await finalButton.isEnabled().catch(() => false))) return send(response, 409, { classification: "ORDER_CONFIRM_NOT_READY", error: "官方确认按钮在 2 秒内未就绪" });
        // Confirmation and queueing are separate phases. First prove that the final click
        // actually produced the official confirmation request; only an accepted response
        // is allowed to enter the five-minute queue window.
        const confirmPromise = page.waitForResponse((candidate) => {
          const parsed = new URL(candidate.url());
          return candidate.request().method() === "POST"
            && parsed.pathname.startsWith("/otn/confirmPassenger/")
            && !/checkOrderInfo|getQueueCount|queryOrderWaitTime/i.test(parsed.pathname)
            && /confirm|queue/i.test(parsed.pathname);
        }, { timeout: ORDER_CONFIRM_REQUEST_TIMEOUT_MS }).catch(() => null);
        const finalClickStartedAt = Date.now();
        await finalButton.click();
        const confirmResponse = await confirmPromise;
        if (!confirmResponse) return send(response, 409, { classification: "ORDER_CONFIRM_NOT_SENT", error: "点击最终确认后 30 秒内未观察到 12306 排队请求，未进入排队阶段" });
        const confirmPath = new URL(confirmResponse.url()).pathname;
        const confirmBody = await confirmResponse.json().catch(() => null);
        if (confirmBody?.data?.submitStatus !== true) {
          const officialMessage = String(confirmBody?.data?.errMsg ?? confirmBody?.messages?.[0] ?? confirmBody?.validateMessages?.[0] ?? "").replace(/\s+/g, " ").slice(0, 160);
          return send(response, 409, { classification: "QUEUE_CONFIRM_REJECTED", error: officialMessage ? `12306 排队确认未通过：${officialMessage}` : "12306 排队确认未通过", confirmPath });
        }
        const accepted = updateQueueState({ status: "QUEUING", orderRef: null, waitTime: null, confirmPath, queueAcceptedAt: new Date().toISOString(), queueAcceptedDurationMs: Date.now() - finalClickStartedAt });
        void monitorOfficialQueue(confirmPath);
        return send(response, 200, { source: "12306_OFFICIAL", ...accepted });
      } finally {
        orderExecutionInProgress = false;
      }
    }
    return send(response, 404, { error: "未找到本地浏览器会话接口" });
  } catch (error) {
    await updateStatus("error", `浏览器会话操作失败：${error.message}`);
    return send(response, 500, { error: status.message });
  }
}).listen(port, host, () => console.log(`12306 browser session: http://${host}:${port}`));

await updateStatus("idle", "尚未打开 12306 官方登录页");
