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
        let submission_enabled = std::env::var("FAST_12306_ENABLE_REAL_SUBMISSION").as_deref() == Ok("1");
        ProtocolStatusView {
            profile_id: Some("web-2026-09-17-order-v2".into()),
            status: if submission_enabled { CompatibilityStatus::Compatible } else { CompatibilityStatus::ReadOnlyCompatible },
            verified_at: Utc.with_ymd_and_hms(2026, 9, 17, 10, 50, 0).single(),
            message: if submission_enabled { "当前协议配置已进入用户授权的真实提交测试模式。" } else { "当前官网登录、余票查询、订单初始化、确认排队和待支付查单链路已验证；真实提交门禁保持锁定。" }.into(),
            query_enabled: true,
            submission_enabled,
        }
    }
}
