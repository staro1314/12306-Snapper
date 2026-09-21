use std::{path::PathBuf, sync::Arc};

use chrono::Utc;
use parking_lot::{Mutex, RwLock};

use crate::{
    domain::{
        CreateTaskInput, ExecutionEvent, HaltTaskInput, OfficialOrderStatus, OrderSnapshot, ProtocolStatusView,
        RecordExecutionEventInput, RecordOrderResultInput, RehearsalResult, RehearsalScenario, RunRehearsalInput,
        ScheduledRoute, TaskStatus, TicketTask, TicketTaskView, select_query_batch,
    },
    protocol::{ObservedReadOnlyProtocolAdapter, RailwayProtocolAdapter},
    storage::TaskRepository,
};

/// Shared application service. The submission mutex is account-wide by design; future protocol
/// adapters must acquire it for the entire initialize-submit-reconcile critical section.
pub struct AppState {
    repository: Mutex<TaskRepository>,
    tasks: RwLock<Vec<TicketTask>>,
    protocol: Arc<dyn RailwayProtocolAdapter>,
    pub submission_lock: Mutex<()>,
}

impl AppState {
    pub fn open(database_path: PathBuf) -> Result<Self, String> {
        let repository = TaskRepository::open(&database_path)?;
        let mut tasks = repository.list()?;
        for task in &mut tasks {
            if matches!(task.status, TaskStatus::CandidateSelected | TaskStatus::OrderInitializing | TaskStatus::OrderSubmitting | TaskStatus::Queuing) {
                task.status = TaskStatus::UnknownReconciling;
                task.failure_reason = Some("程序在订单执行阶段中断，恢复前必须先核对官方订单".into());
                repository.save(task)?;
            } else if task.status == TaskStatus::Querying {
                task.status = TaskStatus::Armed;
                repository.save(task)?;
            }
        }
        Ok(Self {
            repository: Mutex::new(repository),
            tasks: RwLock::new(tasks),
            protocol: Arc::new(ObservedReadOnlyProtocolAdapter),
            submission_lock: Mutex::new(()),
        })
    }

    pub fn protocol_status(&self) -> ProtocolStatusView {
        self.protocol.compatibility_status()
    }

    pub fn create_task(&self, input: CreateTaskInput) -> Result<TicketTaskView, String> {
        let real_submission_authorized = input.real_submission_authorized;
        let task = TicketTask::new(
            input.name,
            input.priority,
            input.split_authorized,
            input.passengers,
            input.route_groups,
            input.deadline,
        )?;
        let mut task = task;
        task.real_submission_authorized = real_submission_authorized;
        self.repository.lock().save(&task)?;
        let view = TicketTaskView::from(&task);
        self.tasks.write().push(task);
        Ok(view)
    }

    pub fn list_tasks(&self) -> Vec<TicketTaskView> {
        self.tasks.read().iter().map(TicketTaskView::from).collect()
    }

    pub fn get_task(&self, task_id: &str) -> Result<TicketTask, String> {
        self.tasks
            .read()
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or_else(|| "任务不存在".into())
    }

    pub fn preview_query_batch(&self) -> Result<Vec<ScheduledRoute>, String> {
        self.preview_query_batch_at(Utc::now())
    }

    pub fn preview_query_batch_at(&self, now: chrono::DateTime<Utc>) -> Result<Vec<ScheduledRoute>, String> {
        let mut tasks = self.tasks.write();
        for task in tasks.iter_mut().filter(|task| task.status == TaskStatus::Armed && task.deadline.is_some_and(|deadline| deadline <= now)) {
            task.status = TaskStatus::Expired;
            task.failure_reason = Some("任务已到截止时间，系统已停止新的余票查询".into());
            self.repository.lock().save(task)?;
        }
        Ok(select_query_batch(&tasks, now))
    }

    pub fn update_task(
        &self,
        task_id: &str,
        input: CreateTaskInput,
    ) -> Result<TicketTaskView, String> {
        let mut tasks = self.tasks.write();
        let task = tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or("任务不存在")?;
        task.apply_update(input)?;
        self.repository.lock().save(task)?;
        Ok(TicketTaskView::from(&*task))
    }

    pub fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let mut tasks = self.tasks.write();
        let index = tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or("任务不存在")?;
        if !matches!(
            tasks[index].status,
            TaskStatus::Draft
                | TaskStatus::Incompatible
                | TaskStatus::Failed
                | TaskStatus::UserActionRequired
                | TaskStatus::RateLimited
                | TaskStatus::Cancelled
        ) {
            return Err("请先放弃任务；订单提交或核对中的任务不能删除".into());
        }
        self.repository.lock().delete(task_id)?;
        tasks.remove(index);
        Ok(())
    }

    pub fn list_events(&self, task_id: &str) -> Result<Vec<ExecutionEvent>, String> {
        self.repository.lock().list_events(task_id)
    }

    pub fn record_execution_event(&self, input: RecordExecutionEventInput) -> Result<ExecutionEvent, String> {
        if !self.tasks.read().iter().any(|task| task.id == input.task_id) { return Err("任务不存在".into()); }
        if input.stage.len() > 64 || input.outcome.len() > 64 || input.message.len() > 240 { return Err("执行记录字段过长".into()); }
        let event = ExecutionEvent::official_runtime(input);
        self.repository.lock().save_events(std::slice::from_ref(&event))?;
        Ok(event)
    }

    pub fn list_order_snapshots(&self) -> Result<Vec<OrderSnapshot>, String> {
        self.repository.lock().list_order_snapshots()
    }

    pub fn record_order_result(
        &self,
        input: RecordOrderResultInput,
    ) -> Result<OrderSnapshot, String> {
        if input.passenger_refs.is_empty() {
            return Err("订单结果缺少乘车人".into());
        }
        let mut tasks = self.tasks.write();
        let task = tasks
            .iter_mut()
            .find(|task| task.id == input.task_id)
            .ok_or("任务不存在")?;
        if !matches!(task.status, TaskStatus::Querying | TaskStatus::CandidateSelected | TaskStatus::OrderInitializing | TaskStatus::OrderSubmitting | TaskStatus::Queuing | TaskStatus::UnknownReconciling | TaskStatus::PartialPaymentPending | TaskStatus::PaymentPending) {
            return Err("当前任务状态不允许写入真实订单结果".into());
        }
        task.status = match input.status {
            OfficialOrderStatus::PaymentPending if input.partial => TaskStatus::PartialPaymentPending,
            OfficialOrderStatus::PaymentPending => TaskStatus::PaymentPending,
            OfficialOrderStatus::Paid => TaskStatus::Paid,
            OfficialOrderStatus::Cancelled => TaskStatus::Cancelled,
            OfficialOrderStatus::Expired => TaskStatus::Expired,
            OfficialOrderStatus::Unknown if input.partial => TaskStatus::PartialPaymentPending,
            OfficialOrderStatus::Unknown => TaskStatus::UnknownReconciling,
        };
        task.failure_reason = if input.status == OfficialOrderStatus::Unknown {
            Some(if input.partial { "已有部分乘车人生成待支付订单，当前子订单结果未知；已停止后续拆单" } else { "提交结果未知，必须先核对官方订单" }.into())
        } else {
            None
        };
        let snapshot = OrderSnapshot {
            local_id: uuid::Uuid::new_v4().to_string(),
            task_id: input.task_id,
            official_order_ref: input.official_order_ref,
            status: input.status,
            passenger_refs: input.passenger_refs,
            payment_deadline: input.payment_deadline,
            last_reconciled_at: Utc::now(),
            source: "12306_OFFICIAL".into(),
        };
        let mut affected_task_ids = vec![task.id.clone()];
        if matches!(input.status, OfficialOrderStatus::PaymentPending | OfficialOrderStatus::Paid) {
            let protected_refs = &snapshot.passenger_refs;
            for conflict in tasks.iter_mut().filter(|candidate| {
                candidate.id != snapshot.task_id
                    && !matches!(candidate.status, TaskStatus::PaymentPending | TaskStatus::PartialPaymentPending | TaskStatus::Paid | TaskStatus::Cancelled | TaskStatus::Expired | TaskStatus::Failed)
                    && candidate.passengers.iter().any(|passenger| protected_refs.contains(&passenger.passenger_ref))
            }) {
                conflict.status = TaskStatus::UserActionRequired;
                conflict.failure_reason = Some("相同乘车人已生成待支付订单，冲突任务已停止".into());
                affected_task_ids.push(conflict.id.clone());
            }
        }
        let affected_tasks = tasks.iter().filter(|candidate| affected_task_ids.contains(&candidate.id)).cloned().collect::<Vec<_>>();
        self.repository.lock().save_order_result_atomic(&affected_tasks, &snapshot)?;
        Ok(snapshot)
    }

    pub fn arm_task(&self, task_id: &str) -> Result<TicketTaskView, String> {
        let mut tasks = self.tasks.write();
        let task = tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or("任务不存在")?;
        task.transition(TaskStatus::Armed)?;
        self.repository.lock().save(task)?;
        Ok(TicketTaskView::from(&*task))
    }

    pub fn pause_task(&self, task_id: &str) -> Result<TicketTaskView, String> {
        let mut tasks = self.tasks.write();
        let task = tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or("任务不存在")?;
        task.transition(TaskStatus::Ready)?;
        self.repository.lock().save(task)?;
        Ok(TicketTaskView::from(&*task))
    }

    pub fn begin_query(&self, task_id: &str) -> Result<TicketTaskView, String> {
        let mut tasks = self.tasks.write();
        let task = tasks.iter_mut().find(|task| task.id == task_id).ok_or("任务不存在")?;
        task.transition(TaskStatus::Querying)?;
        // Querying itself cannot create an order. Keep this hot-path transition in memory;
        // complete_query persists ARMED, while a process restart safely reloads the prior ARMED state.
        Ok(TicketTaskView::from(&*task))
    }

    pub fn complete_query(&self, task_id: &str) -> Result<TicketTaskView, String> {
        let mut tasks = self.tasks.write();
        let task = tasks.iter_mut().find(|task| task.id == task_id).ok_or("任务不存在")?;
        task.transition(TaskStatus::Armed)?;
        self.repository.lock().save(task)?;
        Ok(TicketTaskView::from(&*task))
    }

    pub fn halt_task(&self, task_id: &str, input: HaltTaskInput) -> Result<TicketTaskView, String> {
        if !matches!(input.status, TaskStatus::RateLimited | TaskStatus::UserActionRequired | TaskStatus::Incompatible | TaskStatus::Failed | TaskStatus::UnknownReconciling) {
            return Err("只能将任务停止到安全异常状态".into());
        }
        let mut tasks = self.tasks.write();
        let task = tasks.iter_mut().find(|task| task.id == task_id).ok_or("任务不存在")?;
        task.status = input.status;
        task.failure_reason = Some(input.reason.chars().take(180).collect());
        self.repository.lock().save(task)?;
        Ok(TicketTaskView::from(&*task))
    }

    pub fn abandon_task(&self, task_id: &str) -> Result<TicketTaskView, String> {
        let mut tasks = self.tasks.write();
        let task = tasks.iter_mut().find(|task| task.id == task_id).ok_or("任务不存在")?;
        if matches!(task.status, TaskStatus::CandidateSelected | TaskStatus::OrderInitializing | TaskStatus::OrderSubmitting | TaskStatus::Queuing | TaskStatus::UnknownReconciling) {
            return Err("订单结果核对中，不能放弃任务；请先完成官方订单核对".into());
        }
        task.status = TaskStatus::Cancelled;
        task.failure_reason = Some("用户已放弃本地任务；已有官方订单不会被取消".into());
        self.repository.lock().save(task)?;
        Ok(TicketTaskView::from(&*task))
    }

    pub fn pause_all_automation(&self, reason: &str) -> Result<Vec<TicketTaskView>, String> {
        let mut tasks = self.tasks.write();
        for task in tasks.iter_mut().filter(|task| matches!(task.status, TaskStatus::Ready | TaskStatus::Armed | TaskStatus::Querying | TaskStatus::CandidateSelected | TaskStatus::OrderInitializing | TaskStatus::OrderSubmitting | TaskStatus::Queuing)) {
            task.status = if matches!(task.status, TaskStatus::CandidateSelected | TaskStatus::OrderInitializing | TaskStatus::OrderSubmitting | TaskStatus::Queuing) { TaskStatus::UnknownReconciling } else { TaskStatus::UserActionRequired };
            task.failure_reason = Some(reason.chars().take(180).collect());
            self.repository.lock().save(task)?;
        }
        Ok(tasks.iter().map(TicketTaskView::from).collect())
    }

    pub fn begin_order(&self, task_id: &str) -> Result<TicketTaskView, String> {
        let mut tasks = self.tasks.write();
        let task = tasks.iter_mut().find(|task| task.id == task_id).ok_or("任务不存在")?;
        if task.status == TaskStatus::PartialPaymentPending {
            task.status = TaskStatus::OrderInitializing;
        } else {
            task.transition(TaskStatus::CandidateSelected)?;
            task.transition(TaskStatus::OrderInitializing)?;
        }
        task.failure_reason = None;
        self.repository.lock().save(task)?;
        Ok(TicketTaskView::from(&*task))
    }

    pub fn mark_order_submitting(&self, task_id: &str) -> Result<TicketTaskView, String> {
        let mut tasks = self.tasks.write();
        let task = tasks.iter_mut().find(|task| task.id == task_id).ok_or("任务不存在")?;
        task.transition(TaskStatus::OrderSubmitting)?;
        self.repository.lock().save(task)?;
        Ok(TicketTaskView::from(&*task))
    }

    pub fn run_rehearsal(
        &self,
        task_id: &str,
        input: RunRehearsalInput,
    ) -> Result<RehearsalResult, String> {
        let task = self
            .tasks
            .read()
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
            .ok_or("任务不存在")?;
        let _submission_guard = self.submission_lock.lock();
        let mut events = vec![ExecutionEvent::rehearsal(
            task_id,
            "PREFLIGHT",
            "PASSED",
            "测试预检通过；未调用 12306",
        )];
        let final_outcome = match input.scenario {
            RehearsalScenario::SeatsAvailable => {
                let available = input
                    .available_count
                    .unwrap_or(task.passengers.len() as u16)
                    .max(1);
                let plan = task
                    .build_order_plan(available)
                    .map_err(|error| error.to_string())?;
                events.push(ExecutionEvent::rehearsal(
                    task_id,
                    "CANDIDATE_SELECTED",
                    "PASSED",
                    format!("测试候选已选中，可用席位 {available}"),
                ));
                for segment in &plan.segments {
                    events.push(ExecutionEvent::rehearsal(
                        task_id,
                        "ORDER_SEGMENT",
                        "SIMULATED",
                        format!(
                            "测试子订单 {} 已串行演练，共 {} 人；未真实提交",
                            segment.sequence,
                            segment.passenger_refs.len()
                        ),
                    ));
                }
                events.push(ExecutionEvent::rehearsal(
                    task_id,
                    "NOTIFICATION",
                    "TEST_ONLY",
                    "测试通知：演练完成，不存在真实待支付订单",
                ));
                "SIMULATED_SUCCESS"
            }
            RehearsalScenario::NoAvailability => {
                events.push(ExecutionEvent::rehearsal(
                    task_id,
                    "QUERYING",
                    "NO_AVAILABILITY",
                    "测试查询无票，保持等待；未发起提交",
                ));
                "NO_AVAILABILITY"
            }
            RehearsalScenario::TimeoutReconciledEmpty => {
                events.push(ExecutionEvent::rehearsal(
                    task_id,
                    "UNKNOWN_RECONCILING",
                    "ENTERED",
                    "测试网络超时，已停止重提并进入订单核对",
                ));
                events.push(ExecutionEvent::rehearsal(
                    task_id,
                    "ORDER_RECONCILIATION",
                    "EMPTY",
                    "测试查单结果为空，演练安全终止",
                ));
                "RECONCILED_EMPTY"
            }
            RehearsalScenario::RateLimited => {
                events.push(ExecutionEvent::rehearsal(
                    task_id,
                    "RATE_LIMITED",
                    "STOPPED",
                    "测试触发频率限制，所有查询和提交均停止",
                ));
                "RATE_LIMITED"
            }
        }
        .to_string();
        self.repository.lock().save_events(&events)?;
        Ok(RehearsalResult {
            task_id: task_id.into(),
            source: "SIMULATION".into(),
            final_outcome,
            events,
        })
    }

    pub fn run_preflight(&self, task_id: &str) -> Result<TicketTaskView, String> {
        let mut tasks = self.tasks.write();
        let task = tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or("任务不存在")?;
        task.transition(TaskStatus::Preflight)?;
        let protocol = self.protocol_status();
        if !protocol.query_enabled {
            task.status = TaskStatus::Incompatible;
            task.failure_reason = Some(protocol.message);
        } else {
            task.transition(TaskStatus::Ready)?;
            task.failure_reason = None;
        }
        self.repository.lock().save(task)?;
        Ok(TicketTaskView::from(&*task))
    }
}
