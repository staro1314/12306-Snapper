use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tower_http::cors::CorsLayer;

use crate::{
    AppState,
    domain::{
        CreateTaskInput, ExecutionEvent, HaltTaskInput, OrderSnapshot, ProtocolStatusView, RecordExecutionEventInput, RecordOrderResultInput,
        RehearsalResult, RunRehearsalInput, ScheduledRoute, TicketTask, TicketTaskView,
    },
};

const WEB_SERVER_ADDRESS: &str = "127.0.0.1:3210";

#[derive(Debug, Serialize)]
struct ApiErrorBody {
    error: String,
}

struct ApiError(String);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SafetyPauseInput { reason: String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewQuery { now: Option<chrono::DateTime<chrono::Utc>> }

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiErrorBody { error: self.0 }),
        )
            .into_response()
    }
}

/// Build the localhost-only development API. It exposes the same application service used by
/// Tauri commands, so browser testing and the final desktop build cannot drift in business rules.
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/protocol", get(protocol_status))
        .route("/api/scheduler/preview", get(preview_query_batch))
        .route("/api/safety/pause", post(pause_all_automation))
        .route(
            "/api/orders",
            get(list_order_snapshots).post(record_order_result),
        )
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route(
            "/api/tasks/{task_id}",
            get(get_task).put(update_task).delete(delete_task),
        )
        .route("/api/tasks/{task_id}/preflight", post(run_preflight))
        .route("/api/tasks/{task_id}/arm", post(arm_task))
        .route("/api/tasks/{task_id}/pause", post(pause_task))
        .route("/api/tasks/{task_id}/query/start", post(begin_query))
        .route("/api/tasks/{task_id}/query/complete", post(complete_query))
        .route("/api/tasks/{task_id}/halt", post(halt_task))
        .route("/api/tasks/{task_id}/abandon", post(abandon_task))
        .route("/api/tasks/{task_id}/order/begin", post(begin_order))
        .route("/api/tasks/{task_id}/order/submitting", post(mark_order_submitting))
        .route("/api/tasks/{task_id}/rehearsal", post(run_rehearsal))
        .route("/api/tasks/{task_id}/events", get(list_events).post(record_execution_event))
        .layer(CorsLayer::new())
        .with_state(state)
}

async fn list_order_snapshots(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<OrderSnapshot>>, ApiError> {
    state.list_order_snapshots().map(Json).map_err(ApiError)
}
async fn record_order_result(
    State(state): State<Arc<AppState>>,
    Json(input): Json<RecordOrderResultInput>,
) -> Result<Json<OrderSnapshot>, ApiError> {
    state.record_order_result(input).map(Json).map_err(ApiError)
}

async fn preview_query_batch(State(state): State<Arc<AppState>>, Query(query): Query<PreviewQuery>) -> Result<Json<Vec<ScheduledRoute>>, ApiError> {
    state.preview_query_batch_at(query.now.unwrap_or_else(chrono::Utc::now)).map(Json).map_err(ApiError)
}
async fn pause_all_automation(State(state): State<Arc<AppState>>, Json(input): Json<SafetyPauseInput>) -> Result<Json<Vec<TicketTaskView>>, ApiError> { state.pause_all_automation(&input.reason).map(Json).map_err(ApiError) }

async fn get_task(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
) -> Result<Json<TicketTask>, ApiError> {
    state.get_task(&task_id).map(Json).map_err(ApiError)
}

async fn update_task(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
    Json(input): Json<CreateTaskInput>,
) -> Result<Json<TicketTaskView>, ApiError> {
    state
        .update_task(&task_id, input)
        .map(Json)
        .map_err(ApiError)
}
async fn delete_task(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state
        .delete_task(&task_id)
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(ApiError)
}
async fn run_rehearsal(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
    Json(input): Json<RunRehearsalInput>,
) -> Result<Json<RehearsalResult>, ApiError> {
    state
        .run_rehearsal(&task_id, input)
        .map(Json)
        .map_err(ApiError)
}
async fn list_events(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
) -> Result<Json<Vec<ExecutionEvent>>, ApiError> {
    state.list_events(&task_id).map(Json).map_err(ApiError)
}
async fn record_execution_event(State(state): State<Arc<AppState>>, Path(task_id): Path<String>, Json(mut input): Json<RecordExecutionEventInput>) -> Result<Json<ExecutionEvent>, ApiError> { input.task_id = task_id; state.record_execution_event(input).map(Json).map_err(ApiError) }

pub async fn serve(database_path: PathBuf) -> Result<(), String> {
    let state = Arc::new(AppState::open(database_path)?);
    let address: SocketAddr = WEB_SERVER_ADDRESS
        .parse()
        .map_err(|error| format!("本地服务地址无效: {error}"))?;
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| format!("无法启动本地服务 {WEB_SERVER_ADDRESS}: {error}"))?;
    println!("Fast 12306 local API: http://{WEB_SERVER_ADDRESS}");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| error.to_string())
}

async fn protocol_status(State(state): State<Arc<AppState>>) -> Json<ProtocolStatusView> {
    Json(state.protocol_status())
}

async fn list_tasks(State(state): State<Arc<AppState>>) -> Json<Vec<TicketTaskView>> {
    Json(state.list_tasks())
}

async fn create_task(
    State(state): State<Arc<AppState>>,
    Json(input): Json<CreateTaskInput>,
) -> Result<Json<TicketTaskView>, ApiError> {
    state.create_task(input).map(Json).map_err(ApiError)
}

async fn run_preflight(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
) -> Result<Json<TicketTaskView>, ApiError> {
    state.run_preflight(&task_id).map(Json).map_err(ApiError)
}
async fn arm_task(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
) -> Result<Json<TicketTaskView>, ApiError> {
    state.arm_task(&task_id).map(Json).map_err(ApiError)
}
async fn pause_task(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
) -> Result<Json<TicketTaskView>, ApiError> {
    state.pause_task(&task_id).map(Json).map_err(ApiError)
}
async fn begin_query(State(state): State<Arc<AppState>>, Path(task_id): Path<String>) -> Result<Json<TicketTaskView>, ApiError> { state.begin_query(&task_id).map(Json).map_err(ApiError) }
async fn complete_query(State(state): State<Arc<AppState>>, Path(task_id): Path<String>) -> Result<Json<TicketTaskView>, ApiError> { state.complete_query(&task_id).map(Json).map_err(ApiError) }
async fn halt_task(State(state): State<Arc<AppState>>, Path(task_id): Path<String>, Json(input): Json<HaltTaskInput>) -> Result<Json<TicketTaskView>, ApiError> { state.halt_task(&task_id, input).map(Json).map_err(ApiError) }
async fn abandon_task(State(state): State<Arc<AppState>>, Path(task_id): Path<String>) -> Result<Json<TicketTaskView>, ApiError> { state.abandon_task(&task_id).map(Json).map_err(ApiError) }
async fn begin_order(State(state): State<Arc<AppState>>, Path(task_id): Path<String>) -> Result<Json<TicketTaskView>, ApiError> { state.begin_order(&task_id).map(Json).map_err(ApiError) }
async fn mark_order_submitting(State(state): State<Arc<AppState>>, Path(task_id): Path<String>) -> Result<Json<TicketTaskView>, ApiError> { state.mark_order_submitting(&task_id).map(Json).map_err(ApiError) }

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn development_server_is_loopback_only() {
        let address: SocketAddr = WEB_SERVER_ADDRESS.parse().unwrap();
        assert!(address.ip().is_loopback());
    }
}
