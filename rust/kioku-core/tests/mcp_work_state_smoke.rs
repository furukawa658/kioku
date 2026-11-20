use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde_json::{Value, json};

#[test]
fn mcp_process_reads_work_state_with_only_worker_context() {
    let directory = tempfile::tempdir().expect("temporary database directory");
    let database = directory.path().join("claude-mem.db");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("current epoch")
        .as_millis() as i64;
    let connection = Connection::open(&database).expect("open fixture database");
    connection
        .execute_batch(
            r#"
            CREATE TABLE work_state_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project TEXT NOT NULL,
                list_name TEXT NOT NULL,
                fields TEXT NOT NULL,
                created_at TEXT NOT NULL,
                created_at_epoch INTEGER NOT NULL,
                origin_device_id TEXT,
                origin_local_id TEXT
            );
            "#,
        )
        .expect("create work state fixture");
    connection
        .execute(
            "INSERT INTO work_state_entries (project, list_name, fields, created_at, created_at_epoch) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                "kioku",
                "release",
                r#"{"task":"publish","status":"doing","note":"ready","branch":"main"}"#,
                "2026-11-20T00:00:00.000Z",
                now - 60_000,
            ],
        )
        .expect("insert work state");
    drop(connection);

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind worker context server");
    let address = listener.local_addr().expect("worker context address");
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept context request");
        let mut request = [0_u8; 4096];
        let size = stream.read(&mut request).expect("read context request");
        let request = String::from_utf8_lossy(&request[..size]);
        assert!(request.starts_with("GET /api/work-state/read-context?cwd="));
        let body = serde_json::to_string(&json!({
            "primary":"kioku",
            "projects":["kioku"],
            "readProjects":["kioku"],
            "localDeviceId":""
        }))
        .expect("context JSON");
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("write context response");
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_kioku-core"))
        .env_remove("CLAUDE_MEM_WORKER_URL")
        .arg("--database")
        .arg(&database)
        .arg("--worker-url")
        .arg(format!("http://{address}"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kioku-core");
    let request = json!({
        "jsonrpc":"2.0",
        "id":2,
        "method":"tools/call",
        "params":{
            "name":"work_state_read",
            "arguments":{"list":"release","includeClosed":false}
        }
    });
    writeln!(
        child.stdin.take().expect("child stdin"),
        "{}",
        serde_json::to_string(&request).expect("serialize request")
    )
    .expect("send MCP request");

    let output = child.wait_with_output().expect("wait for kioku-core");
    server.join().expect("worker context server");
    assert!(
        output.status.success(),
        "kioku-core failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).expect("parse MCP response");
    assert_eq!(response["result"]["isError"], false);
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .expect("MCP text response");
    assert!(text.starts_with("- release\n  - [doing] publish (note=ready, branch=main), updated "));
}

#[test]
fn mcp_process_falls_back_for_workers_without_read_context() {
    let directory = tempfile::tempdir().expect("temporary database directory");
    let database = directory.path().join("claude-mem.db");
    Connection::open(&database).expect("create database");

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind legacy worker server");
    let address = listener.local_addr().expect("legacy worker address");
    let server = thread::spawn(move || {
        for response in [
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 22\r\nConnection: close\r\n\r\nlegacy work state\ntext",
        ] {
            let (mut stream, _) = listener.accept().expect("accept worker request");
            let mut request = [0_u8; 4096];
            let size = stream.read(&mut request).expect("read worker request");
            assert!(size > 0);
            stream
                .write_all(response.as_bytes())
                .expect("write worker response");
        }
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_kioku-core"))
        .env_remove("CLAUDE_MEM_WORKER_URL")
        .arg("--database")
        .arg(&database)
        .arg("--worker-url")
        .arg(format!("http://{address}"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kioku-core");
    let request = json!({
        "jsonrpc":"2.0",
        "id":3,
        "method":"tools/call",
        "params":{"name":"work_state_read","arguments":{"includeClosed":true}}
    });
    writeln!(
        child.stdin.take().expect("child stdin"),
        "{}",
        serde_json::to_string(&request).expect("serialize request")
    )
    .expect("send MCP request");

    let output = child.wait_with_output().expect("wait for kioku-core");
    server.join().expect("legacy worker server");
    assert!(output.status.success());
    let response: Value = serde_json::from_slice(&output.stdout).expect("parse MCP response");
    assert_eq!(response["result"]["isError"], false);
    assert_eq!(
        response["result"]["content"][0]["text"],
        "legacy work state\ntext"
    );
}
