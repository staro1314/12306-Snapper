use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Locally persisted view of an official order. Payment pending is the automation success state;
/// it is never treated as paid or ticketed without a later official reconciliation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OfficialOrderStatus {
    Unknown,
    PaymentPending,
    Paid,
    Cancelled,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderSnapshot {
    pub local_id: String,
    pub task_id: String,
    pub official_order_ref: Option<String>,
    pub status: OfficialOrderStatus,
    pub passenger_refs: Vec<String>,
    pub payment_deadline: Option<DateTime<Utc>>,
    pub last_reconciled_at: DateTime<Utc>,
    pub source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordOrderResultInput {
    pub task_id: String,
    pub official_order_ref: Option<String>,
    pub status: OfficialOrderStatus,
    pub passenger_refs: Vec<String>,
    pub payment_deadline: Option<DateTime<Utc>>,
    #[serde(default)]
    pub partial: bool,
}

impl OrderSnapshot {
    pub fn unknown(task_id: &str, passenger_refs: Vec<String>) -> Self {
        Self {
            local_id: Uuid::new_v4().to_string(),
            task_id: task_id.into(),
            official_order_ref: None,
            status: OfficialOrderStatus::Unknown,
            passenger_refs,
            payment_deadline: None,
            last_reconciled_at: Utc::now(),
            source: "12306_OFFICIAL".into(),
        }
    }
}
