use std::{collections::{HashMap, HashSet}, sync::Arc, time::{Duration, Instant}};

use chrono::{DateTime, FixedOffset, NaiveDateTime, TimeZone, Utc};
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
const PREWARM_MINIMUM_LEAD_SECONDS: i64 = 60;

/// Server-owned scheduler. The browser page is intentionally not involved: background execution
/// must continue when the UI is hidden, throttled or reloaded, and only one account-wide order
/// executor may cross the real-submission boundary at a time.
pub struct AutomationRuntime {
    state: Arc<AppState>,
    client: reqwest::Client,
    order_lock: Mutex<()>,
    /// The sidecar owns one Playwright page and one mutable `latestQuery` context. Keep each
    /// background query-to-order attempt atomic with respect to other scheduler tasks.
    page_lock: Mutex<()>,
    last_route_query: Mutex<HashMap<String, Instant>>,
    warmed_routes: Mutex<HashSet<String>>,
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
            page_lock: Mutex::new(()),
            last_route_query: Mutex::new(HashMap::new()),
            warmed_routes: Mutex::new(HashSet::new()),
        })
    }

    pub async fn run(self: Arc<Self>) {
        let heartbeat_state = self.state.clone();
        tokio::spawn(async move {
            loop {
                heartbeat_state.mark_runtime_heartbeat(Utc::now());
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
        loop {
            let official_now = self.official_now().await;
            if let Some(now) = official_now {
                self.prewarm_due_tasks(now).await;
                // Avoid accumulating blocked route workers while the account is in its official
                // five-minute queue window. No other route should use the shared page then.
                if self.order_lock.try_lock().is_ok() {
                    if let Ok(routes) = self.state.preview_query_batch_at(now) {
                        for route in routes {
                            if self.route_is_due(&route.route_group_id).await {
                                let runtime = self.clone();
                                tokio::spawn(async move { runtime.execute_route(route, now).await; });
                            }
                        }
                    }
                }
            }
            tokio::time::sleep(self.next_tick_delay(official_now)).await;
        }
    }

    async fn prewarm_due_tasks(&self, now: DateTime<Utc>) {
        let tasks = self.state.task_snapshot();
        // A read-only probe can wait for an official response. Never start one in the
        // final minute of any armed route's sale window; last-minute tasks may still
        // prewarm between T-10m and T-60s.
        if tasks.iter().filter(|task| task.status == TaskStatus::Armed)
            .flat_map(|task| &task.route_groups)
            .any(|route| {
                let seconds = (route.sale_time - now).num_seconds();
                (0..=PREWARM_MINIMUM_LEAD_SECONDS).contains(&seconds)
            }) {
            return;
        }
        let tasks = tasks.into_iter().filter(|task| task.status == TaskStatus::Armed &&
            task.route_groups.iter().any(|route| (PREWARM_MINIMUM_LEAD_SECONDS..=600)
                .contains(&(route.sale_time - now).num_seconds()))).collect::<Vec<_>>();
        if tasks.is_empty() { return; }
        // Best effort acquisition: a live order or query has priority over read-only probes.
        let Ok(_page_guard) = self.page_lock.try_lock() else { return; };
        for task in tasks {
            let routes = task.route_groups.iter().filter(|route| (PREWARM_MINIMUM_LEAD_SECONDS..=600)
                .contains(&(route.sale_time - now).num_seconds()))
                .map(|route| ScheduledRoute {
                    task_id: task.id.clone(), route_group_id: route.id.clone(), task_priority: task.priority,
                    route_priority: route.priority, sale_time: route.sale_time, travel_date: route.travel_date,
                    from_station: route.from_station.clone(), to_station: route.to_station.clone(),
                    train_codes: route.train_codes.clone(), seat_types: route.seat_types.clone(),
                }).collect::<Vec<_>>();
            let warmed = self.warmed_routes.lock().await;
            let routes = routes.into_iter().filter(|route| prewarm_key(&task, &route.route_group_id)
                .is_none_or(|key| !warmed.contains(&key))).collect::<Vec<_>>();
            drop(warmed);
            let Some(first_route) = routes.first() else { continue; };
            self.event(first_route, "PREFLIGHT", "STARTED", "起售前预热：重新同步官方乘车人，检查会话、核验、冲突订单，再逐路线验证真实余票查询", None);
            let passenger_sync = self.post::<_, serde_json::Value>("/observe/passengers-page", &serde_json::json!({})).await;
            let refs = task.passengers.iter().map(|passenger| passenger.passenger_ref.clone()).collect::<Vec<_>>();
            let preflight = if passenger_sync.is_ok() {
                self.post::<_, serde_json::Value>("/preflight", &PreflightRequest { passenger_refs: &refs }).await
            } else {
                passenger_sync
            };
            match preflight {
                Ok(_) => {
                    self.event(first_route, "PREFLIGHT", "PASSED", "官方会话、乘车人引用、未完成订单状态与查询页已验证；开始验证各路线余票查询", None);
                }
                Err(error) => {
                    let status = if error.classification == "INCOMPATIBLE" { TaskStatus::Incompatible } else { TaskStatus::UserActionRequired };
                    let _ = self.state.halt_task(&task.id, HaltTaskInput { status, reason: error.message.clone() });
                    self.event(first_route, "PREFLIGHT", &error.classification, &error.message, None);
                    continue;
                }
            }
            for route in routes {
                let Some(current_time) = self.official_now().await else { break; };
                if self.state.task_snapshot().iter().filter(|task| task.status == TaskStatus::Armed)
                    .flat_map(|task| &task.route_groups)
                    .any(|candidate| {
                        let seconds = (candidate.sale_time - current_time).num_seconds();
                        (0..=PREWARM_MINIMUM_LEAD_SECONDS).contains(&seconds)
                    }) { break; }
                self.event(&route, "PREFLIGHT_QUERY", "STARTED", "向官方发起本路线只读余票查询，验证会话、站点、请求链路及响应解析；不初始化订单", None);
                let started = Instant::now();
                let result = self.post::<_, TicketQueryResult>("/observe/query", &QueryRequest {
                    task_id: &route.task_id, route_group_id: &route.route_group_id,
                    from_station: &route.from_station, to_station: &route.to_station,
                    travel_date: route.travel_date.to_string(),
                }).await;
                match result {
                    Ok(query) if query.success == Some(true) && query.query_id.is_some() => {
                        if let Some(key) = prewarm_key(&task, &route.route_group_id) {
                            self.warmed_routes.lock().await.insert(key);
                        }
                        self.event(&route, "PREFLIGHT_QUERY", "PASSED", &format!("官方只读查询链路已验证，返回 {} 个车次；订单初始化、乘车人确认和排队须在起售后验证", query.result_count.unwrap_or(0)), Some(started.elapsed().as_secs_f64() * 1000.0));
                    }
                    Ok(query) => {
                        let classification = query.classification.as_deref().unwrap_or("INCOMPATIBLE");
                        let status = if classification == "RATE_LIMITED" { TaskStatus::RateLimited } else if classification == "USER_ACTION_REQUIRED" { TaskStatus::UserActionRequired } else { TaskStatus::Incompatible };
                        let reason = format!("起售前官方余票查询预热未通过：{classification}");
                        let _ = self.state.halt_task(&task.id, HaltTaskInput { status, reason: reason.clone() });
                        self.event(&route, "PREFLIGHT_QUERY", classification, &reason, Some(started.elapsed().as_secs_f64() * 1000.0));
                        break;
                    }
                    Err(error) => {
                        let status = if error.classification == "RATE_LIMITED" { TaskStatus::RateLimited } else if error.classification == "USER_ACTION_REQUIRED" { TaskStatus::UserActionRequired } else { TaskStatus::Incompatible };
                        let reason = format!("起售前官方余票查询预热未通过：{}", error.message);
                        let _ = self.state.halt_task(&task.id, HaltTaskInput { status, reason: reason.clone() });
                        self.event(&route, "PREFLIGHT_QUERY", &error.classification, &reason, Some(started.elapsed().as_secs_f64() * 1000.0));
                        break;
                    }
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

    async fn execute_route(self: Arc<Self>, route: ScheduledRoute, scheduled_official_now: DateTime<Utc>) {
        let t0_instant = monotonic_t0(route.sale_time, scheduled_official_now);
        // Search, passenger-page prewarm, and order initialization all mutate the same official
        // Playwright page. Hold this lock from the first query through queue reconciliation so a
        // second route cannot replace `latestQuery` or navigate away from the confirmation page.
        // FIFO serialization lets another due route run after this one instead of starving it;
        // the dispatcher stops creating new workers while an order owns the account lock.
        let _page_guard = self.page_lock.lock().await;
        let official_now = self.official_now().await.unwrap_or_else(|| Utc::now());
        let dispatch_error = (official_now - route.sale_time).num_milliseconds().max(0) as f64;
        self.event(&route, "SCHEDULER_DISPATCH", "STARTED", &format!("起售调度触发：{} {}→{}，目标车次 {} 个、席别 {} 个；相对官方起售时刻延迟 {dispatch_error:.0}ms", route.travel_date, route.from_station, route.to_station, route.train_codes.len(), route.seat_types.len()), Some(dispatch_error));
        let current_task = self.state.get_task(&route.task_id).ok();
        let warm_key = current_task.as_ref().and_then(|task| prewarm_key(task, &route.route_group_id));
        let is_warm = match warm_key {
            Some(key) => self.warmed_routes.lock().await.contains(&key),
            None => false,
        };
        if !is_warm {
            // Tasks created shortly before sale may have completed the interactive startup
            // preflight without reaching this background T-10m pass. Keep the opportunity to
            // query, but never describe the background warm-up as completed. Submission still
            // crosses the fresh official page/security/passenger checks in the sidecar.
            self.event(&route, "PREFLIGHT", "NOT_READY", "本路线未完成后台预热；继续本轮实时查询，提交前仍须通过官方页面及乘车人校验", None);
        }
        if self.state.begin_query(&route.task_id).is_err() { return; }
        let started = Instant::now();
        self.event(&route, "QUERY_REQUEST", "STARTED", &format!("已向本地官方会话发起 {} {}→{} 的查询操作；等待浏览器实际发送", route.travel_date, route.from_station, route.to_station), None);
        let query = self.post::<_, TicketQueryResult>("/observe/query", &QueryRequest {
            task_id: &route.task_id,
            route_group_id: &route.route_group_id,
            from_station: &route.from_station,
            to_station: &route.to_station,
            travel_date: route.travel_date.to_string(),
        }).await;
        match query {
            Ok(result) if result.success == Some(true) => {
                self.event(&route, "QUERY_ROUND_TRIP", "PASSED", &format!("12306 余票响应已解析：返回 {} 个车次，本任务关注 {} 个车次", result.result_count.unwrap_or(0), route.train_codes.len()), Some(started.elapsed().as_secs_f64() * 1000.0));
                let Some(query_id) = result.query_id else {
                    self.halt_for_query(&route, "QUERY_CONTEXT_MISSING");
                    return;
                };
                let candidate = select_candidate(result.candidates.unwrap_or_default(), &route.train_codes, &route.seat_types);
                if let Some((candidate, seat, available)) = candidate {
                    self.event(&route, "CANDIDATE_DECISION", "SELECTED", &format!("按配置优先级选中 {} / {}，官方余票表示可订；进入账号级订单锁", candidate.train_code, seat), None);
                    if let Err(error) = self.execute_order(&route, candidate, seat, available, &query_id, t0_instant).await {
                        self.event(&route, "ORDER_EXECUTION", "FAILED", &error, None);
                    }
                } else {
                    self.event(&route, "CANDIDATE_DECISION", "NO_AVAILABILITY", &format!("本轮未命中：所选 {} 个车次、{} 个席别均无可订组合；至少 5.1 秒后再查", route.train_codes.len(), route.seat_types.len()), None);
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

    async fn execute_order(&self, route: &ScheduledRoute, candidate: TicketCandidate, seat: String, available: u16, query_id: &str, t0_instant: Instant) -> Result<(), String> {
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
        self.event(route, "ORDER_PLAN", "PASSED", &format!("订单计划已确认：{} 名乘车人，{} 个子订单，提交全局串行", task.passengers.len(), segment_count), None);
        let mut successful = 0usize;
        for segment in plan.segments {
            self.state.begin_order(&task.id)?;
            let init_started = Instant::now();
            self.event(route, "ORDER_INITIALIZATION", "STARTED", &format!("正在初始化 {} / {} 的官方订单上下文", candidate.train_code, seat), None);
            if let Err(error) = self.post::<_, serde_json::Value>("/observe/order-initialize", &InitializeOrderRequest {
                task_id: &task.id,
                route_group_id: &route.route_group_id,
                train_code: &candidate.train_code,
                query_id,
                confirm_observation: true,
            }).await {
                let status = if error.classification == "USER_ACTION_REQUIRED" { TaskStatus::UserActionRequired } else { TaskStatus::Incompatible };
                let _ = self.state.halt_task(&task.id, HaltTaskInput { status, reason: error.message.clone() });
                self.event(route, "ORDER_INITIALIZATION", &error.classification, &error.message, Some(init_started.elapsed().as_secs_f64() * 1000.0));
                return Err(error.message);
            }
            self.event(route, "ORDER_INITIALIZATION", "PASSED", "12306 已接受初始化并进入确认上下文", Some(init_started.elapsed().as_secs_f64() * 1000.0));
            // The official passenger list appears only after order initialization. The execute
            // endpoint waits for it and selects passengers once; a separate read-only call here
            // would repeat the same DOM work on the time-critical post-sale path.
            self.state.mark_order_submitting(&task.id)?;
            let submit_started = Instant::now();
            self.event(route, "ORDER_SUBMISSION", "STARTED", "已进入官方确认页自动操作；尚未证明最终排队请求已发出", None);
            let result = self.post::<_, RealOrderResult>("/order/execute", &ExecuteOrderRequest {
                task_id: &task.id,
                route_group_id: &route.route_group_id,
                passenger_refs: &segment.passenger_refs,
                seat_type_label: &seat,
                confirm_real_submission: true,
            }).await;
            match result {
                Ok(result) if result.status == "PAYMENT_PENDING" => {
                    self.confirm_submitted_order(route, &task, segment.passenger_refs, result.order_ref.as_deref(), successful, segment_count).await?;
                    successful += 1;
                    self.event(route, "ORDER_SUBMISSION", "PAYMENT_PENDING", "官方未支付订单已完成自动核对", Some(submit_started.elapsed().as_secs_f64() * 1000.0));
                }
                Ok(result) if result.status == "QUEUING" => {
                    self.state.mark_order_queuing(&task.id)?;
                    let t0_to_queue_ms = Instant::now().saturating_duration_since(t0_instant).as_secs_f64() * 1000.0;
                    let confirm_rtt = result.queue_accepted_duration_ms.map(|value| format!("，最终确认往返 {value}ms")).unwrap_or_default();
                    self.event(route, "QUEUE_ACCEPTED", "QUEUING", &format!("12306 已接受排队请求{confirm_rtt}，后台继续监控结果"), Some(t0_to_queue_ms));
                    self.event(route, "QUEUE_MONITOR", "STARTED", "已进入官方排队监控窗口，最多等待 5 分钟；期间不会重复提交", None);
                    match self.wait_for_queue_result().await {
                        Ok(status) if status.status == "PAYMENT_PENDING" => {
                            self.confirm_submitted_order(route, &task, segment.passenger_refs, status.order_ref.as_deref(), successful, segment_count).await?;
                            successful += 1;
                            self.event(route, "ORDER_SUBMISSION", "PAYMENT_PENDING", "官方排队完成，未支付订单已完成自动核对", Some(submit_started.elapsed().as_secs_f64() * 1000.0));
                        }
                        _ => {
                            self.reconcile_unknown(route, &task, segment.passenger_refs, successful > 0).await;
                            return Err("五分钟排队窗口结束，未确认待支付订单，已停止后续拆单".into());
                        }
                    }
                }
                Ok(result) if result.status == "DIRECT_ACCEPTED" => {
                    self.event(route, "ORDER_SUBMISSION", "DIRECT_ACCEPTED", "12306 已接受最终确认且未进入异步排队；正在核对官方待支付订单", Some(submit_started.elapsed().as_secs_f64() * 1000.0));
                    self.event(route, "ORDER_RECONCILIATION", "STARTED", "直接处理完成，正在自动查询 12306 未支付订单", None);
                    let mut matched = None;
                    for attempt in 0..5 {
                        if attempt > 0 { tokio::time::sleep(Duration::from_secs(1)).await; }
                        matched = self.find_matching_pending_order(&segment.passenger_refs, None).await;
                        if matched.is_some() { break; }
                    }
                    if let Some(order) = matched {
                        successful += 1;
                        self.state.record_order_result(RecordOrderResultInput {
                            task_id: task.id.clone(), official_order_ref: Some(order.order_ref),
                            status: OfficialOrderStatus::PaymentPending,
                            passenger_refs: segment.passenger_refs,
                            payment_deadline: order.payment_deadline, partial: successful < segment_count,
                        })?;
                        self.event(route, "ORDER_RECONCILIATION", "PAYMENT_PENDING", "已核实本次乘车人的唯一未支付订单", None);
                        self.event(route, "ORDER_SUBMISSION", "PAYMENT_PENDING", "已在官方订单中确认真实待支付订单", Some(submit_started.elapsed().as_secs_f64() * 1000.0));
                    } else {
                        self.reconcile_unknown(route, &task, segment.passenger_refs, successful > 0).await;
                        return Err("12306 已接受直接处理，但未确认待支付订单；已停止后续提交".into());
                    }
                }
                Ok(result) => {
                    self.event(route, "ORDER_SUBMISSION", "INCOMPATIBLE", &format!("官方提交返回未知状态：{}", result.status), Some(submit_started.elapsed().as_secs_f64() * 1000.0));
                    self.reconcile_unknown(route, &task, segment.passenger_refs, successful > 0).await;
                    return Err("官方提交响应状态不兼容，已停止并核对订单".into());
                }
                Err(error) => {
                    self.event(route, "ORDER_SUBMISSION", &error.classification, &error.message, Some(submit_started.elapsed().as_secs_f64() * 1000.0));
                    if error.submission_attempted == Some(false) {
                        let status = if error.classification.starts_with("PASSENGER_") || error.classification == "USER_ACTION_REQUIRED" {
                            TaskStatus::UserActionRequired
                        } else {
                            TaskStatus::Incompatible
                        };
                        let _ = self.state.halt_task(&task.id, HaltTaskInput { status, reason: error.message.clone() });
                        self.event(route, "ORDER_SUBMISSION", "NOT_SUBMITTED", "确认页操作未通过，尚未点击最终确认，任务已安全停止", None);
                        return Err(error.message);
                    }
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
            let status: QueueStatus = response.json().await.map_err(|error| SidecarError { classification: "INCOMPATIBLE".into(), message: format!("排队状态响应无法解析: {error}"), submission_attempted: None })?;
            if status.status != "QUEUING" || Instant::now() >= deadline { return Ok(status); }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn confirm_submitted_order(&self, route: &ScheduledRoute, task: &TicketTask, passenger_refs: Vec<String>, expected_ref: Option<&str>, successful: usize, segment_count: usize) -> Result<(), String> {
        self.event(route, "ORDER_RECONCILIATION", "STARTED", "提交已完成，正在自动查询 12306 未支付订单并核对本次乘车人及订单", None);
        let mut matched = None;
        // The sidecar must supply the exact order reference before either branch can claim
        // success. A passenger-only match here could attribute an unrelated manual order.
        if expected_ref.is_some() {
            for attempt in 0..5 {
                if attempt > 0 { tokio::time::sleep(Duration::from_secs(1)).await; }
                let started = Instant::now();
                match self.query_matching_pending_order(&passenger_refs, expected_ref).await {
                    Ok((_, Some(order))) => {
                        matched = Some(order);
                        break;
                    }
                    Ok((classification, None)) => self.event(route, "ORDER_RECONCILIATION", "WAITING", &format!("第 {}/5 次查单未匹配本次订单；官方结果：{classification}", attempt + 1), Some(started.elapsed().as_secs_f64() * 1000.0)),
                    Err(error) => self.event(route, "ORDER_RECONCILIATION", "WAITING", &format!("第 {}/5 次查单未完成；分类：{}", attempt + 1, error.classification), Some(started.elapsed().as_secs_f64() * 1000.0)),
                }
            }
        }
        if let Some(order) = matched {
            self.state.record_order_result(RecordOrderResultInput {
                task_id: task.id.clone(), official_order_ref: Some(order.order_ref),
                status: OfficialOrderStatus::PaymentPending, passenger_refs,
                payment_deadline: order.payment_deadline, partial: successful + 1 < segment_count,
            })?;
            self.event(route, "ORDER_RECONCILIATION", "PAYMENT_PENDING", "已核实本次订单存在于 12306 未支付订单，任务转为待支付", None);
            return Ok(());
        }
        self.state.record_order_result(RecordOrderResultInput {
            task_id: task.id.clone(), official_order_ref: expected_ref.map(str::to_owned),
            status: OfficialOrderStatus::Unknown, passenger_refs,
            payment_deadline: None, partial: successful > 0,
        })?;
        self.event(route, "ORDER_RECONCILIATION", "UNKNOWN", "自动核对未确认本次待支付订单；任务已停止，不会重复提交或显示成功", None);
        Err("提交后自动核对未确认本次待支付订单；已停止后续提交".into())
    }

    async fn reconcile_unknown(&self, route: &ScheduledRoute, task: &TicketTask, passenger_refs: Vec<String>, partial: bool) {
        self.event(route, "ORDER_RECONCILIATION", "STARTED", "提交结果未确认，正在核对官方未支付订单", None);
        let matched = self.find_matching_pending_order(&passenger_refs, None).await;
        let order_found = matched.is_some();
        let _ = self.state.record_order_result(RecordOrderResultInput {
            task_id: task.id.clone(), official_order_ref: matched.as_ref().map(|order| order.order_ref.clone()),
            status: if order_found { OfficialOrderStatus::PaymentPending } else { OfficialOrderStatus::Unknown },
            passenger_refs, payment_deadline: matched.and_then(|order| order.payment_deadline), partial,
        });
        self.event(route, "ORDER_RECONCILIATION", if order_found { "PAYMENT_PENDING" } else { "UNKNOWN" }, if order_found { "已在官方订单中确认待支付订单" } else { "官方未支付订单中未确认本次订单，任务保持停止" }, None);
    }

    async fn find_matching_pending_order(&self, passenger_refs: &[String], expected_ref: Option<&str>) -> Option<ReconciledOrder> {
        self.query_matching_pending_order(passenger_refs, expected_ref).await.ok()?.1
    }

    async fn query_matching_pending_order(&self, passenger_refs: &[String], expected_ref: Option<&str>) -> Result<(String, Option<ReconciledOrder>), SidecarError> {
        let reconciliation = self.post::<_, OrderReconciliation>("/orders/reconcile", &serde_json::json!({})).await?;
        let classification = reconciliation.classification.clone();
        Ok((classification, unique_matching_pending_order(reconciliation, passenger_refs, expected_ref)))
    }

    fn event(&self, route: &ScheduledRoute, stage: &str, outcome: &str, message: &str, duration_ms: Option<f64>) {
        let _ = self.state.record_execution_event(RecordExecutionEventInput {
            task_id: route.task_id.clone(), route_group_id: Some(route.route_group_id.clone()),
            stage: stage.into(), outcome: outcome.into(), message: message.into(), duration_ms,
            observed_at: None,
        });
    }

    async fn post<I: Serialize + ?Sized, O: DeserializeOwned>(&self, path: &str, input: &I) -> Result<O, SidecarError> {
        let response = self.client.post(format!("{SIDECAR_BASE}{path}")).json(input).send().await
            .map_err(|error| SidecarError::transport(error.to_string()))?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|error| SidecarError::transport(error.to_string()))?;
        if status.is_success() {
            return serde_json::from_slice(&bytes).map_err(|error| SidecarError { classification: "INCOMPATIBLE".into(), message: format!("本地会话响应无法解析: {error}"), submission_attempted: None });
        }
        let error: SidecarErrorBody = serde_json::from_slice(&bytes).unwrap_or_default();
        Err(SidecarError {
            classification: error.classification.unwrap_or_else(|| classify_status(status).into()),
            message: error.error.unwrap_or_else(|| format!("本地会话请求失败 ({status})")),
            submission_attempted: error.submission_attempted,
        })
    }
}

/// Convert the official wall-clock sale time to a monotonic instant once. This keeps the
/// T0-to-queue metric from being skewed by later system-clock adjustments.
fn prewarm_key(task: &TicketTask, route_id: &str) -> Option<String> {
    let route = task.route_groups.iter().find(|route| route.id == route_id)?;
    let passengers = task.passengers.iter().map(|passenger| &passenger.passenger_ref).collect::<Vec<_>>();
    serde_json::to_string(&(
        &task.id, &route.id, route.sale_time, route.travel_date,
        &route.from_station, &route.to_station, &route.train_codes, &route.seat_types,
        passengers,
    )).ok()
}

fn monotonic_t0(sale_time: DateTime<Utc>, official_now: DateTime<Utc>) -> Instant {
    let now = Instant::now();
    let offset_ms = (sale_time - official_now).num_milliseconds();
    if offset_ms >= 0 {
        now + Duration::from_millis(offset_ms as u64)
    } else {
        now.checked_sub(Duration::from_millis(offset_ms.unsigned_abs())).unwrap_or(now)
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
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct QueryRequest<'a> { task_id: &'a str, route_group_id: &'a str, from_station: &'a str, to_station: &'a str, travel_date: String }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct InitializeOrderRequest<'a> { task_id: &'a str, route_group_id: &'a str, train_code: &'a str, query_id: &'a str, confirm_observation: bool }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct ExecuteOrderRequest<'a> { task_id: &'a str, route_group_id: &'a str, passenger_refs: &'a [String], seat_type_label: &'a str, confirm_real_submission: bool }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct PreflightRequest<'a> { passenger_refs: &'a [String] }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct TicketQueryResult { success: Option<bool>, classification: Option<String>, result_count: Option<usize>, query_id: Option<String>, candidates: Option<Vec<TicketCandidate>> }
#[derive(Clone, Deserialize)] #[serde(rename_all = "camelCase")] struct TicketCandidate { train_code: String, can_book: bool, seats: HashMap<String, String> }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct RealOrderResult { status: String, order_ref: Option<String>, queue_accepted_duration_ms: Option<u64> }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct QueueStatus { status: String, order_ref: Option<String> }
#[derive(Default, Deserialize)] #[serde(rename_all = "camelCase")] struct SidecarErrorBody { classification: Option<String>, error: Option<String>, submission_attempted: Option<bool> }
struct SidecarError { classification: String, message: String, submission_attempted: Option<bool> }
impl SidecarError { fn transport(message: String) -> Self { Self { classification: "USER_ACTION_REQUIRED".into(), message: format!("浏览器会话服务不可用: {message}"), submission_attempted: None } } }
#[derive(Deserialize)] struct OrderReconciliation { classification: String, #[serde(default)] orders: Vec<ReconciledOrder> }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct ReconciledOrder {
    order_ref: String,
    status: String,
    passenger_refs: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_official_deadline")]
    payment_deadline: Option<DateTime<Utc>>,
}

// 12306 may return a local wall-clock deadline rather than RFC 3339. A missing or unfamiliar
// deadline must not discard an otherwise verifiable official order; the UI omits the deadline.
fn deserialize_official_deadline<'de, D>(deserializer: D) -> Result<Option<DateTime<Utc>>, D::Error>
where D: serde::Deserializer<'de> {
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    let Some(serde_json::Value::String(value)) = value else { return Ok(None); };
    if let Ok(parsed) = DateTime::parse_from_rfc3339(&value) { return Ok(Some(parsed.with_timezone(&Utc))); }
    let local = NaiveDateTime::parse_from_str(&value, "%Y-%m-%d %H:%M:%S").ok();
    let china = FixedOffset::east_opt(8 * 3600).expect("China standard time offset is valid");
    Ok(local.and_then(|date| china.from_local_datetime(&date).single()).map(|date| date.with_timezone(&Utc)))
}

fn unique_matching_pending_order(reconciliation: OrderReconciliation, passenger_refs: &[String], expected_ref: Option<&str>) -> Option<ReconciledOrder> {
    if reconciliation.classification != "PAYMENT_PENDING" || passenger_refs.is_empty() { return None; }
    let mut matches = reconciliation.orders.into_iter().filter(|order| {
        order.status == "PAYMENT_PENDING"
            && expected_ref.is_none_or(|reference| order.order_ref == reference)
            && order.passenger_refs.len() == passenger_refs.len()
            && passenger_refs.iter().all(|reference| order.passenger_refs.contains(reference))
    });
    let one = matches.next()?;
    if matches.next().is_some() { return None; }
    Some(one)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{PassengerSelection, RouteGroup};

    #[test]
    fn route_prewarm_becomes_invalid_after_passenger_or_route_edit() {
        let route = RouteGroup {
            id: "route-1".into(),
            travel_date: chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap(),
            from_station: "驻马店西".into(), to_station: "深圳北".into(),
            sale_time: Utc::now() + chrono::Duration::minutes(10), priority: 1,
            train_codes: vec!["G933".into()], seat_types: vec!["二等座".into()],
        };
        let mut task = TicketTask::new("返程".into(), 1, false, vec![PassengerSelection {
            passenger_ref: "p_a".into(), display_name: "张*".into(), ticket_type: "adult".into(),
            priority: 1, verified: true,
        }], vec![route], None).unwrap();
        let original = prewarm_key(&task, "route-1").unwrap();
        task.passengers[0].passenger_ref = "p_b".into();
        assert_ne!(original, prewarm_key(&task, "route-1").unwrap());
        task.passengers[0].passenger_ref = "p_a".into();
        task.route_groups[0].train_codes = vec!["G999".into()];
        assert_ne!(original, prewarm_key(&task, "route-1").unwrap());
    }

    #[test]
    fn monotonic_sale_deadline_uses_the_official_clock_offset() {
        let official_now = Utc::now();
        let future = monotonic_t0(official_now + chrono::Duration::seconds(3), official_now);
        let future_offset = future.saturating_duration_since(Instant::now()).as_secs_f64();
        assert!((2.8..=3.1).contains(&future_offset));

        let past = monotonic_t0(official_now - chrono::Duration::seconds(3), official_now);
        let elapsed = Instant::now().saturating_duration_since(past).as_secs_f64();
        assert!((2.8..=3.1).contains(&elapsed));
    }

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

    fn pending_order(reference: &str, passengers: &[&str]) -> ReconciledOrder {
        ReconciledOrder {
            order_ref: reference.into(), status: "PAYMENT_PENDING".into(),
            passenger_refs: passengers.iter().map(|value| (*value).into()).collect(),
            payment_deadline: None,
        }
    }

    #[test]
    fn automatic_reconciliation_requires_exact_order_and_passengers() {
        let response = OrderReconciliation {
            classification: "PAYMENT_PENDING".into(),
            orders: vec![pending_order("other", &["p1"]), pending_order("expected", &["p1"])],
        };
        assert_eq!(unique_matching_pending_order(response, &["p1".into()], Some("expected")).unwrap().order_ref, "expected");
        assert!(unique_matching_pending_order(OrderReconciliation {
            classification: "PAYMENT_PENDING".into(), orders: vec![pending_order("other", &["p1"])],
        }, &["p1".into()], Some("expected")).is_none());
        assert!(unique_matching_pending_order(OrderReconciliation {
            classification: "PAYMENT_PENDING".into(), orders: vec![pending_order("expected", &["p1", "p2"])],
        }, &["p1".into()], Some("expected")).is_none());
    }

    #[test]
    fn ambiguous_or_unconfirmed_orders_never_pass_reconciliation() {
        assert!(unique_matching_pending_order(OrderReconciliation {
            classification: "UNKNOWN_STRUCTURE".into(), orders: vec![pending_order("expected", &["p1"])],
        }, &["p1".into()], Some("expected")).is_none());
        assert!(unique_matching_pending_order(OrderReconciliation {
            classification: "PAYMENT_PENDING".into(), orders: vec![pending_order("one", &["p1"]), pending_order("two", &["p1"])],
        }, &["p1".into()], None).is_none());
    }

    #[test]
    fn official_local_deadline_does_not_invalidate_order_reconciliation() {
        let response: OrderReconciliation = serde_json::from_value(serde_json::json!({
            "classification": "PAYMENT_PENDING",
            "orders": [{
                "orderRef": "expected", "status": "PAYMENT_PENDING",
                "passengerRefs": ["p1"], "paymentDeadline": "2026-09-24 15:30:00"
            }]
        })).unwrap();
        let order = unique_matching_pending_order(response, &["p1".into()], Some("expected")).unwrap();
        assert_eq!(order.payment_deadline.unwrap().to_rfc3339(), "2026-09-24T07:30:00+00:00");
    }
}
