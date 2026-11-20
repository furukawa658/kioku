use std::io::Write;
use std::process::{Command, Stdio};

use rusqlite::Connection;
use serde_json::{Value, json};

#[test]
fn mcp_process_invalidates_without_a_worker() {
    let directory = tempfile::tempdir().expect("temporary database directory");
    let database = directory.path().join("claude-mem.db");
    let connection = Connection::open(&database).expect("open fixture database");
    connection
        .execute("CREATE TABLE observations (id INTEGER PRIMARY KEY)", [])
        .expect("create observations table");
    connection
        .execute("INSERT INTO observations (id) VALUES (1)", [])
        .expect("insert observation");
    drop(connection);

    let mut child = Command::new(env!("CARGO_BIN_EXE_kioku-core"))
        .env_remove("CLAUDE_MEM_WORKER_URL")
        .arg("--database")
        .arg(&database)
        .arg("--worker-url")
        .arg("http://127.0.0.1:1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kioku-core");
    let request = json!({
        "jsonrpc":"2.0",
        "id":1,
        "method":"tools/call",
        "params":{
            "name":"invalidate_memory",
            "arguments":{"id":1,"reason":"superseded","replacedBy":1}
        }
    });
    writeln!(
        child.stdin.take().expect("child stdin"),
        "{}",
        serde_json::to_string(&request).expect("serialize request")
    )
    .expect("send MCP request");

    let output = child.wait_with_output().expect("wait for kioku-core");
    assert!(
        output.status.success(),
        "kioku-core failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).expect("parse MCP response");
    assert_eq!(response["id"], 1);
    assert_eq!(response["result"]["isError"], false);
    let body: Value = serde_json::from_str(
        response["result"]["content"][0]["text"]
            .as_str()
            .expect("MCP text response"),
    )
    .expect("parse invalidation response");
    assert_eq!(body["success"], true);
    assert_eq!(body["invalidated"], true);

    let connection = Connection::open(&database).expect("inspect fixture database");
    let stored = connection
        .query_row(
            "SELECT reason, replaced_by FROM invalidated_observations WHERE observation_id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                ))
            },
        )
        .expect("stored invalidation");
    assert_eq!(stored.0.as_deref(), Some("superseded"));
    assert_eq!(stored.1, Some(1));
}
