use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Compatibility result for the currently observed 12306 web protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompatibilityStatus {
    Unverified,
    ReadOnlyCompatible,
    Compatible,
    Incompatible,
}

/// A versioned description of a protocol shape observed from the current official website.
/// It contains signatures and capabilities only, never cookies, tokens, or request bodies.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolProfile {
    pub id: String,
    pub observed_at: DateTime<Utc>,
    pub response_signatures: Vec<String>,
    pub capabilities: Vec<String>,
    pub status: CompatibilityStatus,
}

/// Safe status exposed to the UI. Submission stays disabled until a compatible profile is
/// established by the explicit read-only observation workflow.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolStatusView {
    pub profile_id: Option<String>,
    pub status: CompatibilityStatus,
    pub verified_at: Option<DateTime<Utc>>,
    pub message: String,
    pub query_enabled: bool,
    pub submission_enabled: bool,
}

impl Default for ProtocolStatusView {
    fn default() -> Self {
        Self {
            profile_id: None,
            status: CompatibilityStatus::Unverified,
            verified_at: None,
            message: "尚未基于当前 12306 会话完成只读协议观测，真实提交保持禁用。".into(),
            query_enabled: false,
            submission_enabled: false,
        }
    }
}
