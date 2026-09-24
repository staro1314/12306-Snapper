import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { ensurePassengerSelected, PASSENGER_RENDER_TIMEOUT_MS } from "./passenger-selection.mjs";
import { createOfficialClockSample, estimateOfficialNow } from "./official-clock.mjs";
import { isOfficialFinalConfirmReady, officialConfirmationMode } from "./official-final-confirm.mjs";
import { captureOfficialQueryProfile, reusableOfficialQueryUrl } from "./official-query-profile.mjs";

const host = "127.0.0.1";
const port = 3211;
const profileDir = path.resolve(".browser-session/profile");
const statusFile = path.resolve(".browser-session/status.json");
const loginUrl = "https://kyfw.12306.cn/otn/resources/login.html";
const ORDER_CONFIRM_REQUEST_TIMEOUT_MS = 30_000;
const ORDER_QUEUE_TIMEOUT_MS = 5 * 60_000;
const ORDER_QUEUE_RESPONSE_TIMEOUT_MS = 35_000;
// Real submission requires explicit per-task authorization and can be disabled process-wide.
// The complete real pending-order flow is not yet an acceptance claim for this build.
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
let officialQueryProfile = null;
let lastOfficialQueryStartedAt = 0;
let securityState = null;
let orderExecutionInProgress = false;
let orderContextReservedUntil = 0;
let orderQueueState = { status: "IDLE", orderRef: null, waitTime: null, confirmPath: null, queueAcceptedAt: null, queueAcceptedDurationMs: null, updatedAt: new Date().toISOString() };
let status = { state: "idle", message: "尚未打开 12306 官方登录页", updatedAt: new Date().toISOString() };

// Every automation endpoint uses the same persistent Playwright page. Serialize its reads and
// mutations so concurrent route queries cannot race the shared form, latestQuery, or order DOM.
let pageOperationTail = Promise.resolve();
async function acquirePageOperation() {
  const previous = pageOperationTail;
  let release;
  pageOperationTail = new Promise((resolve) => { release = resolve; });
  await previous;
  return release;
}

const pageOperationRoutes = new Set([
  "POST /start", "POST /logout", "GET /login/qr", "GET /stations", "POST /preflight",
  "GET /observe/account-links", "GET /observe/confirmation-handler", "POST /observe/passengers-page", "POST /observe/search-page",
  "POST /observe/query", "POST /observe/order-initialize", "GET /observe/order-endpoints",
  "POST /observe/orders-page", "POST /orders/reconcile", "POST /orders/open",
  "GET /observe/confirm-profile", "POST /observe/passenger-controls", "POST /observe/order-ready", "POST /order/execute",
]);

function isOrderContextReserved() {
  if (orderContextReservedUntil <= Date.now()) {
    orderContextReservedUntil = 0;
    return false;
  }
  return true;
}

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

async function updateStatus(state, message) {
  status = { state, message, updatedAt: new Date().toISOString() };
  await mkdir(path.dirname(statusFile), { recursive: true });
  await writeFile(statusFile, JSON.stringify(status, null, 2), "utf8");
}

async function inspectLoginState() {
  if (!page || page.isClosed()) return updateStatus("closed", "登录浏览器已关闭");
  try {
    const clockRequestStartedAt = performance.now();
    const result = await page.evaluate(async () => {
      const visibleLogout = Boolean(document.querySelector("#J-header-logout, .header-logout"));
      try {
        const response = await fetch("/otn/login/conf", { method: "POST", credentials: "include" });
        const body = await response.json();
        const value = body?.data?.loginCheck ?? body?.data?.is_login ?? body?.data?.flag;
        return { visibleLogout, value, qrResultCode: typeof window.popup_s === "undefined" ? null : String(window.popup_s), nowStr: body?.data?.nowStr ?? null, nowValue: body?.data?.now ?? null, security: { isSweepLogin: body?.data?.is_sweep_login ?? null, isUamLogin: body?.data?.is_uam_login ?? null, isLoginPassCode: body?.data?.is_login_passCode ?? null, isMessagePassCode: body?.data?.is_message_passCode ?? null, isPhoneCheck: body?.data?.is_phone_check ?? null } };
      } catch { return { visibleLogout, value: null, qrResultCode: typeof window.popup_s === "undefined" ? null : String(window.popup_s) }; }
    });
    const clockResponseReceivedAt = performance.now();
    const epochCandidate = Number(result.nowValue);
    officialClock = createOfficialClockSample(epochCandidate, clockRequestStartedAt, clockResponseReceivedAt);
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
          updatePassengerSnapshot(body.data.datas);
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

function updatePassengerSnapshot(passengers) {
  // Replace, do not merge, references from older logins or contact-list versions.
  passengerSecrets.clear();
  passengerSnapshot = passengers.map((item, index) => {
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
      // is_active is an observation, not proof the booking page will allow selection.
      officialActive: item.is_active === true || item.is_active === "Y" || item.is_active === "1" || item.is_active === 1,
      verified: true,
    };
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
  officialQueryProfile = null;
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
  latestQuery = null;
  officialQueryProfile = null;
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

// Telemetry is best-effort and never awaited on the booking hot path. Only fixed, redacted
// descriptions are sent; no token, cookie, raw official body, order number, or passenger data.
function emitOrderTrace(trace, stage, outcome, message, durationMs, observedAt = new Date().toISOString()) {
  if (!trace?.taskId || !trace?.routeGroupId) return;
  void fetch(`http://127.0.0.1:3210/api/tasks/${encodeURIComponent(trace.taskId)}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId: trace.taskId, routeGroupId: trace.routeGroupId, stage, outcome, message, durationMs, observedAt }),
    signal: AbortSignal.timeout(1500),
  }).catch(() => undefined);
}

async function findOfficialPendingOrder(passengerRefs, expectedOrderId = null) {
  const passengerNames = passengerRefs.map((ref) => passengerSecrets.get(ref)?.passenger_name).filter(Boolean);
  if (passengerNames.length !== passengerRefs.length) return null;
  const rawOrderRef = await page.evaluate(async ({ passengerNames, expectedOrderId }) => {
    try {
      const officialResponse = await fetch("/otn/queryOrder/queryMyOrderNoComplete", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
        body: "_json_att=",
      });
      const body = await officialResponse.json();
      if (body?.status !== true) return null;
      const orders = Array.isArray(body.data?.orderDBList) ? body.data.orderDBList : Array.isArray(body.data?.orders) ? body.data.orders : [];
      const matching = orders.filter((order) => {
        const orderId = String(order.sequence_no ?? order.order_id ?? order.orderId ?? "");
        if (!orderId || (expectedOrderId && orderId !== String(expectedOrderId))) return false;
        const tickets = Array.isArray(order.tickets) ? order.tickets : Array.isArray(order.ticketList) ? order.ticketList : [];
        const names = tickets.map((ticket) => ticket.passengerDTO?.passenger_name ?? ticket.passenger_name).filter(Boolean);
        return passengerNames.every((name) => names.includes(name));
      });
      return matching.length === 1 ? String(matching[0].sequence_no ?? matching[0].order_id ?? matching[0].orderId) : null;
    } catch { return null; }
  }, { passengerNames, expectedOrderId });
  return rawOrderRef ? `o_${createHash("sha256").update(rawOrderRef).digest("hex").slice(0, 16)}` : null;
}

async function monitorOfficialQueue(confirmPath, trace, passengerRefs) {
  const deadline = Date.now() + ORDER_QUEUE_TIMEOUT_MS;
  let lastWaitTime = null;
  let observedOrderId = null;
  let lastProgressAt = 0;
  try {
    while (Date.now() < deadline) {
      const nextWaitMs = lastWaitTime != null && lastWaitTime < 0 ? 15_000 : ORDER_QUEUE_RESPONSE_TIMEOUT_MS;
      const waitResponse = await page.waitForResponse((candidate) => candidate.url().includes("/confirmPassenger/queryOrderWaitTime"), { timeout: Math.min(nextWaitMs, deadline - Date.now()) }).catch(() => null);
      if (!waitResponse) {
        if (lastWaitTime != null && lastWaitTime < 0) {
          const pending = await findOfficialPendingOrder(passengerRefs, observedOrderId);
          if (pending) {
            emitOrderTrace(trace, "OFFICIAL_RECONCILIATION", "PAYMENT_PENDING", "排队等待指标为负后，官方未支付订单列表已核实本次订单");
            return updateQueueState({ status: "PAYMENT_PENDING", orderRef: pending, waitTime: lastWaitTime, confirmPath });
          }
        }
        emitOrderTrace(trace, "OFFICIAL_QUEUE", "WAITING", "本轮未观测到新的官方排队状态响应；仍在五分钟窗口内等待，不会重复提交");
        continue;
      }
      const waitBody = await waitResponse.json().catch(() => null);
      const orderId = waitBody?.data?.orderId;
      lastWaitTime = Number.isFinite(waitBody?.data?.waitTime) ? waitBody.data.waitTime : lastWaitTime;
      updateQueueState({ waitTime: lastWaitTime });
      if (orderId) {
        observedOrderId = String(orderId);
        emitOrderTrace(trace, "OFFICIAL_QUEUE", "ORDER_ID_RECEIVED", "官方排队响应返回订单标识；继续核对官方未支付订单列表");
        let lastVerificationLogAt = 0;
        while (Date.now() < deadline) {
          const orderRef = await findOfficialPendingOrder(passengerRefs, orderId);
          if (orderRef) {
            emitOrderTrace(trace, "OFFICIAL_RECONCILIATION", "PAYMENT_PENDING", "官方未支付订单列表已核实本次订单");
            return updateQueueState({ status: "PAYMENT_PENDING", orderRef, waitTime: lastWaitTime, confirmPath });
          }
          if (Date.now() - lastVerificationLogAt >= 30_000) {
            emitOrderTrace(trace, "OFFICIAL_RECONCILIATION", "WAITING", "排队已返回订单标识，但官方未支付订单列表尚未确认；继续等待，不会重复提交");
            lastVerificationLogAt = Date.now();
          }
          await page.waitForTimeout(Math.min(2000, deadline - Date.now()));
        }
        break;
      }
      if (Date.now() - lastProgressAt >= 5000) {
        emitOrderTrace(trace, "OFFICIAL_QUEUE", "WAITING", lastWaitTime == null ? "收到官方排队状态响应，尚未返回订单标识" : `收到官方排队状态响应：等待指标 ${lastWaitTime}，尚未返回订单标识`);
        lastProgressAt = Date.now();
      }
      // A negative waitTime is not proof of failure: 12306 may publish the
      // unpaid order after this response. Keep observing through the window.
    }
    emitOrderTrace(trace, "OFFICIAL_RECONCILIATION", "STARTED", "排队窗口结束或官方返回终止状态；开始只读核对未支付订单");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await page.waitForTimeout(2000);
      const pending = await findOfficialPendingOrder(passengerRefs, observedOrderId);
      if (pending) {
        emitOrderTrace(trace, "OFFICIAL_RECONCILIATION", "PAYMENT_PENDING", "官方未支付订单列表已核实本次乘车人的订单");
        return updateQueueState({ status: "PAYMENT_PENDING", orderRef: pending, waitTime: lastWaitTime, confirmPath });
      }
    }
    emitOrderTrace(trace, "OFFICIAL_RECONCILIATION", "UNKNOWN", "未在官方未支付订单查询中确认本次订单；停止后续提交");
    return updateQueueState({ status: "UNKNOWN", orderRef: null, waitTime: lastWaitTime, confirmPath });
  } catch (error) {
    emitOrderTrace(trace, "OFFICIAL_QUEUE", "UNKNOWN", "排队监控发生异常；结果保持未知并等待查单");
    return updateQueueState({ status: "UNKNOWN", orderRef: null, waitTime: lastWaitTime, confirmPath, error: String(error?.message ?? error).slice(0, 160) });
  }
}

http.createServer(async (request, response) => {
  let releasePageOperation;
  try {
    const hostHeader = String(request.headers.host ?? "").split(":")[0].replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(hostHeader)) return send(response, 403, { error: "仅允许本机访问浏览器会话服务" });
    const origin = request.headers.origin;
    if (origin) {
      let originHost = "";
      try { originHost = new URL(origin).hostname; } catch { return send(response, 403, { error: "请求来源无效" }); }
      if (!["127.0.0.1", "localhost", "::1"].includes(originHost)) return send(response, 403, { error: "拒绝非本机网页调用" });
    }
    const requestPath = new URL(request.url, "http://127.0.0.1").pathname;
    const routeKey = `${request.method} ${requestPath}`;
    const isOrderExecution = routeKey === "POST /order/execute";
    const isReservedContextObservation = routeKey === "POST /observe/passenger-controls" || routeKey === "POST /observe/order-ready";
    if (pageOperationRoutes.has(routeKey)) {
      releasePageOperation = await acquirePageOperation();
      const orderInProgress = orderExecutionInProgress || orderQueueState.status === "QUEUING";
      if ((orderInProgress || isOrderContextReserved()) && !isOrderExecution && !(isReservedContextObservation && !orderInProgress)) {
        return send(response, 409, {
          classification: "ORDER_EXECUTION_BUSY",
          error: orderInProgress
            ? "12306 订单正在提交或排队，已暂停其他浏览器操作以保护订单状态"
            : "12306 订单确认上下文已预留，已暂停其他浏览器操作以防提交错车次",
        });
      }
    }
    if (request.method === "GET" && request.url === "/status") return send(response, 200, status);
    if (request.method === "POST" && request.url === "/logout") return send(response, 200, await logoutBrowser());
    if (request.method === "GET" && request.url === "/capabilities") return send(response, 200, { queryEnabled: true, realSubmissionEnabled });
    if (request.method === "GET" && request.url === "/order/queue-status") return send(response, 200, { source: "12306_OFFICIAL", ...orderQueueState });
    if (request.method === "GET" && request.url === "/official-clock") return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", now: estimateOfficialNow(officialClock, performance.now()) });
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
      if (input.passengerRefs.some((ref) => !String(passengerSecrets.get(ref)?.passenger_name ?? "").trim())) return send(response, 409, { classification: "USER_ACTION_REQUIRED", error: "乘车人资料不完整，请重新同步" });
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
    if (request.method === "GET" && request.url === "/observe/confirmation-handler") {
      if (!page || page.isClosed()) return send(response, 409, { error: "请先打开并登录 12306" });
      const inspection = await page.evaluate(async () => {
        const scriptUrl = "https://kyfw.12306.cn/otn/resources/merged/passengerInfo_js.js";
        const officialResponse = await fetch(scriptUrl, { credentials: "include" });
        if (!officialResponse.ok) return { status: officialResponse.status, snippets: [] };
        const source = await officialResponse.text();
        const patterns = ["qr_submit_id", "confirmSingleForQueue", "getQueueCount", "var af=ae.data.isAsync"];
        return {
          status: officialResponse.status,
          snippets: patterns.flatMap((pattern) => {
            const index = source.indexOf(pattern);
            return index < 0 ? [] : [{ pattern, text: source.slice(Math.max(0, index - 450), Math.min(source.length, index + (pattern === "var af=ae.data.isAsync" ? 2400 : 900))) }];
          }),
        };
      });
      return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", ...inspection });
    }
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
      passengerSecrets.clear();
      passengerSnapshot = [];
      const passengerResponse = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/otn/passengers/query", { timeout: 15000 }).catch(() => null);
      await page.goto("https://kyfw.12306.cn/otn/view/passengers.html", { waitUntil: "domcontentloaded" });
      const officialResponse = await passengerResponse;
      if (!officialResponse) return send(response, 409, { classification: "INCOMPATIBLE", error: "本次未收到官方乘车人列表响应，不能使用旧同步结果" });
      const body = await officialResponse.json().catch(() => null);
      if (!officialResponse.ok() || !Array.isArray(body?.data?.datas)) return send(response, 409, { classification: "INCOMPATIBLE", error: "本次官方乘车人列表响应无法解析" });
      updatePassengerSnapshot(body.data.datas);
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
      // A failed new query must not leave an older train secret eligible for order init.
      latestQuery = null;
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
      const queryTrace = { taskId: input.taskId, routeGroupId: input.routeGroupId };
      const isOfficialQuery = (candidate) => /\/otn\/leftTicket\/query/.test(new URL(candidate.url()).pathname);
      const requestPromise = page.waitForRequest(isOfficialQuery, { timeout: 15000 })
        .then((request) => ({ request, observedAt: Date.now() })).catch(() => null);
      const responsePromise = page.waitForResponse(isOfficialQuery, { timeout: 15000 })
        .then((officialResponse) => ({ officialResponse, observedAt: Date.now() })).catch(() => null);
      const directQueryUrl = status.state === "logged_in" ? reusableOfficialQueryUrl(officialQueryProfile, input) : null;
      // A failed direct response must not leave the same profile eligible for blind reuse.
      if (directQueryUrl) officialQueryProfile = null;
      const queryClickStartedAt = Date.now();
      lastOfficialQueryStartedAt = queryClickStartedAt;
      emitOrderTrace(queryTrace, "OFFICIAL_QUERY", "STARTED", directQueryUrl ? "正在通过已验证的当前会话请求官方余票" : "正在点击官方查询按钮；等待实际余票请求发出");
      // A direct query is permitted only for the exact route/date request observed from this
      // official page in this browser session. All other queries use the official button.
      if (directQueryUrl) {
        await page.evaluate(async (url) => {
          await fetch(url, { method: "GET", credentials: "include", cache: "no-store", headers: { "X-Requested-With": "XMLHttpRequest" } });
        }, directQueryUrl);
      } else {
        // Observers are armed before clicking; do not await unrelated navigation.
        await page.locator("#query_ticket").click({ noWaitAfter: true });
      }
      const queryClickAwaitMs = Date.now() - queryClickStartedAt;
      const queryRequest = await requestPromise;
      if (queryRequest) {
        lastOfficialQueryStartedAt = queryRequest.observedAt;
        emitOrderTrace(queryTrace, "OFFICIAL_QUERY", "REQUEST_SENT", "已观察到官方余票查询请求", queryRequest.observedAt - queryClickStartedAt, new Date(queryRequest.observedAt).toISOString());
      }
      const observedQueryResponse = await responsePromise;
      const apiResponse = observedQueryResponse?.officialResponse ?? null;
      if (!apiResponse) {
        emitOrderTrace(queryTrace, "OFFICIAL_QUERY", "UNKNOWN", "15 秒内未观测到 12306 余票接口响应，本轮停止解析", Date.now() - lastOfficialQueryStartedAt);
        return send(response, 409, { classification: "QUERY_RESPONSE_UNKNOWN", error: "官方余票接口响应未被观测到，本轮已停止" });
      }
      if (apiResponse.status() >= 300 && apiResponse.status() < 400) {
        emitOrderTrace(queryTrace, "OFFICIAL_QUERY", "FAILED", `12306 余票接口返回 HTTP ${apiResponse.status()} 跳转，未解析余票`, Date.now() - lastOfficialQueryStartedAt);
        let redirectPath = "UNAVAILABLE";
        try { redirectPath = new URL(apiResponse.headers().location, apiResponse.url()).pathname; } catch { /* Return a safe classification without the raw Location value. */ }
        return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", path: new URL(apiResponse.url()).pathname, status: apiResponse.status(), compatible: false, classification: "QUERY_REDIRECTED", redirectPath });
      }
      if (!(apiResponse.headers()["content-type"] ?? "").includes("json")) {
        emitOrderTrace(queryTrace, "OFFICIAL_QUERY", "FAILED", `12306 余票接口返回 HTTP ${apiResponse.status()}，响应不是 JSON`, Date.now() - lastOfficialQueryStartedAt);
        return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", path: new URL(apiResponse.url()).pathname, status: apiResponse.status(), compatible: false, classification: "UNEXPECTED_CONTENT_TYPE" });
      }
      const body = await apiResponse.json();
      const rows = Array.isArray(body?.data?.result) ? body.data.result : [];
      if (body?.status !== true) {
        const safeText = JSON.stringify(body?.messages ?? body?.validateMessagesShowId ?? "");
        const classification = /频繁|稍后|busy|rate/i.test(safeText) ? "RATE_LIMITED" : /登录|验证|login|uam/i.test(safeText) ? "USER_ACTION_REQUIRED" : "INCOMPATIBLE";
        emitOrderTrace(queryTrace, "OFFICIAL_QUERY", classification, `12306 余票接口返回 HTTP ${apiResponse.status()}，未接受本轮查询`, Date.now() - lastOfficialQueryStartedAt);
        return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", path: new URL(apiResponse.url()).pathname, status: apiResponse.status(), success: false, compatible: false, classification });
      }
      emitOrderTrace(queryTrace, "OFFICIAL_QUERY", "PASSED", `12306 余票接口返回 HTTP ${apiResponse.status()}，解析到 ${rows.length} 个车次`, Date.now() - lastOfficialQueryStartedAt);
      officialQueryProfile = captureOfficialQueryProfile(queryRequest?.request, input, stationCodes);
      latestQuery = { queryId: randomUUID(), input, candidates: rows.map(parseTicketCandidate) };
      const result = { path: new URL(apiResponse.url()).pathname, status: apiResponse.status(), queryMode: directQueryUrl ? "OBSERVED_DIRECT_REQUEST" : "OFFICIAL_PAGE_CLICK", responseKeys: Object.keys(body).sort(), dataKeys: body?.data && typeof body.data === "object" ? Object.keys(body.data).sort() : [], resultCount: rows.length, stationMapCount: body?.data?.map && typeof body.data.map === "object" ? Object.keys(body.data.map).length : null, queryId: latestQuery.queryId, success: body?.status === true, queryClickAwaitMs, queryRequestDelayMs: queryRequest ? queryRequest.observedAt - queryClickStartedAt : null, queryResponseRttMs: queryRequest ? observedQueryResponse.observedAt - queryRequest.observedAt : null, candidates: latestQuery.candidates.map(publicTicketCandidate) };
      return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", ...result });
    }
    if (request.method === "POST" && request.url === "/observe/order-initialize") {
      if (!page || page.isClosed() || !latestQuery) return send(response, 409, { error: "请先完成一次余票查询" });
      const input = await readJsonBody(request);
      if (input.confirmObservation !== true || typeof input.trainCode !== "string" || typeof input.queryId !== "string") return send(response, 400, { error: "订单初始化参数缺少当前查询凭据" });
      if (input.queryId !== latestQuery.queryId) return send(response, 409, { classification: "STALE_QUERY_CONTEXT", error: "查询结果已被更新，已阻止使用旧余票信息提交" });
      const train = latestQuery.candidates.find((candidate) => candidate.trainCode === input.trainCode && candidate.canBook);
      if (!train) return send(response, 409, { error: "最近查询中没有该可预订车次" });
      const initializationTrace = { taskId: input.taskId, routeGroupId: input.routeGroupId };
      observations.length = 0;
      // Do not click the rendered train row. That path waits for table event handlers and a
      // browser redirect. Submit the exact secret from the immediately preceding official query,
      // then load the official confirmation page only after 12306 accepts initialization.
      const initializationStartedAt = Date.now();
      emitOrderTrace(initializationTrace, "OFFICIAL_INIT", "STARTED", `正在向 12306 初始化 ${input.trainCode} 的订单；尚未生成订单`);
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
      if (!initialization.accepted) {
        emitOrderTrace(initializationTrace, "OFFICIAL_INIT", "FAILED", `12306 订单初始化返回 HTTP ${initialization.status}，未接受`, Date.now() - initializationStartedAt);
        return send(response, 409, { classification: "ORDER_INITIALIZATION_REJECTED", error: initialization.message ? `12306 订单初始化未通过：${initialization.message}` : "12306 订单初始化未通过" });
      }
      emitOrderTrace(initializationTrace, "OFFICIAL_INIT", "PASSED", `12306 订单初始化返回 HTTP ${initialization.status} 并接受；正在进入官方确认页`, Date.now() - initializationStartedAt);
      // The official initialization consumed this query's train secret; do not retain or replay it.
      latestQuery = null;
      await page.goto("https://kyfw.12306.cn/otn/confirmPassenger/initDc", { waitUntil: "domcontentloaded", timeout: 15000 });
      const currentPath = new URL(page.url()).pathname;
      if (currentPath !== "/otn/confirmPassenger/initDc") return send(response, 409, { classification: "INCOMPATIBLE", error: "订单初始化后未进入官方确认页面" });
      // Reserve the exact confirmation context until `/order/execute` consumes it. The lease
      // bounds recovery if the Rust caller exits between the two requests.
      orderContextReservedUntil = Date.now() + 60_000;
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
    if (request.method === "POST" && request.url === "/observe/passenger-controls") {
      if (!page || page.isClosed() || !new URL(page.url()).pathname.includes("/confirmPassenger/initDc")) return send(response, 409, { classification: "INCOMPATIBLE", error: "当前不在确认乘车人页面" });
      const input = await readJsonBody(request);
      const passenger = passengerSecrets.get(input.passengerRef);
      if (!passenger) return send(response, 409, { classification: "PASSENGER_REFERENCE_INVALID", error: "乘车人引用已失效" });
      const structure = await page.evaluate((passengerName) => {
        const visible = (element) => Boolean(element.getClientRects().length);
        const containsName = (element) => (element?.textContent ?? "").replace(/\s+/g, "").includes(passengerName.replace(/\s+/g, ""));
        const labels = [...document.querySelectorAll("label")].filter(visible);
        const matchingLabels = labels.filter(containsName);
        const allCheckboxes = [...document.querySelectorAll('input[type="checkbox"]')];
        const checkboxes = allCheckboxes.filter(visible);
        const nameContexts = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let textNode;
        while ((textNode = walker.nextNode()) && nameContexts.length < 8) {
          const parent = textNode.parentElement;
          if (!parent || parent.closest("script,style") || !containsName(textNode)) continue;
          const ancestors = [];
          for (let element = parent; element && ancestors.length < 6; element = element.parentElement) {
            ancestors.push({ tag: element.tagName, classes: String(element.className ?? "").slice(0, 80), idPattern: String(element.id ?? "").replace(/\d/g, "#").slice(0, 80), checkboxCount: element.querySelectorAll('input[type="checkbox"]').length, radioCount: element.querySelectorAll('input[type="radio"]').length, role: element.getAttribute("role") });
          }
          nameContexts.push(ancestors);
        }
        return {
          bodyContainsName: containsName(document.body),
          visibleLabelCount: labels.length,
          matchingLabelCount: matchingLabels.length,
          matchingLabelWithCheckboxCount: matchingLabels.filter((label) => label.querySelector('input[type="checkbox"]') || (label.htmlFor && document.getElementById(label.htmlFor)?.matches('input[type="checkbox"]'))).length,
          allCheckboxCount: allCheckboxes.length,
          allRadioCount: document.querySelectorAll('input[type="radio"]').length,
          visibleCheckboxCount: checkboxes.length,
          nameContexts,
          checkboxContexts: checkboxes.slice(0, 20).map((checkbox) => ({
            checked: checkbox.checked,
            labelContainsName: containsName(checkbox.closest("label")),
            parentContainsName: containsName(checkbox.parentElement),
            grandparentContainsName: containsName(checkbox.parentElement?.parentElement),
            parentTag: checkbox.parentElement?.tagName ?? null,
            grandparentTag: checkbox.parentElement?.parentElement?.tagName ?? null,
            parentClasses: String(checkbox.parentElement?.className ?? "").slice(0, 80),
          })),
        };
      }, String(passenger.passenger_name ?? ""));
      return send(response, 200, { source: "12306_OFFICIAL_READ_ONLY", structure });
    }
    if (request.method === "POST" && request.url === "/observe/order-ready") {
      if (!page || page.isClosed() || !new URL(page.url()).pathname.includes("/confirmPassenger/initDc")) return send(response, 409, { classification: "INCOMPATIBLE", error: "当前不在确认乘车人页面" });
      const input = await readJsonBody(request);
      if (!Array.isArray(input.passengerRefs) || !input.passengerRefs.length || typeof input.seatTypeLabel !== "string") return send(response, 400, { error: "订单就绪校验需要乘车人和席别" });
      if (!securityState || securityState.isSweepLogin !== "Y" || securityState.isUamLogin !== "Y") return send(response, 409, { classification: "USER_ACTION_REQUIRED", submissionAttempted: false, error: "当前会话需要重新完成 App 或 UAM 核验" });
      try {
        await page.waitForFunction(() => typeof window.globalRepeatSubmitToken === "string" && window.globalRepeatSubmitToken.length > 10, null, { timeout: PASSENGER_RENDER_TIMEOUT_MS });
      } catch {
        return send(response, 409, { classification: "INCOMPATIBLE", error: "确认页动态令牌未就绪，已停止提交" });
      }
      for (const passengerRef of input.passengerRefs) {
        const passenger = passengerSecrets.get(passengerRef);
        if (!passenger) return send(response, 409, { classification: "USER_ACTION_REQUIRED", error: "乘车人引用已失效，请重新同步" });
        try { await ensurePassengerSelected(page, passenger); }
        catch (error) { return send(response, 409, { classification: error.classification ?? "INCOMPATIBLE", error: error.message }); }
      }
      const seatSelect = page.locator('select[id^="seatType_"]');
      const ticketTypeSelect = page.locator('select[name="confirmTicketType"]');
      try {
        await seatSelect.first().waitFor({ state: "attached", timeout: PASSENGER_RENDER_TIMEOUT_MS });
        await ticketTypeSelect.first().waitFor({ state: "attached", timeout: PASSENGER_RENDER_TIMEOUT_MS });
      } catch {
        return send(response, 409, { classification: "INCOMPATIBLE", error: "确认页席别或票种选择器未就绪，已停止提交" });
      }
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
      if (!realSubmissionEnabled) return send(response, 423, { submissionAttempted: false, error: "真实提交环境门禁未启用" });
      if (orderExecutionInProgress || orderQueueState.status === "QUEUING") return send(response, 409, { classification: "ORDER_EXECUTION_BUSY", submissionAttempted: false, error: "已有订单正在提交或排队，账号级提交锁已拒绝并发执行" });
      if (!isOrderContextReserved()) return send(response, 409, { classification: "STALE_QUERY_CONTEXT", submissionAttempted: false, error: "订单确认上下文未预留或已过期，已停止提交" });
      if (!page || page.isClosed() || !new URL(page.url()).pathname.includes("/confirmPassenger/initDc")) return send(response, 409, { classification: "INCOMPATIBLE", submissionAttempted: false, error: "当前不在确认乘车人页面" });
      const input = await readJsonBody(request);
      if (input.confirmRealSubmission !== true || !Array.isArray(input.passengerRefs) || !input.passengerRefs.length || typeof input.seatTypeLabel !== "string") return send(response, 400, { submissionAttempted: false, error: "真实提交需要明确确认、乘车人和席别" });
      if (!securityState || securityState.isSweepLogin !== "Y" || securityState.isUamLogin !== "Y") return send(response, 409, { classification: "USER_ACTION_REQUIRED", submissionAttempted: false, error: "当前会话需要重新完成 App 或 UAM 核验" });
      const trace = { taskId: input.taskId, routeGroupId: input.routeGroupId };
      orderExecutionInProgress = true;
      updateQueueState({ status: "IDLE", orderRef: null, waitTime: null, confirmPath: null, queueAcceptedAt: null, queueAcceptedDurationMs: null, error: null });
      let submissionAttempted = false;
      try {
        emitOrderTrace(trace, "OFFICIAL_FORM", "STARTED", `官方确认页开始校验 ${input.passengerRefs.length} 名乘车人与 ${input.seatTypeLabel}；尚未提交订单`);
        for (const passengerRef of input.passengerRefs) {
          const passenger = passengerSecrets.get(passengerRef);
          if (!passenger) return send(response, 409, { classification: "PASSENGER_REFERENCE_INVALID", submissionAttempted: false, error: "乘车人引用已失效，请重新同步" });
          try { await ensurePassengerSelected(page, passenger); }
          catch (error) {
            emitOrderTrace(trace, "OFFICIAL_FORM", error.classification ?? "INCOMPATIBLE", error.message);
            return send(response, 409, { classification: error.classification ?? "INCOMPATIBLE", submissionAttempted: false, error: error.message });
          }
      }
      const seatSelect = page.locator('select[id^="seatType_"]');
      const ticketTypeSelect = page.locator('select[name="confirmTicketType"]');
      try {
        await seatSelect.first().waitFor({ state: "attached", timeout: PASSENGER_RENDER_TIMEOUT_MS });
        await ticketTypeSelect.first().waitFor({ state: "attached", timeout: PASSENGER_RENDER_TIMEOUT_MS });
      } catch {
        return send(response, 409, { classification: "INCOMPATIBLE", submissionAttempted: false, error: "确认页席别或票种选择器未就绪，已停止提交" });
      }
      const seatSelectCount = await seatSelect.count();
      if (seatSelectCount < input.passengerRefs.length || (await ticketTypeSelect.count()) < input.passengerRefs.length) return send(response, 409, { classification: "INCOMPATIBLE", submissionAttempted: false, error: "确认页席别或票种选择器数量与乘车人不一致" });
      const seatOption = await seatSelect.first().locator("option").evaluateAll((options, expected) => options.map((option) => ({ value: option.value, text: option.textContent?.trim() ?? "" })).find((option) => option.text.includes(expected)), seatOptionLabel(input.seatTypeLabel));
      if (!seatOption) return send(response, 409, { classification: "INCOMPATIBLE", submissionAttempted: false, error: "确认页不支持所选席别" });
      for (let index = 0; index < input.passengerRefs.length; index += 1) {
        await seatSelect.nth(index).selectOption(seatOption.value);
        const passenger = passengerSecrets.get(input.passengerRefs[index]);
        const expectedTicketType = ticketTypeLabel(passenger);
        const ticketOption = await ticketTypeSelect.nth(index).locator("option").evaluateAll((options, expected) => options.map((option) => ({ value: option.value, text: option.textContent?.trim() ?? "" })).find((option) => option.text.includes(expected)), expectedTicketType);
        if (!ticketOption) return send(response, 409, { classification: "INCOMPATIBLE", submissionAttempted: false, error: "确认页不支持乘车人的票种" });
        await ticketTypeSelect.nth(index).selectOption(ticketOption.value);
      }
        emitOrderTrace(trace, "OFFICIAL_FORM", "PASSED", "乘车人、席别和票种已在官方确认页选定；准备触发官方订单预检查");
        const checkStartedAt = Date.now();
        const checkPromise = page.waitForResponse((candidate) => candidate.url().includes("/confirmPassenger/checkOrderInfo"), { timeout: 15000 }).catch(() => null);
        emitOrderTrace(trace, "OFFICIAL_CHECK", "STARTED", "正在点击官方提交入口并等待 checkOrderInfo 响应；此时尚未进入排队");
        await page.locator("#submitOrder_id").click();
        const checkResponse = await checkPromise;
        const checkBody = checkResponse ? await checkResponse.json().catch(() => null) : null;
        const finalButton = page.locator("#qr_submit_id");
        if (!checkBody) {
          emitOrderTrace(trace, "OFFICIAL_CHECK", "UNKNOWN", "未确认收到官方订单预检查响应，已停止最终确认", Date.now() - checkStartedAt);
          return send(response, 409, { classification: "ORDER_CHECK_UNKNOWN", submissionAttempted: false, error: "官方订单预检查结果未知，未点击最终确认" });
        }
        if (checkBody?.data?.submitStatus !== true) {
          emitOrderTrace(trace, "OFFICIAL_CHECK", "FAILED", "官方订单预检查未通过，未点击最终确认", Date.now() - checkStartedAt);
          return send(response, 409, { classification: "ORDER_CHECK_REJECTED", submissionAttempted: false, error: "官方订单预检查未通过" });
        }
        emitOrderTrace(trace, "OFFICIAL_CHECK", "PASSED", "官方 checkOrderInfo 响应表示预检查通过；等待最终确认控件", Date.now() - checkStartedAt);
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
            if (!(await noticeConfirm.isVisible().catch(() => false))) return send(response, 409, { classification: "INCOMPATIBLE", submissionAttempted: false, error: "官方优惠票提示缺少可识别的确认按钮" });
            await noticeConfirm.click();
          }
          if (!finalVisible) {
            const appeared = await finalButton.waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);
            if (!appeared) {
              const activeDialog = await page.evaluate(() => {
                const candidates = Array.from(document.querySelectorAll('.dhtmlx_window_active,.up-box')).filter((element) => { const style = getComputedStyle(element); return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0; });
                return candidates.map((element) => ({ text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 220), buttons: Array.from(element.querySelectorAll('button,input[type="button"],a')).filter((button) => { const style = getComputedStyle(button); return style.display !== 'none' && style.visibility !== 'hidden' && button.getClientRects().length > 0; }).map((button) => `${button.id || '-'}:${(button.textContent || button.value || '').trim().replace(/\s+/g, ' ').slice(0, 40)}`).filter(Boolean).slice(0, 8) })).slice(0, 3);
              });
              return send(response, 409, { classification: "INCOMPATIBLE", submissionAttempted: false, error: `官方订单核对弹窗未出现：${JSON.stringify(activeDialog)}` });
            }
          }
          finalVisible = true;
        }
        if (!finalVisible) return send(response, 409, { classification: "INCOMPATIBLE", submissionAttempted: false, error: "官方订单核对弹窗未出现" });
        // The current official page leaves this button DOM-enabled during its countdown.
        // Its own script binds qr_submitClickEvent only when it changes btn92 to btn92s.
        // Clicking earlier is a no-op, as the observed 19:30 attempt demonstrated.
        const confirmReadyStartedAt = Date.now();
        const confirmReady = await page.waitForFunction(isOfficialFinalConfirmReady, null, { timeout: 15_000 }).then(() => true).catch(() => false);
        if (!confirmReady) {
          emitOrderTrace(trace, "OFFICIAL_CONFIRM", "NOT_READY", "官方最终确认按钮的点击处理尚未绑定，已停止且未点击最终确认", Date.now() - confirmReadyStartedAt);
          return send(response, 409, { classification: "ORDER_CONFIRM_NOT_READY", submissionAttempted: false, error: "官方最终确认按钮尚未完成倒计时或绑定点击处理，未提交订单" });
        }
        const isFinalSubmission = (candidate) => {
          const parsed = new URL(candidate.url());
          return candidate.method() === "POST"
            && /^\/otn\/confirmPassenger\/confirm(?:Single|Go|Back|Resign)ForQueue$/.test(parsed.pathname);
        };
        // Observe the request, not merely its response. A missing response can mean the
        // request was sent and must be reconciled; a missing request is a different failure.
        const requestPromise = page.waitForRequest(isFinalSubmission, { timeout: 5000 })
          .then((request) => ({ request, observedAt: Date.now() })).catch(() => null);
        const responsePromise = page.waitForResponse((candidate) => isFinalSubmission(candidate.request()), { timeout: ORDER_CONFIRM_REQUEST_TIMEOUT_MS })
          .then((officialResponse) => ({ officialResponse, observedAt: Date.now() })).catch(() => null);
        const finalClickStartedAt = Date.now();
        emitOrderTrace(trace, "OFFICIAL_CONFIRM", "STARTED", "官方最终确认按钮已绑定，正在点击并观察最终提交请求；尚未证明已生成订单");
        submissionAttempted = true;
        await finalButton.click({ noWaitAfter: true });
        const confirmRequest = await requestPromise;
        if (!confirmRequest) {
          emitOrderTrace(trace, "OFFICIAL_CONFIRM", "REQUEST_NOT_OBSERVED", "点击最终确认后未观察到已知提交请求；必须核对官方订单，不能盲目重提", Date.now() - finalClickStartedAt);
          return send(response, 409, { classification: "ORDER_CONFIRM_NOT_OBSERVED", submissionAttempted: true, error: "点击最终确认后未观察到已知提交请求；已停止重提并核对官方订单" });
        }
        emitOrderTrace(trace, "OFFICIAL_CONFIRM", "REQUEST_SENT", "已观察到 12306 最终提交请求，等待官方响应；尚未证明生成订单", confirmRequest.observedAt - finalClickStartedAt, new Date(confirmRequest.observedAt).toISOString());
        const observedConfirmResponse = await responsePromise;
        const confirmResponse = observedConfirmResponse?.officialResponse ?? null;
        if (!confirmResponse) {
          emitOrderTrace(trace, "OFFICIAL_CONFIRM", "UNKNOWN", "最终提交请求已发出但未收到官方响应，必须先核对订单", Date.now() - finalClickStartedAt);
          return send(response, 409, { classification: "ORDER_CONFIRM_RESPONSE_UNKNOWN", submissionAttempted: true, error: "最终提交请求已发出，但官方响应未知；已停止重提并核对订单" });
        }
        const confirmPath = new URL(confirmResponse.url()).pathname;
        const confirmDurationMs = observedConfirmResponse.observedAt - finalClickStartedAt;
        const confirmBody = await confirmResponse.json().catch(() => null);
        const confirmationMode = officialConfirmationMode(confirmBody);
        if (confirmationMode === "REJECTED") {
          emitOrderTrace(trace, "OFFICIAL_CONFIRM", "FAILED", "已收到官方最终确认响应，但未被接受进入排队", confirmDurationMs);
          const officialMessage = String(confirmBody?.data?.errMsg ?? confirmBody?.messages?.[0] ?? confirmBody?.validateMessages?.[0] ?? "").replace(/\s+/g, " ").slice(0, 160);
          return send(response, 409, { classification: "QUEUE_CONFIRM_REJECTED", error: officialMessage ? `12306 排队确认未通过：${officialMessage}` : "12306 排队确认未通过", confirmPath });
        }
        if (confirmationMode === "DIRECT") {
          emitOrderTrace(trace, "OFFICIAL_CONFIRM", "DIRECT_ACCEPTED", "官方最终确认已接受并进入直接处理分支；正在核对真实待支付订单", confirmDurationMs);
          return send(response, 200, { source: "12306_OFFICIAL", status: "DIRECT_ACCEPTED", confirmPath, queueAcceptedDurationMs: confirmDurationMs });
        }
        emitOrderTrace(trace, "OFFICIAL_CONFIRM", "QUEUING", "官方最终确认已接受异步排队；开始等待排队结果", confirmDurationMs);
        const accepted = updateQueueState({ status: "QUEUING", orderRef: null, waitTime: null, confirmPath, queueAcceptedAt: new Date(observedConfirmResponse.observedAt).toISOString(), queueAcceptedDurationMs: confirmDurationMs });
        void monitorOfficialQueue(confirmPath, trace, input.passengerRefs);
        return send(response, 200, { source: "12306_OFFICIAL", ...accepted });
      } catch (error) {
        const classification = submissionAttempted ? "UNKNOWN_RECONCILING" : "INCOMPATIBLE";
        emitOrderTrace(trace, "OFFICIAL_FORM", classification, submissionAttempted ? "最终确认已点击但后续操作异常，必须核对订单" : "确认页操作异常，尚未点击最终确认");
        return send(response, 409, { classification, submissionAttempted, error: submissionAttempted ? "最终确认后操作异常，正在核对订单" : "确认页操作未完成，未点击最终确认" });
      } finally {
        orderExecutionInProgress = false;
        orderContextReservedUntil = 0;
      }
    }
    return send(response, 404, { error: "未找到本地浏览器会话接口" });
  } catch (error) {
    await updateStatus("error", `浏览器会话操作失败：${error.message}`);
    return send(response, 500, { error: status.message });
  } finally {
    releasePageOperation?.();
  }
}).listen(port, host, () => console.log(`12306 browser session: http://${host}:${port}`));

await updateStatus("idle", "尚未打开 12306 官方登录页");
