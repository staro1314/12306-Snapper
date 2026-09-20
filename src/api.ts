import { invoke } from "@tauri-apps/api/core";
import type { BrowserCapabilities, BrowserSessionStatus, CreateTaskInput, ExecutionEvent, OfficialPassenger, OrderReconciliationResult, OrderSnapshot, ProtocolStatus, RealOrderResult, RehearsalResult, RehearsalScenario, ScheduledRoute, TicketQueryResult, TicketTaskDetail, TicketTaskView } from "./contracts";

const inTauri = (): boolean => "__TAURI_INTERNALS__" in window;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `请求失败 (${response.status})`);
  return payload as T;
}

export async function getProtocolStatus(): Promise<ProtocolStatus> {
  return inTauri() ? invoke("get_protocol_status") : request("/protocol");
}

export async function listTasks(): Promise<TicketTaskView[]> {
  return inTauri() ? invoke("list_tasks") : request("/tasks");
}
export async function listOrderSnapshots(): Promise<OrderSnapshot[]> { return inTauri() ? invoke("list_order_snapshots") : request("/orders"); }
export async function reconcileOfficialOrders(): Promise<OrderReconciliationResult> { const response = await fetch("/browser/orders/reconcile", { method: "POST" }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "官方订单核对失败"); return payload as OrderReconciliationResult; }
export async function openOfficialOrders(): Promise<void> { const response = await fetch("/browser/orders/open", { method: "POST" }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "无法打开 12306 官方订单页"); }
export async function recordOrderResult(input: { taskId: string; officialOrderRef: string | null; status: OrderSnapshot["status"]; passengerRefs: string[]; paymentDeadline: string | null; partial?: boolean }): Promise<OrderSnapshot> { return inTauri() ? invoke("record_order_result", { input }) : request("/orders", { method: "POST", body: JSON.stringify(input) }); }

export async function createTask(input: CreateTaskInput): Promise<TicketTaskView> {
  return inTauri()
    ? invoke("create_task", { input })
    : request("/tasks", { method: "POST", body: JSON.stringify(input) });
}
export async function getTask(taskId: string): Promise<TicketTaskDetail> {
  return inTauri() ? invoke("get_task", { taskId }) : request(`/tasks/${encodeURIComponent(taskId)}`);
}
export async function updateTask(taskId: string, input: CreateTaskInput): Promise<TicketTaskView> {
  return inTauri() ? invoke("update_task", { taskId, input }) : request(`/tasks/${encodeURIComponent(taskId)}`, { method: "PUT", body: JSON.stringify(input) });
}

export async function runPreflight(taskId: string): Promise<TicketTaskView> {
  return inTauri()
    ? invoke("run_preflight", { taskId })
    : request(`/tasks/${encodeURIComponent(taskId)}/preflight`, { method: "POST" });
}
export async function armTask(taskId: string): Promise<TicketTaskView> { return inTauri() ? invoke("arm_task", { taskId }) : request(`/tasks/${encodeURIComponent(taskId)}/arm`, { method: "POST" }); }
export async function pauseTask(taskId: string): Promise<TicketTaskView> { return inTauri() ? invoke("pause_task", { taskId }) : request(`/tasks/${encodeURIComponent(taskId)}/pause`, { method: "POST" }); }
export async function beginTaskQuery(taskId: string): Promise<TicketTaskView> { return inTauri() ? invoke("begin_query", { taskId }) : request(`/tasks/${encodeURIComponent(taskId)}/query/start`, { method: "POST" }); }
export async function completeTaskQuery(taskId: string): Promise<TicketTaskView> { return inTauri() ? invoke("complete_query", { taskId }) : request(`/tasks/${encodeURIComponent(taskId)}/query/complete`, { method: "POST" }); }
export async function haltTask(taskId: string, status: "RATE_LIMITED" | "USER_ACTION_REQUIRED" | "INCOMPATIBLE" | "FAILED" | "UNKNOWN_RECONCILING", reason: string): Promise<TicketTaskView> { return inTauri() ? invoke("halt_task", { taskId, input: { status, reason } }) : request(`/tasks/${encodeURIComponent(taskId)}/halt`, { method: "POST", body: JSON.stringify({ status, reason }) }); }
export async function abandonTask(taskId: string): Promise<TicketTaskView> { return inTauri() ? invoke("abandon_task", { taskId }) : request(`/tasks/${encodeURIComponent(taskId)}/abandon`, { method: "POST" }); }
export async function beginOrder(taskId: string): Promise<TicketTaskView> { return inTauri() ? invoke("begin_order", { taskId }) : request(`/tasks/${encodeURIComponent(taskId)}/order/begin`, { method: "POST" }); }
export async function markOrderSubmitting(taskId: string): Promise<TicketTaskView> { return inTauri() ? invoke("mark_order_submitting", { taskId }) : request(`/tasks/${encodeURIComponent(taskId)}/order/submitting`, { method: "POST" }); }
export async function pauseAllAutomation(reason: string): Promise<TicketTaskView[]> { return inTauri() ? invoke("pause_all_automation", { reason }) : request("/safety/pause", { method: "POST", body: JSON.stringify({ reason }) }); }
export async function previewScheduledRoutes(now?: string): Promise<ScheduledRoute[]> { return inTauri() ? invoke("preview_query_batch", { now: now ?? null }) : request(`/scheduler/preview${now ? `?now=${encodeURIComponent(now)}` : ""}`); }

export async function deleteTask(taskId: string): Promise<void> {
  if (inTauri()) return invoke("delete_task", { taskId });
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
  if (!response.ok) { const payload = await response.json(); throw new Error(payload.error ?? "删除失败"); }
}
export async function runRehearsal(taskId: string, scenario: RehearsalScenario, availableCount?: number): Promise<RehearsalResult> {
  return inTauri() ? invoke("run_rehearsal", { taskId, input: { scenario, availableCount } }) : request(`/tasks/${encodeURIComponent(taskId)}/rehearsal`, { method: "POST", body: JSON.stringify({ scenario, availableCount }) });
}
export async function listEvents(taskId: string): Promise<ExecutionEvent[]> {
  return inTauri() ? invoke("list_events", { taskId }) : request(`/tasks/${encodeURIComponent(taskId)}/events`);
}
export async function recordRuntimeEvent(input: { taskId: string; routeGroupId?: string; stage: string; outcome: string; message: string; durationMs?: number }): Promise<ExecutionEvent> { return inTauri() ? invoke("record_execution_event", { input }) : request(`/tasks/${encodeURIComponent(input.taskId)}/events`, { method: "POST", body: JSON.stringify(input) }); }

export async function getBrowserSession(): Promise<BrowserSessionStatus> {
  const response = await fetch("/browser/status");
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "无法读取登录状态");
  return payload as BrowserSessionStatus;
}

export async function startBrowserSession(): Promise<BrowserSessionStatus> {
  const response = await fetch("/browser/start", { method: "POST" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "无法启动 12306 登录浏览器");
  return payload as BrowserSessionStatus;
}
export async function logoutBrowserSession(): Promise<BrowserSessionStatus> {
  const response = await fetch("/browser/logout", { method: "POST" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "退出 12306 失败");
  return payload as BrowserSessionStatus;
}
export async function syncPassengers(): Promise<OfficialPassenger[]> {
  const response = await fetch("/browser/observe/passengers-page", { method: "POST" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "无法同步乘车人");
  return payload.passengers as OfficialPassenger[];
}
export async function runOfficialPreflight(passengerRefs: string[]): Promise<void> { const response = await fetch("/browser/preflight", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passengerRefs }) }); const payload = await response.json(); if (!response.ok || payload.compatible !== true) throw new Error(payload.error ?? "12306 官方预检未通过"); }
export async function queryOfficialTickets(fromStation: string, toStation: string, travelDate: string): Promise<TicketQueryResult> {
  const response = await fetch("/browser/observe/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fromStation, toStation, travelDate }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "官方余票查询失败");
  return payload as TicketQueryResult;
}
export async function getBrowserCapabilities(): Promise<BrowserCapabilities> { const response = await fetch("/browser/capabilities"); return response.json(); }
export async function getOfficialClock(): Promise<{ source: "12306_OFFICIAL_READ_ONLY"; now: string | number | null }> { const response = await fetch("/browser/official-clock"); const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "无法读取 12306 官方时钟"); return payload; }
export async function getOfficialStations(): Promise<string[]> { const response = await fetch("/browser/stations"); const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "无法读取 12306 官方站点表"); return payload.stations as string[]; }
export async function getOfficialSaleTime(stationName: string): Promise<{ source: "12306_OFFICIAL_READ_ONLY"; stationName: string; saleTime: string }> { const response = await fetch("/browser/sale-time", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stationName }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "无法查询官方起售时间"); return payload; }
export async function initializeOfficialOrder(trainCode: string): Promise<void> { const response = await fetch("/browser/observe/order-initialize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trainCode, confirmObservation: true }) }); const payload = await response.json(); if (!response.ok || payload.currentPath !== "/otn/confirmPassenger/initDc") throw new Error(payload.error ?? "订单初始化未进入确认页面"); }
export async function validateOfficialOrderSetup(passengerRefs: string[], seatTypeLabel: string): Promise<void> { const response = await fetch("/browser/observe/order-ready", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passengerRefs, seatTypeLabel }) }); const payload = await response.json(); if (!response.ok || payload.compatible !== true) throw new Error(payload.error ?? "官方确认页订单参数校验失败"); }
export async function executeOfficialOrder(passengerRefs: string[], seatTypeLabel: string): Promise<RealOrderResult> { const response = await fetch("/browser/order/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passengerRefs, seatTypeLabel, confirmRealSubmission: true }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "真实订单提交失败"); return payload as RealOrderResult; }
