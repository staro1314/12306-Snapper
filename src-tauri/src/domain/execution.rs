use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RehearsalScenario {
    SeatsAvailable,
    NoAvailability,
    TimeoutReconciledEmpty,
    RateLimited,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRehearsalInput {
    pub scenario: RehearsalScenario,
    pub available_count: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEvent {
    pub id: String,
    pub task_id: String,
    pub source: String,
    pub stage: String,
    pub outcome: String,
    pub message: String,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub route_group_id: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<f64>,
}

impl ExecutionEvent {
    pub fn rehearsal(
        task_id: &str,
        stage: &str,
        outcome: &str,
        message: impl Into<String>,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            task_id: task_id.into(),
            source: "SIMULATION".into(),
            stage: stage.into(),
            outcome: outcome.into(),
            message: message.into(),
            created_at: Utc::now(),
            route_group_id: None,
            duration_ms: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordExecutionEventInput {
    pub task_id: String,
    pub route_group_id: Option<String>,
    pub stage: String,
    pub outcome: String,
    pub message: String,
    pub duration_ms: Option<f64>,
    /// Local action time, supplied by the browser observer. Omitted for Rust-owned events.
    #[serde(default)]
    pub observed_at: Option<DateTime<Utc>>,
}

impl ExecutionEvent {
    pub fn official_runtime(input: RecordExecutionEventInput) -> Self {
        Self {
            id: Uuid::new_v4().to_string(), task_id: input.task_id,
            source: "12306_OFFICIAL_RUNTIME".into(), stage: input.stage,
            outcome: input.outcome, message: input.message, created_at: input.observed_at.unwrap_or_else(Utc::now),
            route_group_id: input.route_group_id, duration_ms: input.duration_ms,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RehearsalResult {
    pub task_id: String,
    pub source: String,
    pub final_outcome: String,
    pub events: Vec<ExecutionEvent>,
}
