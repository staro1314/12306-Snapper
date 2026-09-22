use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{OrderPlan, OrderPlanError};

/// Lifecycle of a task. Payment pending is deliberately distinct from paid or issued states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TaskStatus {
    Draft,
    Preflight,
    Ready,
    Armed,
    Querying,
    CandidateSelected,
    OrderInitializing,
    OrderSubmitting,
    Queuing,
    PaymentPending,
    Paid,
    Cancelled,
    Expired,
    UserActionRequired,
    RateLimited,
    Incompatible,
    UnknownReconciling,
    PartialPaymentPending,
    Failed,
}

impl TaskStatus {
    /// Centralized state transition policy prevents UI commands from skipping safety checks.
    pub fn can_transition_to(self, next: Self) -> bool {
        use TaskStatus::*;
        matches!(
            (self, next),
            (Draft, Preflight)
                | (
                    Preflight,
                    Ready | Incompatible | UserActionRequired | Failed
                )
                | (Ready, Armed)
                | (Armed, Ready | Querying | UserActionRequired | Incompatible)
                | (
                    Querying,
                    Armed
                        | CandidateSelected
                        | RateLimited
                        | UserActionRequired
                        | Incompatible
                        | Failed
                )
                | (CandidateSelected, OrderInitializing)
                | (
                    OrderInitializing,
                    OrderSubmitting | UnknownReconciling | UserActionRequired | Incompatible
                )
                | (
                    OrderSubmitting,
                    Queuing
                        | PaymentPending
                        | UnknownReconciling
                        | UserActionRequired
                        | RateLimited
                )
                | (Queuing, PaymentPending | UnknownReconciling | Failed)
                | (
                    UnknownReconciling,
                    PaymentPending | PartialPaymentPending | Failed | UserActionRequired
                )
                | (PaymentPending, Paid | Cancelled | Expired)
                | (PartialPaymentPending, Paid | Cancelled | Expired)
                | (UserActionRequired, Preflight)
                | (RateLimited, Preflight)
                | (Incompatible, Preflight)
        )
    }
}

/// A passenger reference synchronized from the logged-in account. The reference must never be
/// replaced by a full identity number in ordinary persistence or logs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassengerSelection {
    pub passenger_ref: String,
    pub display_name: String,
    pub ticket_type: String,
    pub priority: u16,
    pub verified: bool,
}

/// One independent date and station query group.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteGroup {
    pub id: String,
    pub travel_date: NaiveDate,
    pub from_station: String,
    pub to_station: String,
    pub sale_time: DateTime<Utc>,
    pub priority: u16,
    pub train_codes: Vec<String>,
    pub seat_types: Vec<String>,
}

/// User-owned booking task. A task can contain several route groups but shares one ordered
/// passenger set and one explicit split-order consent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketTask {
    pub id: String,
    pub name: String,
    pub priority: u16,
    pub status: TaskStatus,
    pub split_authorized: bool,
    /// Whether this task explicitly authorizes creating a real 12306 pending-payment order.
    /// False keeps the task query-only even when the process-level submission gate is enabled.
    #[serde(default)]
    pub real_submission_authorized: bool,
    pub passengers: Vec<PassengerSelection>,
    pub route_groups: Vec<RouteGroup>,
    pub created_at: DateTime<Utc>,
    pub failure_reason: Option<String>,
    #[serde(default)]
    pub deadline: Option<DateTime<Utc>>,
}

impl TicketTask {
    pub fn new(
        name: String,
        priority: u16,
        split_authorized: bool,
        passengers: Vec<PassengerSelection>,
        route_groups: Vec<RouteGroup>,
        deadline: Option<DateTime<Utc>>,
    ) -> Result<Self, String> {
        if name.trim().is_empty() {
            return Err("任务名称不能为空".into());
        }
        if priority == 0 {
            return Err("任务优先级必须大于 0".into());
        }
        if passengers.is_empty() {
            return Err("至少选择一名乘车人".into());
        }
        if passengers.len() > 5 {
            return Err("单个任务最多选择 5 名乘车人".into());
        }
        if passengers.iter().any(|passenger| !passenger.verified) {
            return Err("所有乘车人必须已通过 12306 核验".into());
        }
        if route_groups.is_empty() {
            return Err("至少配置一个路线组".into());
        }
        if route_groups.len() > 5 {
            return Err("单个任务最多配置 5 个日期或路线组".into());
        }
        if route_groups
            .iter()
            .any(|group| group.train_codes.is_empty() || group.seat_types.is_empty() || group.train_codes.len() > 5 || group.seat_types.len() > 5)
        {
            return Err("每个路线组必须包含 1 至 5 个车次和 1 至 5 个席别".into());
        }
        if route_groups.iter().any(|group| group.from_station.trim().is_empty() || group.to_station.trim().is_empty() || group.from_station == group.to_station) {
            return Err("每个路线组必须包含不同的有效发站和到站".into());
        }
        if deadline.is_some_and(|value| route_groups.iter().any(|group| value <= group.sale_time)) {
            return Err("任务截止时间必须晚于所有路线组的起售时间".into());
        }

        Ok(Self {
            id: Uuid::new_v4().to_string(),
            name,
            priority,
            status: TaskStatus::Draft,
            split_authorized,
            real_submission_authorized: false,
            passengers,
            route_groups,
            created_at: Utc::now(),
            failure_reason: None,
            deadline,
        })
    }

    pub fn transition(&mut self, next: TaskStatus) -> Result<(), String> {
        if !self.status.can_transition_to(next) {
            return Err(format!("禁止从 {:?} 跳转到 {:?}", self.status, next));
        }
        self.status = next;
        Ok(())
    }

    pub fn build_order_plan(&self, available_count: u16) -> Result<OrderPlan, OrderPlanError> {
        OrderPlan::build(
            &self.id,
            &self.passengers,
            available_count,
            self.split_authorized,
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskInput {
    pub name: String,
    pub priority: u16,
    pub split_authorized: bool,
    /// Explicit per-task consent for real order submission; omitted legacy payloads default to false.
    #[serde(default)]
    pub real_submission_authorized: bool,
    pub passengers: Vec<PassengerSelection>,
    pub route_groups: Vec<RouteGroup>,
    pub deadline: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HaltTaskInput {
    pub status: TaskStatus,
    pub reason: String,
}

impl TicketTask {
    pub fn apply_update(&mut self, input: CreateTaskInput) -> Result<(), String> {
        if !matches!(
            self.status,
            TaskStatus::Draft
                | TaskStatus::Incompatible
                | TaskStatus::Failed
                | TaskStatus::UserActionRequired
                | TaskStatus::RateLimited
                | TaskStatus::Expired
        ) {
            return Err("只有草稿、不兼容或失败任务可以编辑".into());
        }
        let real_submission_authorized = input.real_submission_authorized;
        let replacement = TicketTask::new(
            input.name,
            input.priority,
            input.split_authorized,
            input.passengers,
            input.route_groups,
            input.deadline,
        )?;
        self.name = replacement.name;
        self.priority = replacement.priority;
        self.split_authorized = replacement.split_authorized;
        self.real_submission_authorized = real_submission_authorized;
        self.passengers = replacement.passengers;
        self.route_groups = replacement.route_groups;
        self.status = TaskStatus::Draft;
        self.failure_reason = None;
        self.deadline = replacement.deadline;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketTaskView {
    pub id: String,
    pub name: String,
    pub priority: u16,
    pub status: TaskStatus,
    pub split_authorized: bool,
    pub real_submission_authorized: bool,
    pub passenger_count: usize,
    pub route_group_count: usize,
    /// Earliest official sale time among this task's route groups. The client uses this
    /// server-owned value for the armed-task countdown instead of reconstructing task detail.
    pub next_sale_time: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub failure_reason: Option<String>,
    pub deadline: Option<DateTime<Utc>>,
}

impl From<&TicketTask> for TicketTaskView {
    fn from(task: &TicketTask) -> Self {
        Self {
            id: task.id.clone(),
            name: task.name.clone(),
            priority: task.priority,
            status: task.status,
            split_authorized: task.split_authorized,
            real_submission_authorized: task.real_submission_authorized,
            passenger_count: task.passengers.len(),
            route_group_count: task.route_groups.len(),
            next_sale_time: task.route_groups.iter().map(|route| route.sale_time).min(),
            created_at: task.created_at,
            failure_reason: task.failure_reason.clone(),
            deadline: task.deadline,
        }
    }
}
