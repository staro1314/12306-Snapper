use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::PassengerSelection;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum OrderPlanError {
    #[error("当前候选没有可用席位")]
    NoAvailability,
    #[error("余票不足且用户未授权自动拆单")]
    SplitNotAuthorized,
}

/// A single sequential submission unit. Only one segment may be submitted at a time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderSegment {
    pub sequence: u16,
    pub passenger_refs: Vec<String>,
}

/// Deterministic order plan generated before obtaining the account-wide submission lock.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderPlan {
    pub task_id: String,
    pub segments: Vec<OrderSegment>,
}

impl OrderPlan {
    pub fn build(
        task_id: &str,
        passengers: &[PassengerSelection],
        available_count: u16,
        split_authorized: bool,
    ) -> Result<Self, OrderPlanError> {
        if available_count == 0 {
            return Err(OrderPlanError::NoAvailability);
        }
        let mut ordered = passengers.to_vec();
        ordered.sort_by_key(|passenger| passenger.priority);
        if available_count as usize >= ordered.len() {
            return Ok(Self {
                task_id: task_id.into(),
                segments: vec![OrderSegment {
                    sequence: 1,
                    passenger_refs: ordered
                        .into_iter()
                        .map(|passenger| passenger.passenger_ref)
                        .collect(),
                }],
            });
        }
        if !split_authorized {
            return Err(OrderPlanError::SplitNotAuthorized);
        }

        let chunk_size = available_count as usize;
        let segments = ordered
            .chunks(chunk_size)
            .enumerate()
            .map(|(index, chunk)| OrderSegment {
                sequence: index as u16 + 1,
                passenger_refs: chunk
                    .iter()
                    .map(|passenger| passenger.passenger_ref.clone())
                    .collect(),
            })
            .collect();
        Ok(Self {
            task_id: task_id.into(),
            segments,
        })
    }
}
