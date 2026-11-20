use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::search;

pub fn serve(database: &PathBuf, worker_url: &str) -> Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                write_json(
                    &mut output,
                    &json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":format!("Parse error: {error}")}}),
                )?;
                continue;
            }
        };
        if let Some(response) = handle_request(database, worker_url, request)? {
            write_json(&mut output, &response)?;
        }
    }
    Ok(())
}

fn handle_request(database: &PathBuf, worker_url: &str, request: Value) -> Result<Option<Value>> {
    let id = request.get("id").cloned();
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if id.is_none() {
        return Ok(None);
    }
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match method {
        "initialize" => initialize(&params),
        "tools/list" => tools_list(),
        "tools/call" => call_tool(database, worker_url, &params),
        "ping" => Ok(json!({})),
        _ => Err(json!({"code":-32601,"message":format!("Method not found: {method}")})),
    };
    Ok(Some(match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(error) => json!({"jsonrpc":"2.0","id":id,"error":error}),
    }))
}

fn initialize(params: &Value) -> std::result::Result<Value, Value> {
    let protocol = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or("2025-06-18");
    Ok(json!({
        "protocolVersion": protocol,
        "capabilities": {"tools": {}},
        "serverInfo": {"name": "kioku-rust", "version": env!("CARGO_PKG_VERSION")},
        "instructions": "Use search, then timeline, then get_observations. save_memory and work-state tools are delegated to the existing local kioku worker."
    }))
}

fn tools_list() -> std::result::Result<Value, Value> {
    Ok(json!({"tools":[
        tool("search", "Search local observations, sessions and prompts using the existing SQLite database.", json!({
            "type":"object",
            "properties": {
                "query":{"type":"string"}, "limit":{"type":"integer"}, "offset":{"type":"integer"},
                "project":{"type":"string"}, "type":{"type":"string"}, "obs_type":{"type":"string"},
                "concepts":{"type":"string"}, "orderBy":{"type":"string","enum":["relevance","date_desc","date_asc"]}
            }, "required":["query"], "additionalProperties":false
        })),
        tool("dumb_search", "Fast SQLite keyword search without semantic ranking.", json!({
            "type":"object", "properties": {"query":{"type":"string"}, "limit":{"type":"integer"}, "project":{"type":"string"}},
            "required":["query"], "additionalProperties":false
        })),
        tool("timeline", "Get chronological context around one observation ID.", json!({
            "type":"object", "properties": {"anchor":{"type":"integer"}, "depth_before":{"type":"integer"}, "depth_after":{"type":"integer"}, "project":{"type":"string"}},
            "required":["anchor"], "additionalProperties":false
        })),
        tool("get_observations", "Fetch selected observation rows by ID.", json!({
            "type":"object", "properties": {"ids":{"type":"array","items":{"type":"integer"},"maxItems":100}},
            "required":["ids"], "additionalProperties":false
        })),
        tool("save_memory", "Save a durable local memory through the compatible kioku worker.", json!({"type":"object","additionalProperties":true})),
        tool("invalidate_memory", "Invalidate or restore a local memory through the compatible kioku worker.", json!({"type":"object","additionalProperties":true})),
        tool("work_state_read", "Read work state through the compatible kioku worker.", json!({"type":"object","additionalProperties":true})),
        tool("work_state_write", "Write work state through the compatible kioku worker.", json!({"type":"object","additionalProperties":true}))
    ]}))
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({"name":name,"description":description,"inputSchema":input_schema})
}

fn call_tool(
    database: &PathBuf,
    worker_url: &str,
    params: &Value,
) -> std::result::Result<Value, Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let result = (|| -> Result<Value> {
        match name {
            "search" | "dumb_search" => Ok(search::search_index(database, &arguments)?),
            "timeline" => Ok(search::timeline(database, &arguments)?),
            "get_observations" => Ok(search::get_observations(database, &arguments)?),
            "save_memory" => {
                worker_json(worker_url, "POST", "/api/memory/save", &with_cwd(arguments))
            }
            "invalidate_memory" => {
                worker_json(worker_url, "POST", "/api/memory/invalidate", &arguments)
            }
            "work_state_write" => Ok(Value::String(worker_text_post(
                worker_url,
                "/api/work-state/entries",
                &work_state_body(arguments),
            )?)),
            "work_state_read" => Ok(Value::String(worker_get_text(
                worker_url,
                "/api/work-state",
                &work_state_query(arguments),
            )?)),
            _ => anyhow::bail!("Unknown tool: {name}"),
        }
    })();
    match result {
        Ok(value) => Ok(text_result(value, false)),
        Err(error) => Ok(text_result(json!(error.to_string()), true)),
    }
}

fn text_result(value: Value, is_error: bool) -> Value {
    let text = if let Value::String(text) = value {
        text
    } else {
        serde_json::to_string(&value).unwrap_or_else(|_| "null".to_owned())
    };
    json!({"content":[{"type":"text","text":text}],"isError":is_error})
}

fn with_cwd(arguments: Value) -> Value {
    let mut body = arguments.as_object().cloned().unwrap_or_default();
    if !body.contains_key("cwd")
        && let Ok(cwd) = std::env::current_dir()
    {
        body.insert("cwd".into(), json!(cwd.to_string_lossy()));
    }
    Value::Object(body)
}

fn work_state_body(arguments: Value) -> Value {
    let mut body = arguments.as_object().cloned().unwrap_or_default();
    if let Ok(cwd) = std::env::current_dir() {
        body.insert("cwd".into(), json!(cwd.to_string_lossy()));
    }
    Value::Object(body)
}

fn work_state_query(arguments: Value) -> Vec<(String, String)> {
    let mut query = vec![(
        "cwd".to_owned(),
        std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
    )];
    if let Some(object) = arguments.as_object() {
        for (key, value) in object {
            if let Some(value) = value.as_str() {
                query.push((key.clone(), value.to_owned()));
            } else if let Some(value) = value.as_bool() {
                query.push((key.clone(), value.to_string()));
            }
        }
    }
    query
}

fn worker_json(worker_url: &str, method: &str, path: &str, body: &Value) -> Result<Value> {
    let url = format!("{}{}", worker_url.trim_end_matches('/'), path);
    let request = match method {
        "POST" => ureq::post(&url),
        _ => anyhow::bail!("Unsupported worker method: {method}"),
    };
    request
        .set("Content-Type", "application/json")
        .send_json(body.clone())
        .with_context(|| format!("Could not call kioku worker at {url}"))?
        .into_json::<Value>()
        .context("Worker returned invalid JSON")
}

fn worker_text_post(worker_url: &str, path: &str, body: &Value) -> Result<String> {
    let url = format!("{}{}", worker_url.trim_end_matches('/'), path);
    ureq::post(&url)
        .set("Content-Type", "application/json")
        .send_json(body.clone())
        .with_context(|| format!("Could not call kioku worker at {url}"))?
        .into_string()
        .context("Worker returned invalid text")
}

fn worker_get_text(worker_url: &str, path: &str, query: &[(String, String)]) -> Result<String> {
    let mut request = ureq::get(&format!("{}{}", worker_url.trim_end_matches('/'), path));
    for (key, value) in query {
        request = request.query(key, value);
    }
    request
        .call()
        .context("Could not query kioku worker")?
        .into_string()
        .context("Worker returned invalid text")
}

fn write_json(writer: &mut impl Write, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_with_the_requested_protocol() {
        let response = handle_request(
            &PathBuf::from("unused.db"),
            "http://127.0.0.1:37777",
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}),
        ).expect("initialize request").expect("initialize response");
        assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(response["result"]["serverInfo"]["name"], "kioku-rust");
    }

    #[test]
    fn advertises_the_staged_eight_tool_contract() {
        let response = handle_request(
            &PathBuf::from("unused.db"),
            "http://127.0.0.1:37777",
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
        )
        .expect("tools request")
        .expect("tools response");
        let names = response["result"]["tools"]
            .as_array()
            .expect("tool list")
            .iter()
            .map(|tool| tool["name"].as_str().expect("tool name"))
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "search",
                "dumb_search",
                "timeline",
                "get_observations",
                "save_memory",
                "invalidate_memory",
                "work_state_read",
                "work_state_write"
            ]
        );
    }

    #[test]
    fn notifications_do_not_receive_responses() {
        let response = handle_request(
            &PathBuf::from("unused.db"),
            "http://127.0.0.1:37777",
            json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
        )
        .expect("notification");
        assert!(response.is_none());
    }
}
