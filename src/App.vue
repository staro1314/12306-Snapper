<script setup lang="ts">
import DatePicker from "./DatePicker.vue";
import StationPicker from "./StationPicker.vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { abandonTask, armTask, createTask, deleteTask, getBrowserCapabilities, getBrowserLoginQr, getBrowserSession, getOfficialClock, getOfficialSaleTime, getOfficialStations, getProtocolStatus, getRuntimeStatus, getTask, haltTask, listEvents, listOrderSnapshots, listTasks, logoutBrowserSession, openOfficialOrders, queryOfficialTickets, reconcileOfficialOrders, recordOrderResult, recordRuntimeEvent, runOfficialPreflight, runPreflight, runRehearsal, startBrowserSession, syncPassengers, updateTask } from "./api";
import type { BrowserCapabilities, BrowserSessionStatus, CreateTaskInput, ExecutionEvent, OfficialPassenger, OrderSnapshot, ProtocolStatus, RehearsalScenario, TicketQueryCandidate, TicketTaskDetail, TicketTaskView } from "./contracts";

type View = "overview" | "login" | "tasks" | "create" | "orders" | "rehearsal" | "system";
const protocol = ref<ProtocolStatus | null>(null);
const browserSession = ref<BrowserSessionStatus | null>(null);
const tasks = ref<TicketTaskView[]>([]);
const orders = ref<OrderSnapshot[]>([]);
const activeView = ref<View>("overview");
const loginReturnView = ref<Exclude<View, "login"> | null>(null);
const loginReturnLabel = ref("");
const loginModalOpen = ref(false);
const loginQrDataUrl = ref("");
const loginQrLoading = ref(false);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const selectedTaskId = ref("");
const scenario = ref<RehearsalScenario>("seats_available");
const events = ref<ExecutionEvent[]>([]);
const taskEvents = ref<Record<string, ExecutionEvent[]>>({});
const expandedTaskLogs = reactive<Record<string, boolean>>({});
const taskLogsSyncing = ref(false);
const taskLogClock = ref(Date.now());
const rehearsalOutcome = ref("");
const editingTaskId = ref("");
const editingTask = ref<TicketTaskDetail | null>(null);
const officialPassengers = ref<OfficialPassenger[]>([]);
const passengerSyncing = ref(false);
const passengerSyncMessage = ref("");
const queryTaskId = ref("");
const queryCandidates = ref<TicketQueryCandidate[]>([]);
const queryMessage = ref("");
const reconciliationMessage = ref("");
const saleTimeLookupMessage = ref("");
const formQueryCandidates = ref<TicketQueryCandidate[]>([]);
const formQueryMessage = ref("");
const officialStations = ref<string[]>([]);
const stationsLoading = ref(false);
const stationsError = ref("");
const routeQueryCandidates = reactive<Record<string, TicketQueryCandidate[]>>({});
const schedulerMessage = ref("调度器待命");
const schedulerHeartbeatAt = ref<number | null>(null);
const browserCapabilities = ref<BrowserCapabilities | null>(null);
const notificationSelfTestPassed = ref(localStorage.getItem("fast12306.notificationSelfTest") === "passed");
let loginPollTimer: number | undefined;
let taskLogTimer: number | undefined;
let lastClockSyncAt = 0;
const officialClockOffsetMs = ref<number | null>(null);
let alertSoundTimer: number | undefined;
let alertTitleTimer: number | undefined;
const paymentAlert = ref<{ trainCode: string; partial: boolean; confirmedAt: string; test?: boolean } | null>(null);
const form = reactive({ name: "", priority: 1, travelDate: "", fromStation: "", toStation: "", saleTime: "", deadline: "", trainCodes: "", seatTypes: "二等座", passengerRef: "", passengerName: "", splitAuthorized: false, realSubmissionAuthorized: false });
type RouteDraft = { id: string; travelDate: string; fromStation: string; toStation: string; saleTime: string; priority: number; trainCodes: string; seatTypes: string };
const selectedPassengerRefs = ref<string[]>([]);
const additionalRoutes = ref<RouteDraft[]>([]);
const seatOptions = ["商务座", "特等座", "一等座", "二等座", "软卧", "硬卧", "软座", "硬座", "无座"];
const todayDate = (() => { const now = new Date(); const pad = (value: number) => String(value).padStart(2, "0"); return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; })();
const stationOptions = computed(() => [...new Set([...officialStations.value, form.fromStation, form.toStation, ...additionalRoutes.value.flatMap((route) => [route.fromStation, route.toStation])].filter(Boolean))]);
watch(() => browserSession.value?.state, (state) => {
  if (state === "logged_in") {
    loginModalOpen.value = false;
    loginQrDataUrl.value = "";
  }
});
const loginHeading = computed(() => {
  if (browserSession.value?.state === "logged_in") return "登录成功";
  if (browserSession.value?.state === "starting" && /App 已确认/.test(browserSession.value?.message ?? "")) return "正在完成登录";
  if (/已扫描/.test(browserSession.value?.message ?? "")) return "请在 App 确认";
  if (/失效/.test(browserSession.value?.message ?? "")) return "二维码已失效";
  if (browserSession.value?.state === "awaiting_login") return "等待扫码";
  return "登录 12306";
});
function rememberLoginReturn(view: Exclude<View, "login">, label: string) {
  loginReturnView.value = view;
  loginReturnLabel.value = label;
  activeView.value = "login";
}
function clearLoginReturn() {
  loginReturnView.value = null;
  loginReturnLabel.value = "";
}
async function finishLoginReturn() {
  const target = loginReturnView.value;
  if (!target) {
    await refresh();
    await loadPassengers();
    activeView.value = "overview";
    return;
  }
  await refresh();
  await loadPassengers();
  activeView.value = target;
  clearLoginReturn();
}
function returnFromLogin() {
  const target = loginReturnView.value ?? "overview";
  activeView.value = target;
  clearLoginReturn();
}
async function loadOfficialStations() {
  if (stationsLoading.value || officialStations.value.length) return;
  stationsLoading.value = true; stationsError.value = "";
  try { officialStations.value = await getOfficialStations(); }
  catch (cause) { stationsError.value = `官方站点暂不可选：${String(cause)}。请先在登录模块打开 12306，再重试。`; }
  finally { stationsLoading.value = false; }
}
watch(activeView, (view) => {
  if (view === "create") void loadOfficialStations();
  if (view === "tasks") void syncTaskLogs();
});
const passengerOptions = computed(() => {
  const merged = new Map<string, OfficialPassenger | TicketTaskDetail["passengers"][number]>();
  for (const passenger of editingTask.value?.passengers ?? []) merged.set(passenger.passengerRef, passenger);
  for (const passenger of officialPassengers.value.filter((item) => item.verified)) merged.set(passenger.passengerRef, passenger);
  return [...merged.values()];
});
const validPassengerCount = computed(() => officialPassengers.value.filter((item) => item.verified).length);
const isAuthenticated = computed(() => browserSession.value?.state === "logged_in");

const statusLabel = computed(() => protocol.value ? ({ unverified: "协议未验证", readOnlyCompatible: "只读兼容", compatible: "兼容", incompatible: "不兼容" })[protocol.value.status] : "检查中");
const readyTaskCount = computed(() => tasks.value.filter((task) => task.status === "READY" || task.status === "ARMED").length);
const attentionTaskCount = computed(() => tasks.value.filter((task) => ["INCOMPATIBLE", "USER_ACTION_REQUIRED", "RATE_LIMITED", "FAILED"].includes(task.status)).length);
const viewTitle = computed(() => ({ overview: "运行概览", login: "12306 登录", tasks: "抢票任务", create: "新建任务", orders: "订单核对", rehearsal: "测试演练", system: "系统与协议" })[activeView.value]);
const taskStatusLabels: Record<string, string> = { DRAFT: "草稿", PREFLIGHT: "预检中", READY: "已就绪", ARMED: "等待起售", QUERYING: "查询中", CANDIDATE_SELECTED: "已选中候选", ORDER_INITIALIZING: "准备订单", ORDER_SUBMITTING: "提交订单", QUEUING: "排队中", PAYMENT_PENDING: "待支付", USER_ACTION_REQUIRED: "需要人工处理", RATE_LIMITED: "已停止请求", INCOMPATIBLE: "协议未兼容", UNKNOWN_RECONCILING: "正在核对订单", PARTIAL_PAYMENT_PENDING: "部分乘车人待支付", CANCELLED: "已放弃", EXPIRED: "已过期", PAID: "已支付", FAILED: "失败" };
const eventStageLabels: Record<string, string> = { TASK_START: "启动任务", TASK_ARMED: "等待起售", TASK_STOPPED: "停止任务", TASK_ABANDONED: "放弃任务", MANUAL_QUERY: "手动查询", PREFLIGHT: "任务预检", SCHEDULER_DISPATCH: "调度触发", QUERY_ROUND_TRIP: "查询余票", CANDIDATE_DECISION: "筛选候选", SUBMISSION_GATE: "提交检查", ORDER_INITIALIZATION: "初始化订单", ORDER_SUBMISSION: "提交订单", QUEUE_ACCEPTED: "进入排队", ORDER_RECONCILIATION: "核对订单", NOTIFICATION: "发送提醒" };
const eventOutcomeLabels: Record<string, string> = { STARTED: "进行中", ACTIVE: "运行中", PASSED: "成功", SELECTED: "已命中", NO_AVAILABILITY: "暂无余票", PAYMENT_PENDING: "待支付", QUEUING: "排队中", STOPPED: "已停止", FAILED: "失败", BLOCKED: "已阻止", EMPTY: "未发现订单", UNKNOWN: "状态未知" };
const liveTaskStatuses = new Set(["ARMED", "QUERYING", "CANDIDATE_SELECTED", "ORDER_INITIALIZING", "ORDER_SUBMITTING", "QUEUING", "UNKNOWN_RECONCILING"]);
const performanceStats = computed(() => ["SCHEDULER_DISPATCH", "QUERY_ROUND_TRIP", "CANDIDATE_DECISION", "ORDER_INITIALIZATION", "QUEUE_ACCEPTED", "ORDER_SUBMISSION"].map((stage) => {
  const values = events.value.filter((event) => event.source === "12306_OFFICIAL_RUNTIME" && event.stage === stage && event.durationMs != null).map((event) => event.durationMs as number).sort((a,b) => a-b);
  return { stage, samples: values.length, p95: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null };
}));

function runtimeEvents(taskId: string) { return (taskEvents.value[taskId] ?? []).filter((event) => event.source === "12306_OFFICIAL_RUNTIME"); }
function latestRuntimeEvent(taskId: string) { return runtimeEvents(taskId)[0] ?? null; }
function taskQueryCount(taskId: string) { return runtimeEvents(taskId).filter((event) => event.stage === "QUERY_ROUND_TRIP").length; }
function taskRuntimeHeadline(task: TicketTaskView) {
  if (task.status === "ARMED") return schedulerHeartbeatAt.value != null && taskLogClock.value - schedulerHeartbeatAt.value < 5000 ? "Rust 后台正在监控，等待起售" : "后台调度器心跳异常";
  if (task.status === "QUERYING") return "正在向 12306 查询余票";
  if (["CANDIDATE_SELECTED", "ORDER_INITIALIZING", "ORDER_SUBMITTING", "QUEUING"].includes(task.status)) return "已命中车票，正在执行订单流程";
  if (task.status === "UNKNOWN_RECONCILING") return "提交结果未知，正在核对官方订单";
  if (["PAYMENT_PENDING", "PARTIAL_PAYMENT_PENDING"].includes(task.status)) return "已生成待支付订单";
  if (["USER_ACTION_REQUIRED", "RATE_LIMITED", "INCOMPATIBLE", "FAILED"].includes(task.status)) return "任务已暂停，需要处理";
  if (task.status === "CANCELLED") return "任务已放弃";
  if (task.status === "EXPIRED") return "任务已到截止时间";
  if (task.status === "READY") return "预检完成，等待启动";
  return "任务尚未启动";
}
function taskSaleCountdown(task: TicketTaskView) {
  if (task.status !== "ARMED" || !task.nextSaleTime) return null;
  // taskLogClock is updated once per second and makes the official-clock-derived label reactive.
  void taskLogClock.value;
  const remainingMs = new Date(task.nextSaleTime).getTime() - officialNowMs();
  if (remainingMs <= 0) return "起售已到，正在触发查询";
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  return days > 0 ? `距起售 ${days} 天 ${clock}` : `距起售 ${clock}`;
}
function taskRuntimeClass(task: TicketTaskView) {
  if (liveTaskStatuses.has(task.status)) return "is-live";
  if (["PAYMENT_PENDING", "PARTIAL_PAYMENT_PENDING", "PAID"].includes(task.status)) return "is-success";
  if (["USER_ACTION_REQUIRED", "RATE_LIMITED", "INCOMPATIBLE", "FAILED"].includes(task.status)) return "is-attention";
  return "is-idle";
}
function relativeEventTime(value?: string) {
  if (!value) return "尚无执行记录";
  const seconds = Math.max(0, Math.floor((taskLogClock.value - new Date(value).getTime()) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return new Date(value).toLocaleString();
}
function schedulerHeartbeatTime() { return schedulerHeartbeatAt.value == null ? "尚未启动" : relativeEventTime(new Date(schedulerHeartbeatAt.value).toISOString()); }
function mergeTaskEvent(event: ExecutionEvent) {
  const existing = taskEvents.value[event.taskId] ?? [];
  if (existing.some((item) => item.id === event.id)) return;
  taskEvents.value = { ...taskEvents.value, [event.taskId]: [event, ...existing].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 100) };
}
async function emitRuntimeEvent(input: Parameters<typeof recordRuntimeEvent>[0]) {
  const event = await recordRuntimeEvent(input);
  mergeTaskEvent(event);
  return event;
}
async function loadTaskEvents(taskId: string) {
  const latest = await listEvents(taskId, 100);
  taskEvents.value = { ...taskEvents.value, [taskId]: latest };
}
async function syncTaskLogs() {
  if (taskLogsSyncing.value || !isAuthenticated.value || activeView.value !== "tasks" || tasks.value.length === 0) return;
  taskLogsSyncing.value = true;
  try {
    const [results, latestTasks, runtime] = await Promise.all([
      Promise.all(tasks.value.map(async (task) => [task.id, await listEvents(task.id, 100)] as const)),
      listTasks(),
      getRuntimeStatus(),
    ]);
    taskEvents.value = { ...taskEvents.value, ...Object.fromEntries(results) };
    tasks.value = latestTasks;
    schedulerHeartbeatAt.value = runtime.healthy && runtime.heartbeatAt ? new Date(runtime.heartbeatAt).getTime() : null;
  } catch { /* The next one-second sync retries; task execution itself must not be stopped by a log display failure. */ }
  finally { taskLogsSyncing.value = false; }
}
async function toggleTaskLog(taskId: string) {
  expandedTaskLogs[taskId] = !expandedTaskLogs[taskId];
  if (expandedTaskLogs[taskId]) await loadTaskEvents(taskId).catch(() => undefined);
}

async function refresh() {
  error.value = "";
  try {
    const session = await getBrowserSession();
    browserSession.value = session;
    if (session.state !== "logged_in") {
      protocol.value = null; tasks.value = []; orders.value = []; officialPassengers.value = []; events.value = []; taskEvents.value = {};
      passengerSyncMessage.value = "";
      selectedTaskId.value = ""; queryTaskId.value = ""; paymentAlert.value = null;
      if (activeView.value === "create" && !loginReturnView.value) rememberLoginReturn("create", "新建任务");
      else if (activeView.value !== "login" && !loginReturnView.value) activeView.value = "overview";
      return;
    }
    [protocol.value, tasks.value, orders.value, browserCapabilities.value] = await Promise.all([getProtocolStatus(), listTasks(), listOrderSnapshots(), getBrowserCapabilities()]);
    if (activeView.value === "tasks") void syncTaskLogs();
  }
  catch (cause) { error.value = String(cause); }
}
function parseOfficialClock(value: string): number | null { const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value); return match ? Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`) : null; }
function officialNowMs() { return Date.now() + (officialClockOffsetMs.value ?? 0); }
async function synchronizeOfficialClock() { const started = Date.now(); const result = await getOfficialClock(); const ended = Date.now(); const official = typeof result.now === "number" ? result.now : result.now ? parseOfficialClock(result.now) : null; if (official == null) throw new Error("12306 官方时钟尚不可用"); officialClockOffsetMs.value = official - Math.round((started + ended) / 2); lastClockSyncAt = Date.now(); }

async function openLogin(visible = true) {
  busy.value = true; error.value = "";
  try { browserSession.value = await startBrowserSession(visible); startLoginPolling(); }
  catch (cause) { error.value = String(cause); }
  finally { busy.value = false; }
}
async function loadEmbeddedLogin() {
  loginQrLoading.value = true; error.value = "";
  try {
    browserSession.value = await startBrowserSession(false);
    const result = await getBrowserLoginQr();
    browserSession.value = result;
    loginQrDataUrl.value = result.qrDataUrl ?? "";
    startLoginPolling();
  } catch (cause) { error.value = String(cause); }
  finally { loginQrLoading.value = false; }
}
function stopLoginPolling() { if (loginPollTimer) window.clearInterval(loginPollTimer); loginPollTimer = undefined; }
function startLoginPolling() {
  stopLoginPolling();
  loginPollTimer = window.setInterval(async () => {
    try {
      const latest = await getBrowserSession();
      browserSession.value = latest;
      if (latest.state === "logged_in") {
        stopLoginPolling();
        if (activeView.value === "login") await finishLoginReturn();
        else {
          await refresh();
          await loadPassengers();
        }
      }
      else if (["closed", "error", "idle"].includes(latest.state)) stopLoginPolling();
    } catch { /* The next poll or the manual status check will expose a real failure. */ }
  }, 1500);
}
async function showLogin() { clearLoginReturn(); loginModalOpen.value = true; await loadEmbeddedLogin(); }
async function returnToLoginFromCreate() {
  rememberLoginReturn("create", "新建任务");
  if (browserSession.value?.state === "logged_in") {
    await loadPassengers();
    activeView.value = "create";
    clearLoginReturn();
  } else {
    await loadEmbeddedLogin();
  }
}
async function logout() {
  busy.value = true; error.value = "";
  try { browserSession.value = await logoutBrowserSession(); loginQrDataUrl.value = ""; protocol.value = null; tasks.value = []; orders.value = []; officialPassengers.value = []; passengerSyncMessage.value = ""; events.value = []; taskEvents.value = {}; selectedTaskId.value = ""; paymentAlert.value = null; activeView.value = "overview"; loginModalOpen.value = false; clearLoginReturn(); }
  catch (cause) { error.value = String(cause); }
  finally { busy.value = false; }
}
async function loadPassengers() {
  if (passengerSyncing.value) return;
  passengerSyncing.value = true; error.value = ""; passengerSyncMessage.value = "正在同步官方乘车人…";
  try {
    officialPassengers.value = await syncPassengers();
    if (!officialPassengers.value.length) {
      passengerSyncMessage.value = "未同步到乘车人";
      error.value = "当前账号没有返回可用乘车人，或会话需要再次核验";
    } else {
      passengerSyncMessage.value = `已同步 ${officialPassengers.value.length} 名乘车人`;
    }
    if (officialPassengers.value.length && loginReturnView.value) {
      const target = loginReturnView.value;
      activeView.value = target;
      clearLoginReturn();
    }
  }
  catch (cause) { passengerSyncMessage.value = "乘车人同步失败"; error.value = String(cause); }
  finally { passengerSyncing.value = false; }
}
function addRoute() { if (additionalRoutes.value.length >= 4) return; additionalRoutes.value.push({ id: crypto.randomUUID(), travelDate: form.travelDate, fromStation: form.fromStation, toStation: form.toStation, saleTime: form.saleTime, priority: additionalRoutes.value.length + 2, trainCodes: form.trainCodes, seatTypes: form.seatTypes }); }
function removeRoute(index: number) { const [removed] = additionalRoutes.value.splice(index, 1); if (removed) delete routeQueryCandidates[removed.id]; }
function priorityOptions(current: number) { return [...new Set([...Array.from({ length: Math.max(10, tasks.value.length + 1) }, (_, index) => index + 1), current])].sort((a, b) => a - b); }
function localDateTime(value: string) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function selectedTrainCodes(value: string) { return value.split(/[,，\s]+/).filter(Boolean); }
function selectedSeatTypes(value: string) { return value.split(/[,，\s]+/).filter(Boolean); }
function toggleSeat(value: string, seat: string) {
  const selected = selectedSeatTypes(value);
  return (selected.includes(seat) ? selected.filter((item) => item !== seat) : [...selected, seat]).slice(0, 5).join(", ");
}
function clearFormTrains() { form.trainCodes = ""; formQueryCandidates.value = []; formQueryMessage.value = ""; }
function clearRouteTrains(route: RouteDraft) { route.trainCodes = ""; delete routeQueryCandidates[route.id]; }
function toggleTrain(value: string, trainCode: string) {
  const selected = selectedTrainCodes(value);
  const next = selected.includes(trainCode) ? selected.filter((code) => code !== trainCode) : [...selected, trainCode];
  return next.slice(0, 5).join(", ");
}
async function lookupFormTrains() {
  error.value = ""; formQueryMessage.value = "";
  try {
    if (!isAuthenticated.value) { rememberLoginReturn("create", "新建任务"); await openLogin(); return; }
    if (!form.fromStation.trim() || !form.toStation.trim() || !form.travelDate) throw new Error("请先填写乘车日期、出发站和到达站");
    const result = await queryOfficialTickets(form.fromStation.trim(), form.toStation.trim(), form.travelDate);
    if (result.success !== true) throw new Error(`官方查询已停止：${result.classification ?? "响应不兼容"}`);
    formQueryCandidates.value = result.candidates ?? [];
    formQueryMessage.value = `官网返回 ${result.resultCount ?? formQueryCandidates.value.length} 个车次，最多选择 5 个`;
  } catch (cause) {
    const reason = String(cause);
    if (/登录|会话|核验|login/i.test(reason)) { rememberLoginReturn("create", "新建任务"); await openLogin().catch(() => undefined); }
    else error.value = reason;
  }
}
async function lookupRouteTrains(route: RouteDraft) {
  error.value = "";
  try {
    if (!isAuthenticated.value) { rememberLoginReturn("create", "新建任务"); await openLogin(); return; }
    if (!route.fromStation.trim() || !route.toStation.trim() || !route.travelDate) throw new Error("请先填写备选路线的乘车日期、出发站和到达站");
    const result = await queryOfficialTickets(route.fromStation.trim(), route.toStation.trim(), route.travelDate);
    if (result.success !== true) throw new Error(`官方查询已停止：${result.classification ?? "响应不兼容"}`);
    routeQueryCandidates[route.id] = result.candidates ?? [];
  } catch (cause) {
    const reason = String(cause);
    if (/登录|会话|核验|login/i.test(reason)) { rememberLoginReturn("create", "新建任务"); await openLogin().catch(() => undefined); }
    else error.value = reason;
  }
}
function queryFormRoute() { return lookupFormTrains(); }
function queryAdditionalRoute(route: RouteDraft) { return lookupRouteTrains(route); }
async function lookupSaleTime() {
  error.value = ""; saleTimeLookupMessage.value = "";
  try {
    if (!form.fromStation.trim()) throw new Error("请先填写出发站");
    const result = await getOfficialSaleTime(form.fromStation.trim());
    const datePart = form.saleTime.slice(0, 10);
    if (datePart) form.saleTime = `${datePart}T${result.saleTime}`;
    saleTimeLookupMessage.value = `${result.stationName}站官方当前起售时刻为 ${result.saleTime}${datePart ? "，已填入" : "；请选择起售日期后填写"}`;
  } catch (cause) { error.value = String(cause); }
}
async function lookupRouteSaleTime(route: RouteDraft) {
  error.value = ""; saleTimeLookupMessage.value = "";
  try {
    if (!route.fromStation.trim()) throw new Error("请先填写备选路线出发站");
    const result = await getOfficialSaleTime(route.fromStation.trim());
    const datePart = route.saleTime.slice(0, 10);
    if (datePart) route.saleTime = `${datePart}T${result.saleTime}`;
    saleTimeLookupMessage.value = `${result.stationName}站官方当前起售时刻为 ${result.saleTime}${datePart ? "，已填入备选路线" : "；请先选择该路线的起售日期"}`;
  } catch (cause) { error.value = String(cause); }
}

async function submitTask() {
  busy.value = true; error.value = ""; notice.value = "";
  try {
    for (const route of [form, ...additionalRoutes.value]) {
      if (!route.travelDate || !route.saleTime) throw new Error("请选择每条路线的乘车日期和官方起售时间");
      if (!route.trainCodes || !route.seatTypes) throw new Error("请为每条路线选择车次和席别");
    }
  const input: CreateTaskInput = {
    name: form.name.trim(), priority: Number(form.priority), splitAuthorized: form.splitAuthorized, realSubmissionAuthorized: form.realSubmissionAuthorized,
    passengers: selectedPassengerRefs.value.map((passengerRef, index) => { const passenger = passengerOptions.value.find((item) => item.passengerRef === passengerRef)!; return { passengerRef, displayName: passenger.displayName, ticketType: passenger.ticketType, priority: index + 1, verified: passenger.verified }; }),
    routeGroups: [{ id: editingTask.value?.routeGroups[0]?.id ?? crypto.randomUUID(), travelDate: form.travelDate, fromStation: form.fromStation.trim(), toStation: form.toStation.trim(), saleTime: new Date(form.saleTime).toISOString(), priority: editingTask.value?.routeGroups[0]?.priority ?? 1, trainCodes: form.trainCodes.split(/[,，\s]+/).filter(Boolean), seatTypes: form.seatTypes.split(/[,，\s]+/).filter(Boolean) }, ...additionalRoutes.value.map((route) => ({ id: route.id, travelDate: route.travelDate, fromStation: route.fromStation.trim(), toStation: route.toStation.trim(), saleTime: new Date(route.saleTime).toISOString(), priority: route.priority, trainCodes: route.trainCodes.split(/[,，\s]+/).filter(Boolean), seatTypes: route.seatTypes.split(/[,，\s]+/).filter(Boolean) }))],
    deadline: form.deadline ? new Date(form.deadline).toISOString() : null,
  };
    const savedTask = editingTaskId.value
      ? await updateTask(editingTaskId.value, input)
      : await createTask(input);
    tasks.value = editingTaskId.value
      ? tasks.value.map((item) => item.id === savedTask.id ? savedTask : item)
      : [savedTask, ...tasks.value];
    resetForm(); activeView.value = "tasks";
    await startTask(savedTask, false);
  }
  catch (cause) { error.value = String(cause); }
  finally { busy.value = false; }
}
function resetForm() { editingTaskId.value = ""; editingTask.value = null; selectedPassengerRefs.value = []; additionalRoutes.value = []; formQueryCandidates.value = []; formQueryMessage.value = ""; for (const key of Object.keys(routeQueryCandidates)) delete routeQueryCandidates[key]; Object.assign(form, { name: "", priority: 1, travelDate: "", fromStation: "", toStation: "", saleTime: "", deadline: "", trainCodes: "", seatTypes: "二等座", passengerRef: "", passengerName: "", splitAuthorized: false, realSubmissionAuthorized: false }); }
async function editTask(taskId: string) {
  busy.value = true; error.value = "";
  try { const task = await getTask(taskId); const route = task.routeGroups[0]; editingTaskId.value = task.id; editingTask.value = task; selectedPassengerRefs.value = task.passengers.sort((a,b) => a.priority - b.priority).map((passenger) => passenger.passengerRef); additionalRoutes.value = task.routeGroups.slice(1).map((item) => ({ id: item.id, travelDate: item.travelDate, fromStation: item.fromStation, toStation: item.toStation, saleTime: localDateTime(item.saleTime), priority: item.priority, trainCodes: item.trainCodes.join(", "), seatTypes: item.seatTypes.join(", ") })); Object.assign(form, { name: task.name, priority: task.priority, travelDate: route.travelDate, fromStation: route.fromStation, toStation: route.toStation, saleTime: localDateTime(route.saleTime), deadline: task.deadline ? localDateTime(task.deadline) : "", trainCodes: route.trainCodes.join(", "), seatTypes: route.seatTypes.join(", "), splitAuthorized: task.splitAuthorized, realSubmissionAuthorized: task.realSubmissionAuthorized }); activeView.value = "create"; }
  catch (cause) { error.value = String(cause); } finally { busy.value = false; }
}

async function startTask(task: TicketTaskView, showFailureAsError = true) {
  busy.value = true; error.value = "";
  try {
    await emitRuntimeEvent({ taskId: task.id, stage: "TASK_START", outcome: "STARTED", message: "已收到启动指令，正在执行登录、协议、乘车人和余票预检" });
    let readyTask = task;
    if (task.status !== "READY") {
      const detail = await getTask(task.id);
      await runOfficialPreflight(detail.passengers.map((passenger) => passenger.passengerRef));
      await synchronizeOfficialClock();
      for (const route of detail.routeGroups) {
        const probe = await queryOfficialTickets(route.fromStation, route.toStation, route.travelDate);
        if (probe.success !== true) throw new Error(`${route.fromStation}→${route.toStation} 只读兼容性探测失败：${probe.classification ?? "响应结构未知"}`);
      }
      readyTask = await runPreflight(task.id);
    }
    const updated = await armTask(readyTask.id);
    tasks.value = tasks.value.map((item) => item.id === task.id ? updated : item);
    await emitRuntimeEvent({ taskId: task.id, stage: "TASK_ARMED", outcome: "ACTIVE", message: "预检通过，调度器已接管任务并等待官方起售时刻" });
  }
  catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (showFailureAsError) error.value = reason;
    else notice.value = `任务已保存，但自动启动尚未完成：${reason}`;
    const updated = await haltTask(task.id, "USER_ACTION_REQUIRED", reason).catch(() => null);
    if (updated) tasks.value = tasks.value.map((item) => item.id === task.id ? updated : item);
    await emitRuntimeEvent({ taskId: task.id, stage: "TASK_STOPPED", outcome: "FAILED", message: `启动未完成：${reason}` }).catch(() => undefined);
  }
  finally { busy.value = false; }
}
const editableTaskStatuses = ["DRAFT", "INCOMPATIBLE", "FAILED", "USER_ACTION_REQUIRED", "RATE_LIMITED", "EXPIRED"];
const startableTaskStatuses = [...editableTaskStatuses, "READY"];
const stoppableTaskStatuses = ["ARMED", "QUERYING"];
const removableTaskStatuses = ["DRAFT", "INCOMPATIBLE", "FAILED", "USER_ACTION_REQUIRED", "RATE_LIMITED", "CANCELLED"];
const abandonableTaskStatuses = ["READY", "ARMED", "QUERYING", "PAYMENT_PENDING", "PARTIAL_PAYMENT_PENDING", "FAILED", "USER_ACTION_REQUIRED", "RATE_LIMITED", "INCOMPATIBLE", "EXPIRED"];
function canEditTask(task: TicketTaskView) { return editableTaskStatuses.includes(task.status); }
function canStopTask(task: TicketTaskView) { return stoppableTaskStatuses.includes(task.status); }
function canRemoveTask(task: TicketTaskView) { return removableTaskStatuses.includes(task.status); }
function displayFailureReason(reason: string | null) { return reason?.replace(/^Error:\s*/i, "") ?? ""; }
async function stopTask(task: TicketTaskView) {
  busy.value = true; error.value = "";
  try { const updated = await haltTask(task.id, "USER_ACTION_REQUIRED", "用户手动停止任务"); tasks.value = tasks.value.map((item) => item.id === updated.id ? updated : item); await emitRuntimeEvent({ taskId: task.id, stage: "TASK_STOPPED", outcome: "STOPPED", message: "用户已手动停止任务，系统不会继续查询或提交" }); }
  catch (cause) { error.value = String(cause); } finally { busy.value = false; }
}
async function abandonLocalTask(task: TicketTaskView) {
  if (!window.confirm("放弃后将停止该本地抢票任务；已生成的 12306 订单不会被取消。是否继续？")) return;
  busy.value = true; error.value = "";
  try { const updated = await abandonTask(task.id); tasks.value = tasks.value.map((item) => item.id === updated.id ? updated : item); await emitRuntimeEvent({ taskId: task.id, stage: "TASK_ABANDONED", outcome: "STOPPED", message: "用户已放弃本地任务；已有官方订单不受影响" }); }
  catch (cause) { error.value = String(cause); }
  finally { busy.value = false; }
}
async function queryTask(taskId: string) {
  busy.value = true; error.value = ""; queryMessage.value = "";
  const started = performance.now();
  try { const task = await getTask(taskId); const route = task.routeGroups[0]; await emitRuntimeEvent({ taskId, routeGroupId: route.id, stage: "MANUAL_QUERY", outcome: "STARTED", message: `正在查询 ${route.fromStation}→${route.toStation} 的官方余票` }); const result = await queryOfficialTickets(route.fromStation, route.toStation, route.travelDate); queryTaskId.value = taskId; queryCandidates.value = result.candidates ?? []; queryMessage.value = result.success ? `官网返回 ${result.resultCount ?? 0} 个车次` : `查询已停止：${result.classification ?? "响应不兼容"}`; await emitRuntimeEvent({ taskId, routeGroupId: route.id, stage: "MANUAL_QUERY", outcome: result.success ? "PASSED" : (result.classification ?? "FAILED"), message: queryMessage.value, durationMs: performance.now() - started }); }
  catch (cause) { error.value = String(cause); await emitRuntimeEvent({ taskId, stage: "MANUAL_QUERY", outcome: "FAILED", message: `手动查询失败：${cause instanceof Error ? cause.message : String(cause)}`, durationMs: performance.now() - started }).catch(() => undefined); } finally { busy.value = false; }
}
async function reconcileOrders() {
  busy.value = true; error.value = "";
  try { const result = await reconcileOfficialOrders(); const recovered = await persistReconciledUnknowns(result); reconciliationMessage.value = result.classification === "EMPTY" ? "官方确认当前没有未支付订单；未知任务保持停止，需人工决定是否重新预检" : result.classification === "UNKNOWN_STRUCTURE" ? "官方订单结构未知，已停止自动恢复" : `官方返回 ${result.orders?.length ?? 0} 个待支付订单`; orders.value = await listOrderSnapshots(); tasks.value = await listTasks(); if (result.classification === "PAYMENT_PENDING" && (result.orders?.length ?? 0) > 0) strongPaymentNotification(recovered[0]?.trainCode ?? "待支付订单", recovered[0]?.partial ?? false); }
  catch (cause) { error.value = String(cause); } finally { busy.value = false; }
}
async function persistReconciledUnknowns(result: Awaited<ReturnType<typeof reconcileOfficialOrders>>) {
  const recovered: Array<{ trainCode: string; partial: boolean }> = [];
  if (result.classification !== "PAYMENT_PENDING") return recovered;
  const candidates = await Promise.all(tasks.value.filter((task) => task.status === "UNKNOWN_RECONCILING").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).map((task) => getTask(task.id)));
  const claimedTasks = new Set<string>();
  for (const order of result.orders ?? []) {
    const detail = candidates.find((candidate) => !claimedTasks.has(candidate.id) && order.passengerRefs.length > 0 && order.passengerRefs.every((ref) => candidate.passengers.some((passenger) => passenger.passengerRef === ref)));
    if (!detail) continue;
    const partial = order.passengerRefs.length < detail.passengers.length;
    await recordOrderResult({ taskId: detail.id, officialOrderRef: order.orderRef, status: "PAYMENT_PENDING", passengerRefs: order.passengerRefs, paymentDeadline: order.paymentDeadline, partial });
    claimedTasks.add(detail.id);
    recovered.push({ trainCode: detail.routeGroups[0]?.trainCodes[0] ?? "订单", partial });
  }
  return recovered;
}
async function recoverAfterRestart() {
  if (browserSession.value?.state !== "logged_in" || (!tasks.value.some((task) => task.status === "UNKNOWN_RECONCILING") && !orders.value.some((order) => order.status === "PAYMENT_PENDING"))) return;
  try { const result = await reconcileOfficialOrders(); const recovered = await persistReconciledUnknowns(result); tasks.value = await listTasks(); orders.value = await listOrderSnapshots(); schedulerMessage.value = result.classification === "EMPTY" ? "重启恢复查单为空，未知任务保持停止" : "已完成重启后的官方订单核对"; if (result.classification === "PAYMENT_PENDING" && (result.orders?.length ?? 0) > 0) strongPaymentNotification(recovered[0]?.trainCode ?? "待支付订单", recovered[0]?.partial ?? false); }
  catch { schedulerMessage.value = "重启恢复需要人工打开 12306 完成核验"; }
}
const seatSummary = (candidate: TicketQueryCandidate) => Object.entries(candidate.seats).filter(([, value]) => value && value !== "无" && value !== "--").slice(0, 4).map(([key, value]) => `${({ business: "商务", firstClass: "一等", secondClass: "二等", softSleeper: "软卧", hardSleeper: "硬卧", hardSeat: "硬座", noSeat: "无座", other: "其他" } as Record<string,string>)[key] ?? key} ${value}`).join(" · ") || "暂无可选席别";
function playAlertTone() {
  const audio = new AudioContext();
  for (const [index, delay] of [0, 350, 700].entries()) { const oscillator = audio.createOscillator(); const gain = audio.createGain(); oscillator.connect(gain); gain.connect(audio.destination); oscillator.frequency.value = 880; gain.gain.value = 0.08; if (index === 2) oscillator.onended = () => { void audio.close(); }; oscillator.start(audio.currentTime + delay / 1000); oscillator.stop(audio.currentTime + delay / 1000 + 0.2); }
}
function stopPaymentAlert() {
  if (alertSoundTimer) window.clearInterval(alertSoundTimer);
  if (alertTitleTimer) window.clearInterval(alertTitleTimer);
  alertSoundTimer = undefined; alertTitleTimer = undefined; document.title = "Fast 12306"; paymentAlert.value = null;
}
async function showOfficialOrderPage() { try { await openOfficialOrders(); } catch (cause) { error.value = String(cause); } }
function strongPaymentNotification(trainCode: string, partial: boolean) {
  stopPaymentAlert();
  paymentAlert.value = { trainCode, partial, confirmedAt: new Date().toISOString() };
  schedulerMessage.value = partial ? `${trainCode} 已生成部分待支付订单，请立即处理` : `${trainCode} 已生成待支付订单，请立即支付`;
  if ("Notification" in window && Notification.permission === "granted") new Notification(partial ? "部分乘车人已生成待支付订单" : "12306 待支付订单已生成", { body: `${trainCode}：请立即前往官方页面核对并支付`, requireInteraction: true });
  playAlertTone();
  alertSoundTimer = window.setInterval(playAlertTone, 5000);
  let highlighted = false;
  alertTitleTimer = window.setInterval(() => { highlighted = !highlighted; document.title = highlighted ? "【待支付】Fast 12306" : "Fast 12306"; }, 800);
}
async function removeTask(taskId: string) {
  if (!window.confirm("删除该本地任务及其测试日志？此操作不会影响 12306。")) return;
  busy.value = true; error.value = "";
  try { await deleteTask(taskId); tasks.value = tasks.value.filter((task) => task.id !== taskId); const remaining = { ...taskEvents.value }; delete remaining[taskId]; taskEvents.value = remaining; }
  catch (cause) { error.value = String(cause); } finally { busy.value = false; }
}
async function loadEvents() { if (selectedTaskId.value) events.value = await listEvents(selectedTaskId.value); }
async function rehearse() {
  if (!selectedTaskId.value) return;
  busy.value = true; error.value = "";
  try { const result = await runRehearsal(selectedTaskId.value, scenario.value, scenario.value === "seats_available" ? 1 : undefined); rehearsalOutcome.value = result.finalOutcome; events.value = [...result.events].reverse(); if ("Notification" in window && Notification.permission === "granted") new Notification("Fast 12306 测试通知", { body: "演练完成，不存在真实订单" }); }
  catch (cause) { error.value = String(cause); } finally { busy.value = false; }
}
async function enableTestNotifications() { if ("Notification" in window) await Notification.requestPermission(); }
async function runNotificationSelfTest() {
  if ("Notification" in window) await Notification.requestPermission();
  if ("Notification" in window && Notification.permission === "granted") new Notification("Fast 12306 通知自检", { body: "这是一条本机测试通知，不代表已生成订单。" });
  const audio = new AudioContext(); const oscillator = audio.createOscillator(); const gain = audio.createGain(); oscillator.connect(gain); gain.connect(audio.destination); oscillator.frequency.value = 740; gain.gain.value = 0.08; oscillator.start(); oscillator.stop(audio.currentTime + 0.35);
  if (window.confirm("你是否已经看到测试通知并听到提示音？")) { notificationSelfTestPassed.value = true; localStorage.setItem("fast12306.notificationSelfTest", "passed"); }
}
function runStrongAlertTest() { stopPaymentAlert(); paymentAlert.value = { trainCode: "测试提醒（不存在真实订单）", partial: false, confirmedAt: new Date().toISOString(), test: true }; playAlertTone(); alertSoundTimer = window.setInterval(playAlertTone, 5000); }
onMounted(async () => {
  await refresh();
  if (isAuthenticated.value) await loadPassengers();
  await recoverAfterRestart();
  // Real scheduling and submission are owned by the Rust background runtime. The UI only
  // refreshes observable state; running a second scheduler here could create duplicate orders.
  taskLogTimer = window.setInterval(() => { taskLogClock.value = Date.now(); void syncTaskLogs(); }, 1000);
});
onBeforeUnmount(() => { if (taskLogTimer) window.clearInterval(taskLogTimer); stopLoginPolling(); stopPaymentAlert(); });
</script>

<template>
  <div class="app-frame" :class="{ 'login-shell': activeView === 'login' }">
    <div v-if="paymentAlert" class="payment-alert" role="alertdialog" aria-live="assertive">
      <div><small>{{ paymentAlert.test ? "本机强提醒测试" : paymentAlert.partial ? "部分乘车人已生成订单" : "真实待支付订单已生成" }}</small><strong>{{ paymentAlert.test ? paymentAlert.trainCode : `${paymentAlert.trainCode} 请立即核对并支付` }}</strong><span>确认时间 {{ new Date(paymentAlert.confirmedAt).toLocaleTimeString() }} · {{ paymentAlert.test ? "仅测试声音和页面警报" : "本工具不会自动支付" }}</span></div>
      <button v-if="!paymentAlert.test" class="alert-open" @click="showOfficialOrderPage">打开 12306 待支付订单</button><button class="alert-ack" @click="stopPaymentAlert">我已查看并静音</button>
    </div>
    <div v-if="loginModalOpen" class="login-modal-backdrop" role="dialog" aria-modal="true" aria-label="登录 12306">
      <section class="login-modal">
        <button class="login-modal-close" :disabled="busy" aria-label="关闭登录窗口" @click="loginModalOpen = false">×</button>
        <div class="login-modal-kicker">12306 官方会话</div>
        <h2>{{ loginHeading }}</h2>
        <p>{{ browserSession?.message || "正在准备 12306 官方登录二维码" }}</p>
        <div class="login-modal-status"><i :class="{ ready: browserSession?.state === 'logged_in' }"></i>{{ browserSession?.state === "logged_in" ? "会话有效" : browserSession?.message || "请使用铁路 12306 App 扫码" }}</div>
        <div v-if="loginQrLoading" class="login-qr-state"><span class="login-qr-spinner"></span><strong>正在加载官方二维码…</strong></div>
        <div v-else-if="loginQrDataUrl" class="login-qr-panel"><img :src="loginQrDataUrl" alt="12306 官方登录二维码" /><small>二维码失效时点击下方刷新</small></div>
        <button v-if="browserSession?.state !== 'logged_in'" class="login-primary" :disabled="loginQrLoading" @click="loadEmbeddedLogin">{{ loginQrDataUrl ? "刷新登录二维码" : "加载登录二维码" }}<span>↻</span></button>
        <button v-else class="login-primary" :disabled="busy" @click="openLogin(true)">打开 12306 官方页面<span>↗</span></button>
        <div class="login-secondary-actions"><button class="quiet-action" :disabled="busy" @click="refresh">检查状态</button><button class="quiet-action" :disabled="busy || browserSession?.state !== 'logged_in'" @click="loadPassengers">同步乘车人</button><button v-if="browserSession?.state !== 'logged_in'" class="quiet-action" :disabled="busy" @click="openLogin(true)">需要核验？打开官方页面</button></div>
        <div class="modal-security">二维码来自本机打开的 12306 官方登录页。账号密码、验证码和 Cookie 不会提交到本工具；App 或滑块核验仍在官方页面完成。</div>
      </section>
    </div>
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">F</span><div><strong>Fast 12306</strong><small>个人抢票助手</small></div></div>
      <nav aria-label="主要功能">
        <button :class="{ active: activeView === 'overview' }" @click="activeView = 'overview'">运行概览</button>
        <template v-if="isAuthenticated">
          <button :class="{ active: activeView === 'tasks' }" @click="activeView = 'tasks'">抢票任务 <span>{{ tasks.length }}</span></button>
          <button :class="{ active: activeView === 'create' }" @click="activeView = 'create'">新建任务</button>
          <button :class="{ active: activeView === 'orders' }" @click="activeView = 'orders'">订单核对 <span>{{ orders.length }}</span></button>
          <button :class="{ active: activeView === 'rehearsal' }" @click="activeView = 'rehearsal'">测试演练</button>
          <button :class="{ active: activeView === 'system' }" @click="activeView = 'system'">系统与协议</button>
        </template>
      </nav>
      <div class="sidebar-foot"><span class="status-dot" :class="protocol?.status"></span><div><strong>{{ isAuthenticated ? statusLabel : "未登录" }}</strong><small>{{ isAuthenticated ? `真实提交 ${protocol?.submissionEnabled ? "已启用" : "已锁定"}` : "登录后加载本机数据" }}</small></div></div>
    </aside>

    <main class="workspace">
      <header class="topbar"><div><p>{{ viewTitle }}</p><small>所有数据仅保存在本机</small></div><div class="topbar-actions"><button v-if="browserSession?.state !== 'logged_in'" class="login-topbar-button" :disabled="busy" @click="showLogin">登录 12306 <span>↗</span></button><div v-else class="account-menu"><span class="account-state"><i></i>12306 已登录</span><button class="quiet-action" :disabled="passengerSyncing" @click="loadPassengers">{{ passengerSyncing ? "正在同步…" : officialPassengers.length ? `乘车人 ${officialPassengers.length} 名 · 重新同步` : "同步乘车人" }}</button><button class="quiet-action" :disabled="busy || passengerSyncing" @click="logout">退出登录</button></div><button class="quiet-action" :disabled="busy || passengerSyncing" @click="refresh">刷新状态</button></div></header>
      <p v-if="isAuthenticated && passengerSyncMessage" class="sync-status" aria-live="polite">{{ passengerSyncMessage }}</p>
      <p v-if="error" class="error-banner">{{ error }}</p>
      <div v-if="notice" class="notice-banner"><span>{{ notice }}</span><button type="button" @click="notice = ''">知道了</button></div>

      <section v-if="!isAuthenticated && activeView !== 'login'" class="view auth-wall">
        <div class="auth-wall-card"><p class="kicker">本机数据已锁定</p><h1>请先登录 12306</h1><p>登录前不会读取或展示任务、订单、乘车人和运行日志。完成官方扫码及必要核验后，返回这里继续操作。</p><button @click="showLogin">登录 12306 <span>↗</span></button></div>
      </section>
      <section v-else-if="isAuthenticated && activeView === 'overview'" class="view">
        <div class="view-heading"><div><p class="kicker">今日运行</p><h1>任务控制中心</h1></div><button @click="activeView = 'create'">新建抢票任务</button></div>
        <div class="metrics"><article><small>全部任务</small><strong>{{ tasks.length }}</strong><p>本机保存的抢票计划</p></article><article><small>等待执行</small><strong>{{ readyTaskCount }}</strong><p>{{ schedulerMessage }}</p></article><article><small>需要处理</small><strong>{{ attentionTaskCount }}</strong><p>协议、登录或运行异常</p></article></div>
        <div class="overview-grid">
          <section class="module protocol-module"><div class="module-heading"><div><small>安全门禁</small><h2>12306 协议状态</h2></div><span class="state-chip">{{ statusLabel }}</span></div><p>{{ protocol?.message }}</p><button class="text-action" @click="activeView = 'system'">查看协议详情</button></section>
          <section class="module recent-module"><div class="module-heading"><div><small>最近活动</small><h2>任务动态</h2></div><button class="text-action" @click="activeView = 'tasks'">查看全部</button></div><div v-if="tasks.length === 0" class="compact-empty">尚无任务。创建后将在这里显示状态变化。</div><div v-for="task in tasks.slice(0, 3)" :key="task.id" class="activity-row"><div><strong>{{ task.name }}</strong><small>{{ task.passengerCount }} 人 · {{ task.routeGroupCount }} 路线</small></div><span>{{ taskStatusLabels[task.status] ?? "状态未知" }}</span></div></section>
        </div>
      </section>

      <section v-else-if="activeView === 'login'" class="view login-view">
        <button class="context-back" type="button" @click="returnFromLogin"><span>←</span> 返回{{ loginReturnLabel || "运行概览" }}</button>
        <div class="login-brand"><span class="brand-mark">F</span><div><strong>Fast 12306</strong><small>个人抢票助手</small></div></div>
        <div class="login-layout">
          <div class="login-intro"><p class="kicker">官方会话入口</p><h1>先登录，<br><em>再开始抢票。</em></h1><p class="login-lede">扫码登录只在本机完成。登录成功后，你可以回到任务工作台配置车次、席别和乘车人。</p><div class="login-points"><span><b>01</b>扫码登录官方页面</span><span><b>02</b>完成必要的安全核验</span><span><b>03</b>返回工具同步官方乘车人</span></div></div>
          <section class="login-card">
            <div class="login-card-head"><div><small>12306 会话</small><h2>{{ browserSession?.state === "logged_in" ? "已登录" : browserSession?.state === "awaiting_login" ? "等待扫码" : browserSession?.state === "starting" ? "正在打开" : "尚未登录" }}</h2></div><span class="login-status" :class="browserSession?.state === 'logged_in' ? 'is-ready' : ''"><i></i>{{ browserSession?.state === "logged_in" ? "会话有效" : "等待操作" }}</span></div>
            <p class="login-message">{{ browserSession?.message || "点击下方按钮打开官方登录窗口" }}</p>
            <div v-if="loginQrLoading" class="login-qr-state"><span class="login-qr-spinner"></span><strong>正在加载官方二维码…</strong></div>
            <div v-else-if="loginQrDataUrl && browserSession?.state !== 'logged_in'" class="login-qr-panel"><img :src="loginQrDataUrl" alt="12306 官方登录二维码" /><small>使用铁路 12306 App 扫描</small></div>
            <button class="login-primary" :disabled="busy || loginQrLoading" @click="browserSession?.state === 'logged_in' ? openLogin(true) : loadEmbeddedLogin()">{{ browserSession?.state === "logged_in" ? "打开 12306 官方页面" : loginQrDataUrl ? "刷新登录二维码" : "加载登录二维码" }}<span>{{ browserSession?.state === "logged_in" ? "↗" : "↻" }}</span></button>
            <div class="login-secondary-actions"><button class="quiet-action" :disabled="busy" @click="refresh">检查状态</button><button class="quiet-action" :disabled="busy || browserSession?.state !== 'logged_in'" @click="loadPassengers">同步乘车人</button></div>
            <div v-if="officialPassengers.length" class="passenger-summary"><strong>已同步 {{ officialPassengers.length }} 名官方乘车人</strong><span>{{ validPassengerCount }} 名可用于任务</span><p v-if="validPassengerCount < officialPassengers.length">部分记录的官方状态字段与可选状态不一致，最终以 12306 确认页的实际可选性为准。</p></div>
            <div class="privacy-note"><strong>本机安全边界</strong><p>不保存账号密码，不读取短信验证码，不绕过滑块或 App 核验。Cookie 仅保存在本机浏览器目录。</p></div>
          </section>
        </div>
        <button class="login-back" @click="returnFromLogin">返回{{ loginReturnLabel || "运行概览" }} <span>→</span></button>
      </section>

      <section v-else-if="isAuthenticated && activeView === 'tasks'" class="view">
        <div class="view-heading"><div><p class="kicker">任务队列</p><h1>抢票任务</h1><p>查询可以有限并发，订单提交始终全局串行。</p></div><button @click="activeView = 'create'">新建任务</button></div>
        <div v-if="tasks.length === 0" class="empty"><strong>还没有任务</strong><p>完成当前 12306 协议只读验证后，任务才能进入就绪状态。</p><button @click="activeView = 'create'">创建第一个任务</button></div>
        <article v-for="task in tasks" :key="task.id" class="task-card module">
          <div class="task-row">
            <div><small>优先级 {{ task.priority }} · {{ task.passengerCount }} 人 · {{ task.routeGroupCount }} 路线<span v-if="task.deadline"> · 截止 {{ new Date(task.deadline).toLocaleString() }}</span></small><h3>{{ task.name }}</h3><p v-if="task.failureReason" class="failure">{{ displayFailureReason(task.failureReason) }}</p></div>
            <div class="task-actions"><span class="badge">{{ taskStatusLabels[task.status] ?? "状态未知" }}</span><div><button class="secondary" :disabled="busy" @click="queryTask(task.id)">查询余票</button><button v-if="startableTaskStatuses.includes(task.status)" class="secondary" :disabled="busy" @click="startTask(task)">启动任务</button><button v-if="stoppableTaskStatuses.includes(task.status)" class="secondary" :disabled="busy" @click="stopTask(task)">停止任务</button><button v-if="abandonableTaskStatuses.includes(task.status)" class="secondary abandon-action" :disabled="busy" @click="abandonLocalTask(task)">放弃任务</button><button class="secondary" :disabled="busy || !canEditTask(task)" @click="editTask(task.id)">编辑</button><button class="danger-action" :disabled="busy || !canRemoveTask(task)" @click="removeTask(task.id)">删除</button></div></div>
          </div>
          <section class="task-runtime" :class="taskRuntimeClass(task)" aria-live="polite">
            <div class="task-runtime-summary">
              <span class="runtime-pulse" aria-hidden="true"></span>
              <div class="runtime-copy"><strong>{{ taskRuntimeHeadline(task) }}</strong><b v-if="taskSaleCountdown(task)" class="sale-countdown">{{ taskSaleCountdown(task) }}</b><span v-if="latestRuntimeEvent(task.id)">{{ latestRuntimeEvent(task.id)?.message }}</span><span v-else>启动任务后，预检、查询、选票、提交和核单记录会实时显示在这里。</span></div>
              <div class="runtime-meta"><span>最近查询 {{ taskQueryCount(task.id) }} 次</span><span>调度心跳 {{ schedulerHeartbeatTime() }}</span><span>最后事件 {{ relativeEventTime(latestRuntimeEvent(task.id)?.createdAt) }}</span></div>
              <button class="runtime-toggle" type="button" @click="toggleTaskLog(task.id)">{{ expandedTaskLogs[task.id] ? "收起日志" : "查看执行日志" }}<span>{{ expandedTaskLogs[task.id] ? "↑" : "↓" }}</span></button>
            </div>
            <div v-if="expandedTaskLogs[task.id]" class="task-runtime-log">
              <div class="runtime-log-head"><strong>实时执行记录</strong><span><i></i>每秒自动刷新</span></div>
              <div v-if="runtimeEvents(task.id).length === 0" class="runtime-empty">尚无执行记录。点击“启动任务”后，这里会立即显示预检和调度状态。</div>
              <ol v-else class="runtime-timeline">
                <li v-for="event in runtimeEvents(task.id)" :key="event.id">
                  <time>{{ new Date(event.createdAt).toLocaleTimeString() }}</time>
                  <span class="timeline-dot"></span>
                  <div><div><strong>{{ eventStageLabels[event.stage] ?? event.stage }}</strong><em :class="`outcome-${event.outcome.toLowerCase()}`">{{ eventOutcomeLabels[event.outcome] ?? event.outcome }}</em></div><p>{{ event.message }}<template v-if="event.durationMs != null"> · {{ event.durationMs.toFixed(1) }} ms</template></p></div>
                </li>
              </ol>
            </div>
          </section>
          <div v-if="queryTaskId === task.id" class="query-results"><div class="query-result-head"><strong>{{ queryMessage }}</strong><span>数据来自当前 12306 官方只读查询</span></div><div v-for="candidate in queryCandidates.slice(0, 20)" :key="candidate.trainInternalRef" class="train-row"><strong>{{ candidate.trainCode }}</strong><span>{{ candidate.departureTime }} → {{ candidate.arrivalTime }}</span><span>{{ candidate.duration }}</span><small>{{ seatSummary(candidate) }}</small></div><p v-if="!queryCandidates.length">本次没有可展示的候选车次。</p></div>
        </article>
      </section>

      <section v-else-if="isAuthenticated && activeView === 'create'" class="view create-view">
        <button class="context-back" type="button" @click="activeView = 'tasks'"><span>←</span> 返回抢票任务</button>
        <div class="view-heading"><div><p class="kicker">配置向导</p><h1>{{ editingTaskId ? "编辑抢票任务" : "新建抢票任务" }}</h1><p>协议通过前可以保存和检查任务，但不能发起真实订单。</p></div></div>
        <form class="task-form" @submit.prevent="submitTask">
          <section class="form-section module">
            <div class="section-intro"><span>1</span><div><h2>行程与优先级</h2><p>定义起售时间、截止时间、路线以及优先选择的车次和席别。路线组按优先级依次执行。</p></div></div>
            <div class="fields two"><label>任务名称<input v-model="form.name" required placeholder="例如：国庆返程" /></label><label>任务优先级<select v-model.number="form.priority"><option v-for="priority in priorityOptions(form.priority)" :key="priority" :value="priority">{{ priority }}{{ priority === 1 ? "（最高）" : "" }}</option></select></label><label>乘车日期<DatePicker v-model="form.travelDate" label="乘车日期" :min-date="todayDate" @update:model-value="clearFormTrains" /></label><label>官方起售日期与时间<DatePicker v-model="form.saleTime" label="官方起售日期与时间" :min-date="todayDate" with-time /></label><label>任务截止时间（可选）<DatePicker v-model="form.deadline" label="任务截止时间" :min-date="todayDate" with-time optional /><small>到时停止新查询，不会取消已生成订单。</small></label><label>出发站<StationPicker v-model="form.fromStation" :options="stationOptions" required aria-label="出发站" placeholder="输入车站名称搜索" @update:model-value="clearFormTrains" /></label><label>到达站<StationPicker v-model="form.toStation" :options="stationOptions" required aria-label="到达站" placeholder="输入车站名称搜索" @update:model-value="clearFormTrains" /></label><label>优先车次<button class="selection-output selection-trigger" type="button" :disabled="busy" @click="queryFormRoute">{{ form.trainCodes || "点击查询并选择车次" }}<span>查询</span></button></label><label>优先席别<output class="selection-output">{{ form.seatTypes || "请选择席别" }}</output><div class="choice-picker"><button v-for="seat in seatOptions" :key="seat" type="button" :class="{ selected: selectedSeatTypes(form.seatTypes).includes(seat) }" @click="form.seatTypes = toggleSeat(form.seatTypes, seat)">{{ seat }}</button></div></label></div>
            <div class="route-tools"><span v-if="stationsLoading">正在读取官方站点表…</span><template v-else-if="stationsError"><span class="field-hint">{{ stationsError }}</span><button type="button" class="quiet-action" @click="loadOfficialStations">重新加载车站</button></template></div>
            <div class="route-tools"><button class="quiet-action" type="button" @click="lookupSaleTime">查询发站官方起售时刻</button><button class="quiet-action" type="button" @click="lookupFormTrains">查询官网车次并选择</button><span v-if="saleTimeLookupMessage">{{ saleTimeLookupMessage }}</span><span v-if="formQueryMessage">{{ formQueryMessage }}</span></div>
            <div v-if="formQueryCandidates.length" class="train-picker" aria-label="选择优先车次"><button v-for="candidate in formQueryCandidates" :key="candidate.trainInternalRef" type="button" :class="{ selected: selectedTrainCodes(form.trainCodes).includes(candidate.trainCode) }" @click="form.trainCodes = toggleTrain(form.trainCodes, candidate.trainCode)"><strong>{{ candidate.trainCode }}</strong><span>{{ candidate.departureTime }}–{{ candidate.arrivalTime }}</span><small>{{ seatSummary(candidate) }}</small></button></div>
            <div v-for="(route, index) in additionalRoutes" :key="route.id" class="route-draft">
              <div class="route-draft-head"><strong>备选路线 {{ index + 2 }}</strong><button class="danger-action" type="button" @click="removeRoute(index)">移除</button></div>
              <div class="fields two"><label>路线优先级<select v-model.number="route.priority"><option v-for="priority in priorityOptions(route.priority)" :key="priority" :value="priority">{{ priority }}{{ priority === 1 ? "（最高）" : "" }}</option></select></label><label>乘车日期<DatePicker v-model="route.travelDate" label="备选路线乘车日期" :min-date="todayDate" @update:model-value="clearRouteTrains(route)" /></label><label>官方起售时间<DatePicker v-model="route.saleTime" label="备选路线官方起售时间" :min-date="todayDate" with-time /></label><label>出发站<StationPicker v-model="route.fromStation" :options="stationOptions" required :aria-label="`备选路线 ${index + 2} 出发站`" placeholder="输入车站名称搜索" @update:model-value="clearRouteTrains(route)" /></label><label>到达站<StationPicker v-model="route.toStation" :options="stationOptions" required :aria-label="`备选路线 ${index + 2} 到达站`" placeholder="输入车站名称搜索" @update:model-value="clearRouteTrains(route)" /></label><label>优先车次<button class="selection-output selection-trigger" type="button" :disabled="busy" @click="queryAdditionalRoute(route)">{{ route.trainCodes || "点击查询并选择车次" }}<span>查询</span></button></label><label>优先席别<output class="selection-output">{{ route.seatTypes || "请选择席别" }}</output><div class="choice-picker"><button v-for="seat in seatOptions" :key="`${route.id}-${seat}`" type="button" :class="{ selected: selectedSeatTypes(route.seatTypes).includes(seat) }" @click="route.seatTypes = toggleSeat(route.seatTypes, seat)">{{ seat }}</button></div></label></div>
              <div class="route-tools"><button class="quiet-action" type="button" @click="lookupRouteSaleTime(route)">查询该路线官方起售时刻</button><button class="quiet-action" type="button" @click="lookupRouteTrains(route)">查询官网车次并选择</button></div>
              <div v-if="routeQueryCandidates[route.id]?.length" class="train-picker" :aria-label="`选择备选路线 ${index + 2} 的优先车次`"><button v-for="candidate in routeQueryCandidates[route.id]" :key="candidate.trainInternalRef" type="button" :class="{ selected: selectedTrainCodes(route.trainCodes).includes(candidate.trainCode) }" @click="route.trainCodes = toggleTrain(route.trainCodes, candidate.trainCode)"><strong>{{ candidate.trainCode }}</strong><span>{{ candidate.departureTime }}–{{ candidate.arrivalTime }}</span><small>{{ seatSummary(candidate) }}</small></button></div>
            </div>
            <button class="quiet-action add-route" type="button" :disabled="additionalRoutes.length >= 4" @click="addRoute">{{ additionalRoutes.length >= 4 ? "最多 5 个路线组" : "添加日期或路线组" }}</button>
          </section>
          <section class="form-section module"><div class="section-intro"><span>2</span><div><h2>乘车人</h2><p>可选择多人；勾选顺序即拆单优先级。本地只保存不可逆引用和掩码显示名，提交前仍会由 12306 确认页复核。</p></div></div><div v-if="passengerOptions.length" class="passenger-grid"><label v-for="passenger in passengerOptions" :key="passenger.passengerRef" class="passenger-choice"><input v-model="selectedPassengerRefs" type="checkbox" :value="passenger.passengerRef" /><span><strong>{{ passenger.displayName }}</strong>{{ 'ticketTypeLabel' in passenger ? passenger.ticketTypeLabel : passenger.ticketType }}</span></label></div><div v-else class="passenger-empty"><span>尚未同步乘车人</span><button class="quiet-action" type="button" @click="returnToLoginFromCreate">前往登录并同步</button></div><p v-if="!selectedPassengerRefs.length" class="field-hint">至少选择一名已同步乘车人。</p></section>
          <section class="form-section module"><div class="section-intro"><span>3</span><div><h2>提交策略</h2><p>拆单只在明确授权后执行，任何未知结果都会中止后续订单。</p></div></div><label class="consent"><input v-model="form.splitAuthorized" type="checkbox" /><span><strong>允许自动拆单</strong>余票不足时按乘车人优先级逐单提交。</span></label><label class="consent real-submission-consent"><input v-model="form.realSubmissionAuthorized" type="checkbox" /><span><strong>允许真实自动下单</strong>命中车次后，系统可以向 12306 提交并生成待支付订单；不会自动支付，支付或取消由你在官方页面完成。</span></label><p class="field-hint">未勾选时只自动查票和选票，不会创建真实订单。</p></section>
          <div class="form-actions"><button class="quiet-action" type="button" @click="resetForm(); activeView = 'tasks'">取消</button><button :disabled="busy || !selectedPassengerRefs.length" type="submit">{{ busy ? "保存中…" : editingTaskId ? "保存修改" : "保存任务" }}</button></div>
        </form>
      </section>

      <section v-else-if="isAuthenticated && activeView === 'orders'" class="view system-view">
        <div class="view-heading"><div><p class="kicker">官方状态恢复</p><h1>订单核对</h1><p>程序启动或提交结果未知时，必须先核对官方订单。这里不会自动取消或支付订单。</p></div><button :disabled="busy" @click="reconcileOrders">核对官方未支付订单</button></div><p v-if="reconciliationMessage" class="system-message">{{ reconciliationMessage }}</p>
        <div v-if="orders.length === 0" class="empty"><strong>没有真实订单快照</strong><p>测试演练不会写入此处。只有官方订单核对结果会出现在这里。</p></div>
        <article v-for="order in orders" :key="order.localId" class="module order-row"><div><small>{{ order.source }}</small><h3>{{ order.officialOrderRef ?? "官方订单号待确认" }}</h3><p>{{ order.passengerRefs.length }} 名乘车人 · 最近核对 {{ new Date(order.lastReconciledAt).toLocaleString() }}</p></div><span class="badge">{{ order.status }}</span></article>
      </section>

      <section v-else-if="isAuthenticated && activeView === 'rehearsal'" class="view rehearsal-view">
        <div class="view-heading"><div><p class="kicker">本地链路测试</p><h1>验证自动化流程</h1><p>用本地模拟数据检查拆单顺序、账号级提交锁、超时先查单和安全停止规则，确认配置上线前不会误重提或重复下单。</p></div></div>
        <div class="simulation-banner"><strong>不会产生真实订单</strong><span>演练只验证任务状态机和调度逻辑，不访问 12306，也不代表真实余票或订单状态。</span></div>
        <section class="module rehearsal-controls"><div class="fields two"><label>选择任务<select v-model="selectedTaskId" @change="loadEvents"><option value="">请选择</option><option v-for="task in tasks" :key="task.id" :value="task.id">{{ task.name }}</option></select></label><label>测试场景<select v-model="scenario"><option value="seats_available">有票并串行拆单</option><option value="no_availability">无票继续等待</option><option value="timeout_reconciled_empty">提交超时后先查单</option><option value="rate_limited">触发限流并停止</option></select></label></div><div class="rehearsal-actions"><button :disabled="busy || !selectedTaskId" @click="rehearse">{{ busy ? "演练中…" : "开始测试演练" }}</button><button class="quiet-action" @click="enableTestNotifications">允许测试通知</button><span v-if="rehearsalOutcome">结果：{{ rehearsalOutcome }}</span></div></section>
        <section class="module event-log"><div class="module-heading"><div><small>SIMULATION / OFFICIAL RUNTIME</small><h2>执行日志与性能</h2></div><button class="text-action" @click="loadEvents">刷新日志</button></div><div v-if="selectedTaskId" class="performance-grid"><div v-for="metric in performanceStats" :key="metric.stage"><small>{{ metric.stage }}</small><strong>{{ metric.p95 == null ? "暂无样本" : `P95 ${metric.p95.toFixed(1)} ms` }}</strong><span>{{ metric.samples }} 个样本</span></div></div><div v-if="events.length === 0" class="compact-empty">选择任务后显示演练日志和官方运行指标。</div><article v-for="event in events" :key="event.id" class="event-row"><div><strong>{{ event.stage }}</strong><span>{{ event.outcome }}</span></div><p>{{ event.message }}<template v-if="event.durationMs != null"> · {{ event.durationMs.toFixed(1) }} ms</template></p><time>{{ new Date(event.createdAt).toLocaleString() }}</time></article></section>
      </section>

      <section v-else-if="isAuthenticated && activeView === 'system'" class="view system-view">
        <div class="view-heading"><div><p class="kicker">安全与兼容</p><h1>系统与协议</h1><p>只有当前官网协议通过只读观测和人工评审，真实提交才会启用。</p></div></div>
        <section class="module system-detail"><div class="protocol-state-line"><span class="status-dot" :class="protocol?.status"></span><div><small>当前状态</small><h2>{{ statusLabel }}</h2></div></div><dl><div><dt>协议配置</dt><dd>{{ protocol?.profileId ?? "尚未建立" }}</dd></div><div><dt>最近验证</dt><dd>{{ protocol?.verifiedAt ?? "从未验证" }}</dd></div><div><dt>官方时钟校准</dt><dd>{{ officialClockOffsetMs == null ? "预检时校准" : `${officialClockOffsetMs >= 0 ? "+" : ""}${officialClockOffsetMs} ms` }}</dd></div><div><dt>真实提交</dt><dd>{{ protocol?.submissionEnabled ? "已启用" : "已锁定" }}</dd></div></dl><p class="system-message">{{ protocol?.message }}</p></section>
        <section class="module boundaries"><h2>当前安全边界</h2><div><span>自动支付</span><strong>关闭</strong></div><div><span>候补订单</span><strong>首版不支持</strong></div><div><span>安全核验</span><strong>必须人工完成</strong></div><div><span>未知响应</span><strong>停止并核对订单</strong></div><div><span>系统通知（可选）</span><strong>{{ notificationSelfTestPassed ? "已测试" : "未测试" }}</strong></div><button class="quiet-action" @click="runNotificationSelfTest">测试系统通知（可选）</button><button class="quiet-action" @click="runStrongAlertTest">测试页面持续强提醒</button></section>
      </section>
    </main>
  </div>
</template>
