use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let database_path = std::env::var_os("FAST_12306_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".local-data/fast-12306.db"));
    if let Some(parent) = database_path.parent() {
        std::fs::create_dir_all(parent).expect("无法创建本地数据目录");
    }
    fast_12306_lib::web::serve(database_path)
        .await
        .expect("Fast 12306 本地 Web API 启动失败");
}
