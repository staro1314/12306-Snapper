use std::{collections::{HashMap, HashSet}, sync::Arc, time::{Duration, Instant}};

use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::sync::Mutex;

use crate::{
    AppState,
    domain::{
        HaltTaskInput, OfficialOrderStatus, RecordExecutionEventInput,
        RecordOrderResultInput, ScheduledRoute, TaskStatus, TicketTask,
    },
};

const SIDECAR_BASE: &str = "http://127.0.0.1:3211";
const ROUTE_QUERY_INTERVAL: Duration = Duration::from_millis(5_100);

/// Server-owned scheduler. The browser page is intentionally not involved: background execution
/// must continue when the UI is hidden, throttled or reloaded, and only one account-wide order
/// executor may cross the real-submission boundary at a time.
pub struct AutomationRuntime {
    state: Arc<AppState>,
    client: reqwest::Client,
    order_lock: Mutex<()>,
    last_route_query: Mutex<HashMap<String, Instant>>,
    warmed_tasks: Mutex<HashSet<String>>,
}

impl AutomationRuntime {
    pub fn new(state: Arc<AppState>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(330))
            .build()
            .map_err(|error| format!("无法创建后台协议客户端: {error}"))?;
        Ok(Self {
            state,
            client,
            order_lock: Mutex::new(()),
            last_route_query: Mutex::new(HashMap::new()),
            warmed_tasks: Mutex::new(HashSet::new()),
        })
    }

    pub async fn run(self: Arc<Self>) {
        loop {
            self.state.mark_runtime_heartbeat(Utc::now());
            let official_now = self.official_now().await;
            if let Some(now) = official_now {
                self.prewarm_due_tasks(now).await;
                if let Ok(routes) = self.state.preview_query_batch_at(now) {
                    for route in routes {
                        if self.route_is_due(&route.route_group_id).await {
                            let runtime = self.clone();
                            tokio::spawn(async move { runtime.execute_route(route, now).await; });
                        }
                    }
                }
            }
            tokio::time::sleep(self.next_tick_delay(official_now)).await;
        }
    }

    async fn prewarm_due_tasks(&self, now: DateTime<Utc>) {
        let tasks = self.state.task_snapshot().into_iter().filter(|task| {
            task.status == TaskStatus::Armed
                && task.route_groups.iter().any(|route| {
                    let remaining = route.sale_time - now;
                    remaining.num_seconds() > 0 && remaining.num_minutes() <= 10
                })
        }).collect::<Vec<_>>();
        for task in tasks {
            if self.warmed_tasks.lock().await.contains(&task.id) { continue; }
            let route = task.route_groups.iter().min_by_key(|route| route.sale_time).cloned();
            let Some(route) = route else { continue; };
            let scheduled = ScheduledRoute {
                task_id: task.id.clone(), route_group_id: route.id.clone(), task_priority: task.priority,
                route_priority: route.priority, sale_time: route.sale_time, travel_date: route.travel_date,
                from_station: route.from_station, to_station: route.to_station,
                train_codes: route.train_codes, seat_types: route.seat_types,
            };
            self.event(&scheduled, "PREFLIGHT", "STARTED", "起售前 10 分钟后台预热：同步乘车人并检查登录、UAM 和冲突订单", None);
            let passenger_sync = self.post::<_, serde_json::Value>("/observe/passengers-page", &serde_json::json!({})).await;
            let refs = task.passengers.iter().map(|passenger| passenger.passenger_ref.clone()).collect::<Vec<_>>();
            let preflight = if passenger_sync.is_ok() {
                self.post::<_, serde_json::Value>("/preflight", &PreflightRequest { passenger_refs: &refs }).await
            } else {
                passenger_sync
            };
            match preflight {
                Ok(_) => {
                    self.warmed_tasks.lock().await.insert(task.id.clone());
                    self.event(&scheduled, "PREFLIGHT", "PASSED", "后台预热完成，官方会话与乘车人引用可用", None);
                }
                Err(error) => {
                    let status = if error.classification == "INCOMPATIBLE" { TaskStatus::Incompatible } else { TaskStatus::UserActionRequired };
                    let _ = self.state.halt_task(&task.id, HaltTaskInput { status, reason: error.message.clone() });
                    self.event(&scheduled, "PREFLIGHT", &error.classification, &error.message, None);
                }
            }
        }
    }

    async fn official_now(&self) -> Option<DateTime<Utc>> {
        let response = self.client.get(format!("{SIDECAR_BASE}/official-clock")).send().await.ok()?;
        let clock: OfficialClock = response.json().await.ok()?;
        match clock.now {
            serde_json::Value::Number(value) => value.as_i64().and_then(DateTime::<Utc>::from_timestamp_millis),
            serde_json::Value::String(value) => DateTime::parse_from_rfc3339(&value).ok().map(|value| value.with_timezone(&Utc)),
            _ => None,
        }
    }

    fn next_tick_delay(&self, official_now: Option<DateTime<Utc>>) -> Duration {
        let Some(now) = official_now else { return Duration::from_secs(1); };
        let remaining_ms = self.state.list_tasks().iter()
            .filter(|task| task.status == TaskStatus::Armed)
            .filter_map(|task| task.next_sale_time)
            .map(|sale| (sale - now).num_milliseconds())
            .min();
        match remaining_ms {
            Some(value) if value <= 1_000 => Duration::from_millis(25),
            Some(value) if value <= 10_000 => Duration::from_millis(100),
            _ => Duration::from_secs(1),
        }
    }

    async fn route_is_due(&self, route_id: &str) -> bool {
        let now = Instant::now();
        let mut last = self.last_route_query.lock().await;
        if last.get(route_id).is_some_and(|value| now.duration_since(*value) < ROUTE_QUERY_INTERVAL) {
            return false;
        }
        last.insert(route_id.to_owned(), now);
        true
    }

    async fn execute_route(self: Arc<Self>, route: ScheduledRoute, official_now: DateTime<Utc>) {
        let dispatch_error = (official_now - route.sale_time).num_milliseconds().max(0) as f64;
        self.event(&route, "SCHEDULER_DISPATCH", "STARTED", "Rust 后台起售调度已触发", Some(dispatch_error));
        if self.state.begin_query(&route.task_id).is_err() { return; }
        let started = Instant::now();
        let query = self.post::<_, TicketQueryResult>("/observe/query", &QueryRequest {
            from_station: &route.from_station,
            to_station: &route.to_station,
            travel_date: route.travel_date.to_string(),
        }).await;
        match query {
            Ok(result) if result.success == Some(true) => {
                self.event(&route, "QUERY_ROUND_TRIP", "PASSED", &format!("官方余票查询返回 {} 个车次", result.result_count.unwrap_or(0)), Some(started.elapsed().as_secs_f64() * 1000.0));
                let candidate = select_candidate(result.candidates.unwrap_or_default(), &route.train_codes, &route.seat_types);
                if let Some((candidate, seat, available)) = candidate {
                    self.event(&route, "CANDIDATE_DECISION", "SELECTED", &format!("按任务优先级选中 {} {seat}", candidate.train_code), None);
                    if let Err(error) = self.execute_order(&route, candidate, seat, available).await {
                        self.event(&route, "ORDER_EXECUTION", "FAILED", &error, None);
                    }
                } else {
                    self.event(&route, "CANDIDATE_DECISION", "NO_AVAILABILITY", "当前没有符合车次和席别优先级的余票", None);
                }
            }
            Ok(result) => self.halt_for_query(&route, result.classification.as_deref().unwrap_or("INCOMPATIBLE")),
            Err(error) => self.halt_for_query(&route, &error.classification),
        }
        if self.state.get_task(&route.task_id).is_ok_and(|task| task.status == TaskStatus::Querying) {
            let _ = self.state.complete_query(&route.task_id);
        }
    }

    fn halt_for_query(&self, route: &ScheduledRoute, classification: &str) {
        let status = match classification {
            "RATE_LIMITED" => TaskStatus::RateLimited,
            "USER_ACTION_REQUIRED" | "LOGIN_REQUIRED" => TaskStatus::UserActionRequired,
            _ => TaskStatus::Incompatible,
        };
        let reason = format!("官方查询安全停止：{classification}");
        let _ = self.state.halt_task(&route.task_id, HaltTaskInput { status, reason: reason.clone() });
        self.event(route, "QUERY_ROUND_TRIP", classification, &reason, None);
    }

    async fn execute_order(&self, route: &ScheduledRoute, candidate: TicketCandidate, seat: String, available: u16) -> Result<(), String> {
        let _guard = self.order_lock.lock().await;
        let task = self.state.get_task(&route.task_id)?;
        if !task.real_submission_authorized { return Err("任务未明确授权真实提交".into()); }
        if !self.state.protocol_status().submission_enabled { return Err("进程级真实提交门禁未启用".into()); }
        let plan = task.build_order_plan(available).map_err(|error| {
            let reason = error.to_string();
            let _ = self.state.halt_task(&task.id, HaltTaskInput { status: TaskStatus::UserActionRequired, reason: reason.clone() });
            reason
        })?;
        let segment_count = plan.segments.len();
        let mut successful = 0usize;
        for segment in plan.segments {
            self.state.begin_order(&task.id)?;
            let init_started = Instant::now();
            if let Err(error) = self.post::<_, serde_json::Value>("/observe/order-initialize", &InitializeOrderRequest {
                train_code: &candidate.train_code,
                confirm_observation: true,
            }).await {
                let status = if error.classification == "USER_ACTION_REQUIRED" { TaskStatus::UserActionRequired } else { TaskStatus::Incompatible };
                let _ = self.state.halt_task(&task.id, HaltTaskInput { status, reason: error.message.clone() });
                self.event(route, "ORDER_INITIALIZATION", &error.classification, &error.message, Some(init_started.elapsed().as_secs_f64() * 1000.0));
                return Err(error.message);
            }
            // The execute endpoint validates the current token, passengers, seat and ticket types
            // immediately before checkOrderInfo. Calling the read-only readiness endpoint here
            // would traverse the same DOM twice on the hot path.
            self.event(route, "ORDER_INITIALIZATION", "PASSED", "12306 已接受初始化并进入确认上下文", Some(init_started.elapsed().as_secs_f64() * 1000.0));
            self.state.mark_order_submitting(&task.id)?;
            let submit_started = Instant::now();
            self.event(route, "ORDER_SUBMISSION", "STARTED", "正在发送最终确认并等待官方排队结果", None);
            let result = self.post::<_, RealOrderResult>("/order/execute", &ExecuteOrderRequest {
                passenger_refs: &segment.passenger_refs,
                seat_type_label: &seat,
                confirm_real_submission: true,
            }).await;
            match result {
                Ok(result) if result.status == "PAYMENT_PENDING" => {
                    successful += 1;
                    self.state.record_order_result(RecordOrderResultInput {
                        task_id: task.id.clone(), official_order_ref: result.order_ref,
                        status: OfficialOrderStatus::PaymentPending,
                        passenger_refs: segment.passenger_refs,
                        payment_deadline: None, partial: successful < segment_count,
                    })?;
                    self.event(route, "ORDER_SUBMISSION", "PAYMENT_PENDING", "已确认真实待支付订单", Some(submit_started.elapsed().as_secs_f64() * 1000.0));
                }
                Ok(result) if result.status == "QUEUING" => {
                    self.state.mark_order_queuing(&task.id)?;
                    let t0_to_queue_ms = (Utc::now() - route.sale_time).num_milliseconds().max(0) as f64;
                    let confirm_rtt = result.queue_accepted_duration_ms.map(|value| format!("，最终确认往返 {value}ms")).unwrap_or_default();
                    self.event(route, "QUEUE_ACCEPTED", "QUEUING", &format!("12306 已接受排队请求{confirm_rtt}，后台继续监控结果"), Some(t0_to_queue_ms));
                    match self.wait_for_queue_result().await {
                        Ok(status) if status.status == "PAYMENT_PENDING" => {
                            successful += 1;
                            self.state.record_order_result(RecordOrderResultInput {
                                task_id: task.id.clone(), official_order_ref: status.order_ref,
                                status: OfficialOrderStatus::PaymentPending,
                                passenger_refs: segment.passenger_refs,
                                payment_deadline: None, partial: successful < segment_count,
                            })?;
                            self.event(route, "ORDER_SUBMISSION", "PAYMENT_PENDING", "官方排队完成，已确认真实待支付订单", Some(submit_started.elapsed().as_secs_f64() * 1000.0));
                        }
                        _ => {
                            self.reconcile_unknown(route, &task, segment.passenger_refs, successful > 0).await;
                            return Err("五分钟排队窗口结束，未确认待支付订单，已停止后续拆单".into());
                        }
                    }
                }
                Ok(result) => {
                    self.event(route, "ORDER_SUBMISSION", "INCOMPATIBLE", &format!("官方提交返回未知状态：{}", result.status), Some(submit_started.elapsed().as_secs_f64() * 1000.0));
                    self.reconcile_unknown(route, &task, segment.passenger_refs, successful > 0).await;
                    return Err("官方提交响应状态不兼容，已停止并核对订单".into());
                }
                Err(error) => {
                    self.event(route, "ORDER_SUBMISSION", &error.classification, &error.message, Some(submit_started.elapsed().as_secs_f64() * 1000.0));
                    self.reconcile_unknown(route, &task, segment.passenger_refs, successful > 0).await;
                    return Err(error.message);
                }
            }
        }
        Ok(())
    }

    async fn wait_for_queue_result(&self) -> Result<QueueStatus, SidecarError> {
        let deadline = Instant::now() + Duration::from_secs(305);
        loop {
            let response = self.client.get(format!("{SIDECAR_BASE}/order/queue-status")).send().await
                .map_err(|error| SidecarError::transport(error.to_string()))?;
            let status: QueueStatus = response.json().await.map_err(|error| SidecarError { classification: "INCOMPATIBLE".into(), message: format!("排队状态响应无法解析: {error}") })?;
            if status.status != "QUEUING" || Instant::now() >= deadline { return Ok(status); }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn reconcile_unknown(&self, route: &ScheduledRoute, task: &TicketTask, passenger_refs: Vec<String>, partial: bool) {
        self.event(route, "ORDER_RECONCILIATION", "STARTED", "提交结果未确认，正在核对官方未支付订单", None);
        let reconciliation = self.post::<_, OrderReconciliation>("/orders/reconcile", &serde_json::json!({})).await.ok();
        let matched = reconciliation.as_ref().and_then(|result| result.orders.iter().find(|order| passenger_refs.iter().all(|value| order.passenger_refs.contains(value))));
        let _ = self.state.record_order_result(RecordOrderResultInput {
            task_id: task.id.clone(), official_order_ref: matched.map(|order| order.order_ref.clone()),
            status: if matched.is_some() { OfficialOrderStatus::PaymentPending } else { OfficialOrderStatus::Unknown },
            passenger_refs, payment_deadline: matched.and_then(|order| order.payment_deadline), partial,
        });
        self.event(route, "ORDER_RECONCILIATION", if matched.is_some() { "PAYMENT_PENDING" } else { "UNKNOWN" }, if matched.is_some() { "已在官方订单中确认待支付订单" } else { "官方未支付订单中未确认本次订单，任务保持停止" }, None);
    }

    fn event(&self, route: &ScheduledRoute, stage: &str, outcome: &str, message: &str, duration_ms: Option<f64>) {
        let _ = self.state.record_execution_event(RecordExecutionEventInput {
            task_id: route.task_id.clone(), route_group_id: Some(route.route_group_id.clone()),
            stage: stage.into(), outcome: outcome.into(), message: message.into(), duration_ms,
        });
    }

    async fn post<I: Serialize + ?Sized, O: DeserializeOwned>(&self, path: &str, input: &I) -> Result<O, SidecarError> {
        let response = self.client.post(format!("{SIDECAR_BASE}{path}")).json(input).send().await
            .map_err(|error| SidecarError::transport(error.to_string()))?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|error| SidecarError::transport(error.to_string()))?;
        if status.is_success() {
            return serde_json::from_slice(&bytes).map_err(|error| SidecarError { classification: "INCOMPATIBLE".into(), message: format!("本地会话响应无法解析: {error}") });
        }
        let error: SidecarErrorBody = serde_json::from_slice(&bytes).unwrap_or_default();
        Err(SidecarError {
            classification: error.classification.unwrap_or_else(|| classify_status(status).into()),
            message: error.error.unwrap_or_else(|| format!("本地会话请求失败 ({status})")),
        })
    }
}

fn classify_status(status: StatusCode) -> &'static str {
    if status == StatusCode::CONFLICT || status == StatusCode::UNAUTHORIZED { "USER_ACTION_REQUIRED" } else { "INCOMPATIBLE" }
}

fn select_candidate(candidates: Vec<TicketCandidate>, trains: &[String], seats: &[String]) -> Option<(TicketCandidate, String, u16)> {
    for train in trains {
        if let Some(candidate) = candidates.iter().find(|candidate| candidate.train_code.eq_ignore_ascii_case(train) && candidate.can_book) {
            for seat in seats {
                let key = seat_key(seat);
                let value = candidate.seats.get(key).map(String::as_str).unwrap_or("");
                if let Some(count) = available_count(value) { return Some((candidate.clone(), seat.clone(), count)); }
            }
        }
    }
    None
}

fn seat_key(label: &str) -> &'static str {
    match label { "商务座" => "business", "特等座" | "一等座" => "firstClass", "二等座" => "secondClass", "高级软卧" => "premiumSoftSleeper", "软卧" => "softSleeper", "硬卧" => "hardSleeper", "软座" => "softSeat", "硬座" => "hardSeat", "无座" => "noSeat", _ => "other" }
}

fn available_count(value: &str) -> Option<u16> {
    match value.trim() {
        "" | "无" | "--" | "候补" => None,
        "有" => Some(5),
        value => value.parse::<u16>().ok().filter(|count| *count > 0),
    }
}

#[derive(Deserialize)] struct OfficialClock { now: serde_json::Value }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct QueryRequest<'a> { from_station: &'a str, to_station: &'a str, travel_date: String }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct InitializeOrderRequest<'a> { train_code: &'a str, confirm_observation: bool }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct ExecuteOrderRequest<'a> { passenger_refs: &'a [String], seat_type_label: &'a str, confirm_real_submission: bool }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct PreflightRequest<'a> { passenger_refs: &'a [String] }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct TicketQueryResult { success: Option<bool>, classification: Option<String>, result_count: Option<usize>, candidates: Option<Vec<TicketCandidate>> }
#[derive(Clone, Deserialize)] #[serde(rename_all = "camelCase")] struct TicketCandidate { train_code: String, can_book: bool, seats: HashMap<String, String> }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct RealOrderResult { status: String, order_ref: Option<String>, queue_accepted_duration_ms: Option<u64> }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct QueueStatus { status: String, order_ref: Option<String> }
#[derive(Default, Deserialize)] struct SidecarErrorBody { classification: Option<String>, error: Option<String> }
struct SidecarError { classification: String, message: String }
impl SidecarError { fn transport(message: String) -> Self { Self { classification: "USER_ACTION_REQUIRED".into(), message: format!("浏览器会话服务不可用: {message}") } } }
#[derive(Deserialize)] struct OrderReconciliation { #[serde(default)] orders: Vec<ReconciledOrder> }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct ReconciledOrder { order_ref: String, passenger_refs: Vec<String>, payment_deadline: Option<DateTime<Utc>> }

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(train: &str, second_class: &str) -> TicketCandidate {
        TicketCandidate {
            train_code: train.into(), can_book: true,
            seats: HashMap::from([("secondClass".into(), second_class.into()), ("firstClass".into(), "无".into())]),
        }
    }

    #[test]
    fn hot_path_selection_preserves_train_then_seat_priority() {
        let selected = select_candidate(
            vec![candidate("G2", "有"), candidate("G1", "2")],
            &["G1".into(), "G2".into()],
            &["一等座".into(), "二等座".into()],
        ).unwrap();
        assert_eq!(selected.0.train_code, "G1");
        assert_eq!(selected.1, "二等座");
        assert_eq!(selected.2, 2);
    }

    #[test]
    fn unavailable_and_waitlist_values_never_become_candidates() {
        for value in ["", "无", "--", "候补", "0"] { assert_eq!(available_count(value), None); }
        assert_eq!(available_count("有"), Some(5));
        assert_eq!(available_count("3"), Some(3));
    }
}
