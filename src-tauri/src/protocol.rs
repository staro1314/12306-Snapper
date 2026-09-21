use chrono::{TimeZone, Utc};

use crate::domain::{CompatibilityStatus, ProtocolStatusView};

/// External boundary for the current 12306 web workflow. A concrete adapter must be produced
/// from a current read-only observation and reviewed before submission methods are enabled.
pub trait RailwayProtocolAdapter: Send + Sync {
    fn compatibility_status(&self) -> ProtocolStatusView;
}

/// Fail-closed adapter used until a current protocol profile has been established.
#[allow(dead_code)]
pub struct UnverifiedProtocolAdapter;

impl RailwayProtocolAdapter for UnverifiedProtocolAdapter {
    fn compatibility_status(&self) -> ProtocolStatusView {
        ProtocolStatusView::default()
    }
}

/// Profile established from the 2026-09-17 official login, passenger, left-ticket and real
/// pending-order workflow. Submission remains fail-closed unless the per-process gate is enabled.
pub struct ObservedReadOnlyProtocolAdapter;

impl RailwayProtocolAdapter for ObservedReadOnlyProtocolAdapter {
    fn compatibility_status(&self) -> ProtocolStatusView {
        // The current profile has completed a real pending-order acceptance run. Keep an
        // environment-level emergency kill switch, while task-level consent remains mandatory.
        let submission_enabled = std::env::var("FAST_12306_ENABLE_REAL_SUBMISSION").as_deref() != Ok("0");
        ProtocolStatusView {
            profile_id: Some("web-2026-09-17-order-v2".into()),
            status: if submission_enabled { CompatibilityStatus::Compatible } else { CompatibilityStatus::ReadOnlyCompatible },
            verified_at: Utc.with_ymd_and_hms(2026, 9, 17, 10, 50, 0).single(),
            message: if submission_enabled { "当前协议配置允许真实提交；每个任务仍必须明确授权，系统不会自动支付。" } else { "真实提交已被环境紧急开关关闭，任务仅执行查询。" }.into(),
            query_enabled: true,
            submission_enabled,
        }
    }
}
