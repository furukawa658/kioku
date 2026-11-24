use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};

pub const BUSY_TIMEOUT_MS: u64 = 5000;

pub fn open_read_only(path: &Path) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open kioku database at {}", path.display()))?;
    configure_connection(&connection)?;
    Ok(connection)
}

pub fn open_read_write(path: &Path) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open kioku database at {}", path.display()))?;
    configure_connection(&connection)?;
    Ok(connection)
}

fn configure_connection(connection: &Connection) -> Result<()> {
    connection
        .busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS))
        .context("Cannot configure kioku SQLite busy timeout")?;
    connection
        .execute_batch("PRAGMA temp_store = MEMORY;")
        .context("Cannot configure kioku SQLite temporary storage")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_and_read_write_connections_use_five_second_busy_timeout() {
        let directory = tempfile::tempdir().expect("temporary database directory");
        let path = directory.path().join("claude-mem.db");
        Connection::open(&path).expect("create fixture database");

        for connection in [open_read_only(&path), open_read_write(&path)] {
            let connection = connection.expect("open configured connection");
            let timeout: i64 = connection
                .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
                .expect("read busy timeout");
            let temp_store: i64 = connection
                .query_row("PRAGMA temp_store", [], |row| row.get(0))
                .expect("read temp store mode");
            assert_eq!(timeout, BUSY_TIMEOUT_MS as i64);
            assert_eq!(temp_store, 2);
        }
    }
}
