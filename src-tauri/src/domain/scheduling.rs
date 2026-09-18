use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;

use super::{TaskStatus, TicketTask};

pub const MAX_CONCURRENT_ROUTE_QUERIES: usize = 2;

/// Read-only query work selected for one sale-time tick. The task creation time is retained only
/// as the stable final tie breaker; it is not exposed as a protocol parameter.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRoute {
    pub task_id: String,
    pub route_group_id: String,
    pub task_priority: u16,
    pub route_priority: u16,
    pub sale_time: DateTime<Utc>,
    pub travel_date: NaiveDate,
    pub from_station: String,
    pub to_station: String,
    pub train_codes: Vec<String>,
    pub seat_types: Vec<String>,
}

/// Select at most two route groups for the same due tick using the documented stable priority.
/// Submission concurrency is deliberately outside this selector and remains account-wide serial.
pub fn select_query_batch(tasks: &[TicketTask], now: DateTime<Utc>) -> Vec<ScheduledRoute> {
    let mut due = tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Armed && task.deadline.is_none_or(|deadline| deadline > now))
        .flat_map(|task| {
            task.route_groups
                .iter()
                .filter(move |group| group.sale_time <= now)
                .map(move |group| (task, group))
        })
        .collect::<Vec<_>>();
    due.sort_by_key(|(task, group)| {
        (
            task.priority,
            group.priority,
            group.travel_date,
            task.created_at,
            group.id.clone(),
        )
    });
    due.into_iter()
        .take(MAX_CONCURRENT_ROUTE_QUERIES)
        .map(|(task, group)| ScheduledRoute {
            task_id: task.id.clone(),
            route_group_id: group.id.clone(),
            task_priority: task.priority,
            route_priority: group.priority,
            sale_time: group.sale_time,
            travel_date: group.travel_date,
            from_station: group.from_station.clone(),
            to_station: group.to_station.clone(),
            train_codes: group.train_codes.clone(),
            seat_types: group.seat_types.clone(),
        })
        .collect()
}
