mod app;
mod domain;
mod protocol;
mod runtime;
mod storage;
pub mod web;

pub use app::AppState;

use domain::{
    CreateTaskInput, ExecutionEvent, HaltTaskInput, OrderSnapshot, ProtocolStatusView, RecordExecutionEventInput, RecordOrderResultInput,
    RehearsalResult, RunRehearsalInput, ScheduledRoute, TicketTask, TicketTaskView,
};
use tauri::Manager;

#[tauri::command]
fn get_protocol_status(state: tauri::State<'_, AppState>) -> ProtocolStatusView {
    state.protocol_status()
}

#[tauri::command]
fn list_tasks(state: tauri::State<'_, AppState>) -> Vec<TicketTaskView> {
    state.list_tasks()
}
#[tauri::command]
fn preview_query_batch(state: tauri::State<'_, AppState>, now: Option<chrono::DateTime<chrono::Utc>>) -> Result<Vec<ScheduledRoute>, String> { state.preview_query_batch_at(now.unwrap_or_else(chrono::Utc::now)) }
#[tauri::command]
fn list_order_snapshots(state: tauri::State<'_, AppState>) -> Result<Vec<OrderSnapshot>, String> {
    state.list_order_snapshots()
}
#[tauri::command]
fn record_order_result(
    state: tauri::State<'_, AppState>,
    input: RecordOrderResultInput,
) -> Result<OrderSnapshot, String> {
    state.record_order_result(input)
}
#[tauri::command]
fn get_task(state: tauri::State<'_, AppState>, task_id: String) -> Result<TicketTask, String> {
    state.get_task(&task_id)
}

#[tauri::command]
fn create_task(
    state: tauri::State<'_, AppState>,
    input: CreateTaskInput,
) -> Result<TicketTaskView, String> {
    state.create_task(input)
}
#[tauri::command]
fn update_task(
    state: tauri::State<'_, AppState>,
    task_id: String,
    input: CreateTaskInput,
) -> Result<TicketTaskView, String> {
    state.update_task(&task_id, input)
}

#[tauri::command]
fn run_preflight(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<TicketTaskView, String> {
    state.run_preflight(&task_id)
}
#[tauri::command]
fn arm_task(state: tauri::State<'_, AppState>, task_id: String) -> Result<TicketTaskView, String> {
    state.arm_task(&task_id)
}
#[tauri::command]
fn pause_task(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<TicketTaskView, String> {
    state.pause_task(&task_id)
}
#[tauri::command]
fn begin_query(state: tauri::State<'_, AppState>, task_id: String) -> Result<TicketTaskView, String> { state.begin_query(&task_id) }
#[tauri::command]
fn complete_query(state: tauri::State<'_, AppState>, task_id: String) -> Result<TicketTaskView, String> { state.complete_query(&task_id) }
#[tauri::command]
fn halt_task(state: tauri::State<'_, AppState>, task_id: String, input: HaltTaskInput) -> Result<TicketTaskView, String> { state.halt_task(&task_id, input) }
#[tauri::command]
fn abandon_task(state: tauri::State<'_, AppState>, task_id: String) -> Result<TicketTaskView, String> { state.abandon_task(&task_id) }
#[tauri::command]
fn begin_order(state: tauri::State<'_, AppState>, task_id: String) -> Result<TicketTaskView, String> { state.begin_order(&task_id) }
#[tauri::command]
fn mark_order_submitting(state: tauri::State<'_, AppState>, task_id: String) -> Result<TicketTaskView, String> { state.mark_order_submitting(&task_id) }
#[tauri::command]
fn pause_all_automation(state: tauri::State<'_, AppState>, reason: String) -> Result<Vec<TicketTaskView>, String> { state.pause_all_automation(&reason) }
#[tauri::command]
fn delete_task(state: tauri::State<'_, AppState>, task_id: String) -> Result<(), String> {
    state.delete_task(&task_id)
}
#[tauri::command]
fn run_rehearsal(
    state: tauri::State<'_, AppState>,
    task_id: String,
    input: RunRehearsalInput,
) -> Result<RehearsalResult, String> {
    state.run_rehearsal(&task_id, input)
}
#[tauri::command]
fn list_events(
    state: tauri::State<'_, AppState>,
    task_id: String,
    limit: Option<usize>,
) -> Result<Vec<ExecutionEvent>, String> {
    state.list_events(&task_id, limit)
}
#[tauri::command]
fn record_execution_event(state: tauri::State<'_, AppState>, input: RecordExecutionEventInput) -> Result<ExecutionEvent, String> { state.record_execution_event(input) }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            std::fs::create_dir_all(&data_dir)?;
            let state = AppState::open(data_dir.join("fast-12306.db"))?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_protocol_status,
            list_tasks,
            preview_query_batch,
            list_order_snapshots,
            record_order_result,
            get_task,
            create_task,
            update_task,
            run_preflight,
            arm_task,
            pause_task,
            begin_query,
            complete_query,
            halt_task,
            abandon_task,
            begin_order,
            mark_order_submitting,
            pause_all_automation,
            delete_task,
            run_rehearsal,
            list_events,
            record_execution_event,
        ])
        .run(tauri::generate_context!())
        .expect("Fast 12306 desktop runtime failed");
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, NaiveDate, Utc};

    use crate::domain::{
        CreateTaskInput, HaltTaskInput, OfficialOrderStatus, PassengerSelection, RecordExecutionEventInput,
        RecordOrderResultInput, RouteGroup, TaskStatus, TicketCandidate, TicketTask, select_candidate,
        select_query_batch,
    };
    use crate::AppState;

    fn passenger(reference: &str, priority: u16) -> PassengerSelection {
        PassengerSelection {
            passenger_ref: reference.into(),
            display_name: "已脱敏乘车人".into(),
            ticket_type: "adult".into(),
            priority,
            verified: true,
        }
    }

    #[test]
    fn candidate_selection_obeys_complete_stable_priority() {
        let candidate = |task_priority, train_priority, code: &str| TicketCandidate {
            task_id: "task".into(),
            route_group_id: "route".into(),
            train_internal_ref: code.into(),
            train_code: code.into(),
            seat_type: "second".into(),
            available_count: 1,
            task_priority,
            route_priority: 1,
            date_priority: 1,
            train_priority,
            seat_priority: 1,
            task_created_sequence: 1,
        };
        let selected = select_candidate(&[candidate(2, 1, "G2"), candidate(1, 2, "G1")]).unwrap();
        assert_eq!(selected.train_code, "G1");
    }

    #[test]
    fn split_plan_is_ordered_and_requires_consent() {
        let passengers = vec![passenger("p2", 2), passenger("p1", 1), passenger("p3", 3)];
        let denied = crate::domain::OrderPlan::build("task", &passengers, 1, false);
        assert!(denied.is_err());
        let plan = crate::domain::OrderPlan::build("task", &passengers, 1, true).unwrap();
        assert_eq!(plan.segments.len(), 3);
        assert_eq!(plan.segments[0].passenger_refs, vec!["p1"]);
    }

    #[test]
    fn unknown_submission_state_cannot_jump_back_to_submit() {
        assert!(TaskStatus::OrderSubmitting.can_transition_to(TaskStatus::UnknownReconciling));
        assert!(!TaskStatus::UnknownReconciling.can_transition_to(TaskStatus::OrderSubmitting));
    }

    #[test]
    fn task_rejects_unverified_passengers() {
        let mut unverified = passenger("p1", 1);
        unverified.verified = false;
        let result = TicketTask::new("test".into(), 1, false, vec![unverified], vec![], None);
        assert!(result.is_err());
        let _now = Utc::now();
    }

    #[test]
    fn scheduler_limits_due_routes_and_preserves_priority() {
        let now = Utc::now();
        let make_task = |name: &str, priority: u16, route_priority: u16| {
            TicketTask::new(
                name.into(),
                priority,
                false,
                vec![passenger(name, 1)],
                vec![RouteGroup {
                    id: name.into(),
                    travel_date: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
                    from_station: "北京南".into(),
                    to_station: "上海虹桥".into(),
                    sale_time: now - Duration::seconds(1),
                    priority: route_priority,
                    train_codes: vec!["G1".into()],
                    seat_types: vec!["二等座".into()],
                }],
                None,
            )
            .unwrap()
        };
        let mut tasks = vec![
            make_task("third", 3, 1),
            make_task("first", 1, 2),
            make_task("second", 2, 1),
        ];
        for task in &mut tasks { task.status = TaskStatus::Armed; }
        let batch = select_query_batch(&tasks, now);
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[0].task_priority, 1);
        assert_eq!(batch[1].task_priority, 2);
    }

    #[test]
    fn restart_clears_only_obsolete_notification_gate_failures() {
        let database_path = std::env::temp_dir().join(format!("fast-12306-notification-gate-{}.db", uuid::Uuid::new_v4()));
        let task_id;
        {
            let state = AppState::open(database_path.clone()).unwrap();
            task_id = state.create_task(CreateTaskInput {
                name: "notification migration".into(),
                priority: 1,
                split_authorized: false,
                real_submission_authorized: false,
                passengers: vec![passenger("p1", 1)],
                route_groups: vec![RouteGroup {
                    id: "r1".into(),
                    travel_date: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
                    from_station: "北京南".into(),
                    to_station: "上海虹桥".into(),
                    sale_time: Utc::now() + Duration::hours(1),
                    priority: 1,
                    train_codes: vec!["G1".into()],
                    seat_types: vec!["二等座".into()],
                }],
                deadline: None,
            }).unwrap().id;
            state.halt_task(&task_id, HaltTaskInput {
                status: TaskStatus::UserActionRequired,
                reason: "Error: 请先在“系统与协议”运行并确认本机通知自检".into(),
            }).unwrap();
        }
        let recovered = AppState::open(database_path.clone()).unwrap();
        let task = recovered.get_task(&task_id).unwrap();
        assert_eq!(task.status, TaskStatus::Draft);
        assert_eq!(task.failure_reason, None);
        let _ = std::fs::remove_file(database_path);
    }

    #[test]
    fn execution_log_query_returns_newest_events_with_a_bounded_limit() {
        let path = std::env::temp_dir().join(format!("fast-12306-event-limit-{}.db", uuid::Uuid::new_v4()));
        let state = AppState::open(path.clone()).unwrap();
        let task = state.create_task(CreateTaskInput {
            name: "日志测试".into(), priority: 1, split_authorized: false,
            real_submission_authorized: false, passengers: vec![passenger("p1", 1)],
            route_groups: vec![RouteGroup {
                id: "r1".into(),
                travel_date: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
                from_station: "北京南".into(),
                to_station: "上海虹桥".into(),
                sale_time: Utc::now() + Duration::hours(1),
                priority: 1,
                train_codes: vec!["G1".into()],
                seat_types: vec!["二等座".into()],
            }], deadline: None,
        }).unwrap();
        for message in ["第一条", "第二条", "第三条"] {
            state.record_execution_event(RecordExecutionEventInput {
                task_id: task.id.clone(), route_group_id: None, stage: "TASK_START".into(),
                outcome: "STARTED".into(), message: message.into(), duration_ms: None,
            }).unwrap();
        }
        let events = state.list_events(&task.id, Some(2)).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].message, "第三条");
        assert_eq!(events[1].message, "第二条");
        drop(state);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn official_order_is_atomic_and_freezes_conflicting_tasks_after_reload() {
        let database_path = std::env::temp_dir().join(format!("fast-12306-test-{}.db", uuid::Uuid::new_v4()));
        let route = || RouteGroup {
            id: uuid::Uuid::new_v4().to_string(),
            travel_date: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
            from_station: "北京南".into(),
            to_station: "上海虹桥".into(),
            sale_time: Utc::now() - Duration::seconds(1),
            priority: 1,
            train_codes: vec!["G1".into()],
            seat_types: vec!["二等座".into()],
        };
        let first_id;
        let second_id;
        {
            let state = AppState::open(database_path.clone()).unwrap();
            first_id = state.create_task(CreateTaskInput { name: "first".into(), priority: 1, split_authorized: false, real_submission_authorized: false, passengers: vec![passenger("shared", 1)], route_groups: vec![route()], deadline: None }).unwrap().id;
            second_id = state.create_task(CreateTaskInput { name: "second".into(), priority: 2, split_authorized: false, real_submission_authorized: false, passengers: vec![passenger("shared", 1)], route_groups: vec![route()], deadline: None }).unwrap().id;
            state.run_preflight(&first_id).unwrap();
            state.run_preflight(&second_id).unwrap();
            state.arm_task(&first_id).unwrap();
            state.arm_task(&second_id).unwrap();
            state.begin_query(&first_id).unwrap();
            state.record_order_result(RecordOrderResultInput { task_id: first_id.clone(), official_order_ref: Some("o_safe".into()), status: OfficialOrderStatus::PaymentPending, passenger_refs: vec!["shared".into()], payment_deadline: None, partial: false }).unwrap();
        }
        {
            let reloaded = AppState::open(database_path.clone()).unwrap();
            assert_eq!(reloaded.get_task(&first_id).unwrap().status, TaskStatus::PaymentPending);
            assert_eq!(reloaded.get_task(&second_id).unwrap().status, TaskStatus::UserActionRequired);
            let orders = reloaded.list_order_snapshots().unwrap();
            assert_eq!(orders.len(), 1);
            assert_eq!(orders[0].official_order_ref.as_deref(), Some("o_safe"));
        }
        let _ = std::fs::remove_file(database_path);
    }

    #[test]
    fn restart_converts_inflight_order_to_unknown_reconciliation() {
        let database_path = std::env::temp_dir().join(format!("fast-12306-recovery-{}.db", uuid::Uuid::new_v4()));
        let task_id;
        {
            let state = AppState::open(database_path.clone()).unwrap();
            task_id = state.create_task(CreateTaskInput {
                name: "recovery".into(), priority: 1, split_authorized: false, real_submission_authorized: false,
                passengers: vec![passenger("p1", 1)],
                route_groups: vec![RouteGroup { id: "r1".into(), travel_date: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(), from_station: "北京南".into(), to_station: "上海虹桥".into(), sale_time: Utc::now() - Duration::seconds(1), priority: 1, train_codes: vec!["G1".into()], seat_types: vec!["二等座".into()] }],
                deadline: None,
            }).unwrap().id;
            state.run_preflight(&task_id).unwrap();
            state.arm_task(&task_id).unwrap();
            state.begin_query(&task_id).unwrap();
            state.begin_order(&task_id).unwrap();
            assert_eq!(state.get_task(&task_id).unwrap().status, TaskStatus::OrderInitializing);
        }
        let recovered = AppState::open(database_path.clone()).unwrap();
        assert_eq!(recovered.get_task(&task_id).unwrap().status, TaskStatus::UnknownReconciling);
        let _ = std::fs::remove_file(database_path);
    }

    #[test]
    fn failed_later_split_preserves_partial_payment_pending_state() {
        let database_path = std::env::temp_dir().join(format!("fast-12306-partial-{}.db", uuid::Uuid::new_v4()));
        let state = AppState::open(database_path.clone()).unwrap();
        let task_id = state.create_task(CreateTaskInput {
            name: "partial".into(), priority: 1, split_authorized: true, real_submission_authorized: false,
            passengers: vec![passenger("p1", 1), passenger("p2", 2)], deadline: None,
            route_groups: vec![RouteGroup { id: "r1".into(), travel_date: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(), from_station: "北京南".into(), to_station: "上海虹桥".into(), sale_time: Utc::now() - Duration::seconds(1), priority: 1, train_codes: vec!["G1".into()], seat_types: vec!["二等座".into()] }],
        }).unwrap().id;
        state.run_preflight(&task_id).unwrap(); state.arm_task(&task_id).unwrap(); state.begin_query(&task_id).unwrap(); state.begin_order(&task_id).unwrap(); state.mark_order_submitting(&task_id).unwrap();
        state.record_order_result(RecordOrderResultInput { task_id: task_id.clone(), official_order_ref: Some("o_first".into()), status: OfficialOrderStatus::PaymentPending, passenger_refs: vec!["p1".into()], payment_deadline: None, partial: true }).unwrap();
        state.begin_order(&task_id).unwrap(); state.mark_order_submitting(&task_id).unwrap();
        state.record_order_result(RecordOrderResultInput { task_id: task_id.clone(), official_order_ref: None, status: OfficialOrderStatus::Unknown, passenger_refs: vec!["p2".into()], payment_deadline: None, partial: true }).unwrap();
        assert_eq!(state.get_task(&task_id).unwrap().status, TaskStatus::PartialPaymentPending);
        drop(state); let _ = std::fs::remove_file(database_path);
    }

    #[test]
    fn overdue_armed_task_is_expired_before_query_selection() {
        let database_path = std::env::temp_dir().join(format!("fast-12306-expiry-{}.db", uuid::Uuid::new_v4()));
        let state = AppState::open(database_path.clone()).unwrap();
        let task_id = state.create_task(CreateTaskInput {
            name: "expired".into(), priority: 1, split_authorized: false, real_submission_authorized: false, passengers: vec![passenger("p1", 1)],
            route_groups: vec![RouteGroup { id: "r1".into(), travel_date: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(), from_station: "北京南".into(), to_station: "上海虹桥".into(), sale_time: Utc::now() - Duration::minutes(2), priority: 1, train_codes: vec!["G1".into()], seat_types: vec!["二等座".into()] }],
            deadline: Some(Utc::now() - Duration::minutes(1)),
        }).unwrap().id;
        state.run_preflight(&task_id).unwrap(); state.arm_task(&task_id).unwrap();
        assert!(state.preview_query_batch().unwrap().is_empty());
        assert_eq!(state.get_task(&task_id).unwrap().status, TaskStatus::Expired);
        drop(state); let _ = std::fs::remove_file(database_path);
    }

    #[test]
    fn global_safety_pause_reconciles_inflight_orders_and_stops_other_tasks() {
        let database_path = std::env::temp_dir().join(format!("fast-12306-safety-pause-{}.db", uuid::Uuid::new_v4()));
        let state = AppState::open(database_path.clone()).unwrap();
        let route = |id: &str| RouteGroup {
            id: id.into(),
            travel_date: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
            from_station: "北京南".into(),
            to_station: "上海虹桥".into(),
            sale_time: Utc::now() - Duration::seconds(1),
            priority: 1,
            train_codes: vec!["G1".into()],
            seat_types: vec!["二等座".into()],
        };
        let inflight_id = state.create_task(CreateTaskInput {
            name: "inflight".into(), priority: 1, split_authorized: false, real_submission_authorized: false,
            passengers: vec![passenger("p1", 1)], route_groups: vec![route("r1")], deadline: None,
        }).unwrap().id;
        let armed_id = state.create_task(CreateTaskInput {
            name: "armed".into(), priority: 2, split_authorized: false, real_submission_authorized: false,
            passengers: vec![passenger("p2", 1)], route_groups: vec![route("r2")], deadline: None,
        }).unwrap().id;
        for task_id in [&inflight_id, &armed_id] {
            state.run_preflight(task_id).unwrap();
            state.arm_task(task_id).unwrap();
        }
        state.begin_query(&inflight_id).unwrap();
        state.begin_order(&inflight_id).unwrap();

        state.pause_all_automation("登录核验触发，已安全停止").unwrap();

        let inflight = state.get_task(&inflight_id).unwrap();
        let armed = state.get_task(&armed_id).unwrap();
        assert_eq!(inflight.status, TaskStatus::UnknownReconciling);
        assert_eq!(armed.status, TaskStatus::UserActionRequired);
        assert_eq!(inflight.failure_reason.as_deref(), Some("登录核验触发，已安全停止"));
        drop(state);
        let _ = std::fs::remove_file(database_path);
    }

    #[test]
    fn stopped_task_can_be_deleted_but_order_task_is_protected() {
        let database_path = std::env::temp_dir().join(format!("fast-12306-delete-{}.db", uuid::Uuid::new_v4()));
        let state = AppState::open(database_path.clone()).unwrap();
        let create = |name: &str, passenger_ref: &str| CreateTaskInput {
            name: name.into(), priority: 1, split_authorized: false, real_submission_authorized: false,
            passengers: vec![passenger(passenger_ref, 1)], deadline: None,
            route_groups: vec![RouteGroup {
                id: uuid::Uuid::new_v4().to_string(),
                travel_date: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
                from_station: "北京南".into(), to_station: "上海虹桥".into(),
                sale_time: Utc::now() - Duration::seconds(1), priority: 1,
                train_codes: vec!["G1".into()], seat_types: vec!["二等座".into()],
            }],
        };
        let stopped_id = state.create_task(create("stopped", "p-stopped")).unwrap().id;
        state.halt_task(&stopped_id, HaltTaskInput { status: TaskStatus::UserActionRequired, reason: "manual stop".into() }).unwrap();
        state.delete_task(&stopped_id).unwrap();
        assert!(state.get_task(&stopped_id).is_err());

        let order_id = state.create_task(create("order", "p-order")).unwrap().id;
        state.run_preflight(&order_id).unwrap();
        state.arm_task(&order_id).unwrap();
        state.begin_query(&order_id).unwrap();
        state.record_order_result(RecordOrderResultInput {
            task_id: order_id.clone(), official_order_ref: Some("protected-order".into()),
            status: OfficialOrderStatus::PaymentPending, passenger_refs: vec!["p-order".into()],
            payment_deadline: None, partial: false,
        }).unwrap();
        assert!(state.delete_task(&order_id).is_err());
        assert_eq!(state.list_order_snapshots().unwrap().len(), 1);
        state.abandon_task(&order_id).unwrap();
        state.delete_task(&order_id).unwrap();
        assert_eq!(state.list_order_snapshots().unwrap().len(), 1);
        drop(state);
        let _ = std::fs::remove_file(database_path);
    }

    #[test]
    fn real_submission_authorization_is_explicit_and_persisted() {
        let database_path = std::env::temp_dir().join(format!("fast-12306-real-consent-{}.db", uuid::Uuid::new_v4()));
        let task_id;
        {
            let state = AppState::open(database_path.clone()).unwrap();
            let view = state.create_task(CreateTaskInput {
                name: "authorized".into(), priority: 1, split_authorized: false,
                real_submission_authorized: true,
                passengers: vec![passenger("p-authorized", 1)],
                route_groups: vec![RouteGroup {
                    id: "authorized-route".into(),
                    travel_date: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
                    from_station: "北京南".into(), to_station: "上海虹桥".into(),
                    sale_time: Utc::now() + Duration::minutes(10), priority: 1,
                    train_codes: vec!["G1".into()], seat_types: vec!["二等座".into()],
                }],
                deadline: None,
            }).unwrap();
            task_id = view.id.clone();
            assert!(view.real_submission_authorized);
            assert!(state.get_task(&task_id).unwrap().real_submission_authorized);
        }
        let restored = AppState::open(database_path.clone()).unwrap();
        assert!(restored.get_task(&task_id).unwrap().real_submission_authorized);
        drop(restored);
        let _ = std::fs::remove_file(database_path);
    }
}
