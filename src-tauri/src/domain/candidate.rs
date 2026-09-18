use serde::{Deserialize, Serialize};

/// One bookable train and seat combination returned by a verified adapter.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketCandidate {
    pub task_id: String,
    pub route_group_id: String,
    pub train_internal_ref: String,
    pub train_code: String,
    pub seat_type: String,
    pub available_count: u16,
    pub task_priority: u16,
    pub route_priority: u16,
    pub date_priority: u16,
    pub train_priority: u16,
    pub seat_priority: u16,
    pub task_created_sequence: u64,
}

#[allow(dead_code)]
impl TicketCandidate {
    /// Stable ordering key. Lower numbers represent stronger user preference.
    pub fn priority_key(&self) -> (u16, u16, u16, u16, u16, u64) {
        (
            self.task_priority,
            self.route_priority,
            self.date_priority,
            self.train_priority,
            self.seat_priority,
            self.task_created_sequence,
        )
    }
}

/// Select the highest-priority candidate that can serve at least one passenger.
#[allow(dead_code)]
pub fn select_candidate(candidates: &[TicketCandidate]) -> Option<TicketCandidate> {
    candidates
        .iter()
        .filter(|candidate| candidate.available_count > 0)
        .min_by_key(|candidate| candidate.priority_key())
        .cloned()
}
