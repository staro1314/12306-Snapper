use std::path::Path;

use rusqlite::{Connection, params};

use crate::domain::{ExecutionEvent, OrderSnapshot, TicketTask};

pub struct TaskRepository {
    connection: Connection,
}

impl TaskRepository {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS ticket_task (
                id TEXT PRIMARY KEY NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL,
                priority INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ticket_task_priority
                ON ticket_task(status, priority, created_at);
            CREATE TABLE IF NOT EXISTS execution_event (
                id TEXT PRIMARY KEY NOT NULL,
                task_id TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_execution_event_task
                ON execution_event(task_id, created_at);
            CREATE TABLE IF NOT EXISTS order_snapshot (
                local_id TEXT PRIMARY KEY NOT NULL,
                task_id TEXT NOT NULL,
                status TEXT NOT NULL,
                last_reconciled_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_order_snapshot_task
                ON order_snapshot(task_id, last_reconciled_at);",
            )
            .map_err(|error| error.to_string())?;
        Ok(Self { connection })
    }

    pub fn save(&self, task: &TicketTask) -> Result<(), String> {
        let payload = serde_json::to_string(task).map_err(|error| error.to_string())?;
        self.connection.execute(
            "INSERT INTO ticket_task(id, payload_json, status, priority, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET payload_json=?2, status=?3, priority=?4, updated_at=?5",
            params![task.id, payload, format!("{:?}", task.status), task.priority, chrono::Utc::now().to_rfc3339()],
        ).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<TicketTask>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT payload_json FROM ticket_task ORDER BY priority ASC, created_at ASC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            let payload = row.map_err(|error| error.to_string())?;
            serde_json::from_str(&payload).map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn delete(&self, task_id: &str) -> Result<(), String> {
        let changed = self
            .connection
            .execute("DELETE FROM ticket_task WHERE id=?1", params![task_id])
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("任务不存在".into());
        }
        self.connection
            .execute(
                "DELETE FROM execution_event WHERE task_id=?1",
                params![task_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn save_events(&self, events: &[ExecutionEvent]) -> Result<(), String> {
        for event in events {
            let payload = serde_json::to_string(event).map_err(|error| error.to_string())?;
            self.connection.execute("INSERT INTO execution_event(id, task_id, source, created_at, payload_json) VALUES (?1,?2,?3,?4,?5)", params![event.id, event.task_id, event.source, event.created_at.to_rfc3339(), payload]).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn list_events(&self, task_id: &str) -> Result<Vec<ExecutionEvent>, String> {
        let mut statement = self.connection.prepare("SELECT payload_json FROM execution_event WHERE task_id=?1 ORDER BY created_at DESC").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([task_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        })
        .collect()
    }

    /// Persist the official order snapshot and every task status affected by it atomically.
    /// A crash must never leave a stored order without the matching task/conflict locks.
    pub fn save_order_result_atomic(
        &mut self,
        affected_tasks: &[TicketTask],
        snapshot: &OrderSnapshot,
    ) -> Result<(), String> {
        let transaction = self.connection.transaction().map_err(|error| error.to_string())?;
        let updated_at = chrono::Utc::now().to_rfc3339();
        for task in affected_tasks {
            let payload = serde_json::to_string(task).map_err(|error| error.to_string())?;
            transaction.execute(
                "INSERT INTO ticket_task(id, payload_json, status, priority, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET payload_json=?2, status=?3, priority=?4, updated_at=?6",
                params![task.id, payload, format!("{:?}", task.status), task.priority, task.created_at.to_rfc3339(), updated_at],
            ).map_err(|error| error.to_string())?;
        }
        let payload = serde_json::to_string(snapshot).map_err(|error| error.to_string())?;
        transaction.execute(
            "INSERT INTO order_snapshot(local_id, task_id, status, last_reconciled_at, payload_json)
             VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(local_id) DO UPDATE SET status=?3,last_reconciled_at=?4,payload_json=?5",
            params![snapshot.local_id, snapshot.task_id, format!("{:?}", snapshot.status), snapshot.last_reconciled_at.to_rfc3339(), payload],
        ).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn list_order_snapshots(&self) -> Result<Vec<OrderSnapshot>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT payload_json FROM order_snapshot ORDER BY last_reconciled_at DESC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        })
        .collect()
    }
}
