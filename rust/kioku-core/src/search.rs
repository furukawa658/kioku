use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use anyhow::{Context, Result};
use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags, Row, params_from_iter};
use serde_json::{Map, Value as JsonValue, json};

pub fn default_database_path() -> PathBuf {
    let root = std::env::var_os("CLAUDE_MEM_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|path| path.join(".claude-mem"))
        })
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .map(|path| path.join(".claude-mem"))
        })
        .unwrap_or_else(|| PathBuf::from(".claude-mem"));
    root.join("claude-mem.db")
}

pub fn open_read_only(path: &PathBuf) -> Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open kioku database at {}", path.display()))
}

pub fn search(path: &PathBuf, arguments: &JsonValue) -> Result<JsonValue> {
    search_with_limit(path, arguments, 100)
}

fn search_with_limit(path: &PathBuf, arguments: &JsonValue, limit_max: usize) -> Result<JsonValue> {
    let connection = open_read_only(path)?;
    let query = arguments
        .get("query")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .trim();
    let limit = bounded_usize(arguments, "limit", 20, limit_max);
    let offset = bounded_usize(arguments, "offset", 0, i64::MAX as usize);
    let requested_category = arguments
        .get("type")
        .and_then(JsonValue::as_str)
        .unwrap_or("all");
    let category = if ["all", "observations", "sessions", "prompts"].contains(&requested_category) {
        requested_category
    } else {
        "observations"
    };
    let project = arguments.get("project").and_then(JsonValue::as_str);
    let order = arguments
        .get("orderBy")
        .and_then(JsonValue::as_str)
        .unwrap_or("relevance");

    let mut result = Map::new();
    if category == "all" || category == "observations" {
        result.insert(
            "observations".into(),
            JsonValue::Array(search_observations(
                &connection,
                arguments,
                query,
                project,
                limit,
                offset,
                order,
            )?),
        );
    } else {
        result.insert("observations".into(), JsonValue::Array(Vec::new()));
    }
    if category == "all" || category == "sessions" {
        result.insert(
            "sessions".into(),
            JsonValue::Array(search_sessions(
                &connection,
                query,
                project,
                limit,
                offset,
                order,
            )?),
        );
    } else {
        result.insert("sessions".into(), JsonValue::Array(Vec::new()));
    }
    if category == "all" || category == "prompts" {
        result.insert(
            "prompts".into(),
            JsonValue::Array(search_prompts(&connection, query, limit, offset, order)?),
        );
    } else {
        result.insert("prompts".into(), JsonValue::Array(Vec::new()));
    }
    Ok(JsonValue::Object(result))
}

pub fn search_index(path: &PathBuf, arguments: &JsonValue) -> Result<JsonValue> {
    let mut value = search(path, arguments)?;
    if let Some(categories) = value.as_object_mut() {
        for (category, rows) in categories.iter_mut() {
            if let Some(rows) = rows.as_array_mut() {
                *rows = rows.drain(..).map(|row| index_row(category, row)).collect();
            }
        }
    }
    Ok(value)
}

pub fn search_index_with_semantic(
    path: &PathBuf,
    arguments: &JsonValue,
    semantic: &[JsonValue],
) -> Result<JsonValue> {
    let mut value = search_index(path, arguments)?;
    let query = arguments
        .get("query")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .trim();
    let order = arguments
        .get("orderBy")
        .and_then(JsonValue::as_str)
        .unwrap_or("relevance");
    let requested_type = arguments
        .get("type")
        .and_then(JsonValue::as_str)
        .unwrap_or("all");
    let includes_observations = requested_type != "sessions" && requested_type != "prompts";
    if query.is_empty() || order != "relevance" || !includes_observations || semantic.is_empty() {
        return Ok(value);
    }

    let limit = bounded_usize(arguments, "limit", 20, 100);
    let offset = bounded_usize(arguments, "offset", 0, i64::MAX as usize);
    let candidate_limit = offset.saturating_add(limit).clamp(100, 1000);
    let mut candidate_arguments = arguments.as_object().cloned().unwrap_or_default();
    candidate_arguments.insert("type".into(), json!("observations"));
    candidate_arguments.insert("limit".into(), json!(candidate_limit));
    candidate_arguments.insert("offset".into(), json!(0));
    let lexical = search_with_limit(
        path,
        &JsonValue::Object(candidate_arguments),
        candidate_limit,
    )?;
    let lexical_rows = lexical["observations"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let fused = fuse_ranked_rows(&lexical_rows, semantic, limit, offset)
        .into_iter()
        .map(|row| index_row("observations", row))
        .collect();
    value
        .as_object_mut()
        .expect("search index result is an object")
        .insert("observations".into(), JsonValue::Array(fused));
    Ok(value)
}

fn fuse_ranked_rows(
    lexical: &[JsonValue],
    semantic: &[JsonValue],
    limit: usize,
    offset: usize,
) -> Vec<JsonValue> {
    const RRF_K: f64 = 60.0;
    let mut candidates: HashMap<i64, (f64, usize, JsonValue)> = HashMap::new();
    let mut insertion_order = 0;

    for ranked_rows in [lexical, semantic] {
        let mut seen = HashSet::new();
        for (index, row) in ranked_rows.iter().enumerate() {
            let Some(id) = row.get("id").and_then(JsonValue::as_i64) else {
                continue;
            };
            if !seen.insert(id) {
                continue;
            }
            let contribution = 1.0 / (RRF_K + index as f64 + 1.0);
            candidates
                .entry(id)
                .and_modify(|(score, _, existing)| {
                    *score += contribution;
                    if existing.as_object().is_none() {
                        *existing = row.clone();
                    }
                })
                .or_insert_with(|| {
                    let order = insertion_order;
                    insertion_order += 1;
                    (contribution, order, row.clone())
                });
        }
    }

    let mut ranked = candidates.into_values().collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .0
            .total_cmp(&left.0)
            .then_with(|| left.1.cmp(&right.1))
    });
    ranked
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(_, _, row)| row)
        .collect()
}

fn index_row(category: &str, row: JsonValue) -> JsonValue {
    let object = row.as_object().cloned().unwrap_or_default();
    let body_field = match category {
        "sessions" => "learned",
        "prompts" => "prompt_text",
        _ => "narrative",
    };
    let title_field = if category == "sessions" {
        "request"
    } else if category == "prompts" {
        "prompt_text"
    } else {
        "title"
    };
    let excerpt = object
        .get(body_field)
        .and_then(JsonValue::as_str)
        .map(truncate_index_text);
    let title = object
        .get(title_field)
        .and_then(JsonValue::as_str)
        .map(truncate_index_text);
    json!({
        "id": object.get("id"),
        "project": object.get("project"),
        "type": object.get("type"),
        "title": title,
        "created_at_epoch": object.get("created_at_epoch"),
        "excerpt": excerpt
    })
}

fn truncate_index_text(text: &str) -> String {
    const LIMIT: usize = 180;
    let flattened = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flattened.chars().count() <= LIMIT {
        flattened
    } else {
        format!(
            "{}…",
            flattened
                .chars()
                .take(LIMIT.saturating_sub(1))
                .collect::<String>()
        )
    }
}

pub fn get_observations(path: &PathBuf, arguments: &JsonValue) -> Result<JsonValue> {
    let connection = open_read_only(path)?;
    let ids = arguments
        .get("ids")
        .and_then(JsonValue::as_array)
        .context("ids must be an array")?
        .iter()
        .filter_map(JsonValue::as_i64)
        .take(100)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(json!([]));
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let params = ids.into_iter().map(Value::Integer).collect::<Vec<_>>();
    let sql = format!(
        "SELECT o.* FROM observations o WHERE o.id IN ({placeholders}) ORDER BY o.created_at_epoch, o.id"
    );
    Ok(JsonValue::Array(query_rows(&connection, &sql, &params)?))
}

pub fn timeline(path: &PathBuf, arguments: &JsonValue) -> Result<JsonValue> {
    let connection = open_read_only(path)?;
    let anchor = arguments
        .get("anchor")
        .and_then(JsonValue::as_i64)
        .context("timeline anchor must be an integer observation ID")?;
    let before = bounded_usize(arguments, "depth_before", 3, 50);
    let after = bounded_usize(arguments, "depth_after", 3, 50);
    let project = arguments.get("project").and_then(JsonValue::as_str);

    let (epoch, id) = connection
        .query_row(
            "SELECT created_at_epoch, id FROM observations WHERE id = ?",
            [anchor],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .context("Timeline anchor was not found")?;

    let mut project_clause = String::new();
    let mut params = Vec::new();
    if let Some(project) = project {
        project_clause.push_str(" AND project = ?");
        params.push(Value::Text(project.to_owned()));
    }
    if table_exists(&connection, "invalidated_observations")? {
        project_clause.push_str(" AND NOT EXISTS (SELECT 1 FROM invalidated_observations i WHERE i.observation_id = o.id)");
    }
    let before_sql = format!(
        "SELECT o.* FROM observations o WHERE (created_at_epoch < ? OR (created_at_epoch = ? AND id < ?)){project_clause} ORDER BY created_at_epoch DESC, id DESC LIMIT ?"
    );
    let after_sql = format!(
        "SELECT o.* FROM observations o WHERE (created_at_epoch > ? OR (created_at_epoch = ? AND id > ?)){project_clause} ORDER BY created_at_epoch ASC, id ASC LIMIT ?"
    );
    let anchor_sql = format!("SELECT o.* FROM observations o WHERE id = ?{project_clause}");

    let mut before_params = vec![
        Value::Integer(epoch),
        Value::Integer(epoch),
        Value::Integer(id),
    ];
    before_params.extend(params.clone());
    before_params.push(Value::Integer(before as i64));
    let mut after_params = vec![
        Value::Integer(epoch),
        Value::Integer(epoch),
        Value::Integer(id),
    ];
    after_params.extend(params.clone());
    after_params.push(Value::Integer(after as i64));
    let mut anchor_params = vec![Value::Integer(anchor)];
    anchor_params.extend(params);

    let mut before_rows = query_rows(&connection, &before_sql, &before_params)?;
    before_rows.reverse();
    let anchor_rows = query_rows(&connection, &anchor_sql, &anchor_params)?;
    let after_rows = query_rows(&connection, &after_sql, &after_params)?;
    before_rows.extend(anchor_rows);
    before_rows.extend(after_rows);
    Ok(JsonValue::Array(before_rows))
}

fn search_observations(
    connection: &Connection,
    arguments: &JsonValue,
    query: &str,
    project: Option<&str>,
    limit: usize,
    offset: usize,
    order: &str,
) -> Result<Vec<JsonValue>> {
    if query.is_empty() && project.is_none() {
        return Ok(Vec::new());
    }
    let mut params = Vec::new();
    let mut conditions = Vec::new();
    if let Some(project) = project {
        conditions.push("o.project = ?".to_owned());
        params.push(Value::Text(project.to_owned()));
    }
    let observation_type = arguments
        .get("obs_type")
        .and_then(JsonValue::as_str)
        .or_else(|| {
            arguments
                .get("type")
                .and_then(JsonValue::as_str)
                .filter(|value| !["all", "observations", "sessions", "prompts"].contains(value))
        });
    if let Some(observation_type) = observation_type {
        conditions.push("o.type = ?".to_owned());
        params.push(Value::Text(observation_type.to_owned()));
    }
    let concepts = arguments
        .get("concepts")
        .map(string_values)
        .unwrap_or_default();
    if !concepts.is_empty() {
        let placeholders = vec!["?"; concepts.len()].join(",");
        conditions.push(format!(
            "EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(o.concepts) THEN o.concepts ELSE '[]' END) WHERE value IN ({placeholders}))"
        ));
        params.extend(concepts.into_iter().map(Value::Text));
    }
    if table_exists(connection, "invalidated_observations")? {
        conditions.push(
            "NOT EXISTS (SELECT 1 FROM invalidated_observations i WHERE i.observation_id = o.id)"
                .to_owned(),
        );
    }
    let filters = if conditions.is_empty() {
        String::new()
    } else {
        format!(" AND {}", conditions.join(" AND "))
    };
    let order_sql = if order == "date_asc" {
        "o.created_at_epoch ASC, o.id ASC"
    } else if order == "date_desc" {
        "o.created_at_epoch DESC, o.id DESC"
    } else {
        "observations_fts.rank ASC, o.id ASC"
    };

    if !query.is_empty() && table_exists(connection, "observations_fts")? {
        let fts = fts_query(query);
        let sql = format!(
            "SELECT o.* FROM observations o JOIN observations_fts ON observations_fts.rowid = o.id WHERE observations_fts MATCH ?{filters} ORDER BY {order_sql} LIMIT ? OFFSET ?"
        );
        let mut values = vec![Value::Text(fts)];
        values.extend(params.clone());
        values.push(Value::Integer(limit as i64));
        values.push(Value::Integer(offset as i64));
        match query_rows(connection, &sql, &values) {
            Ok(rows) if !rows.is_empty() => return Ok(rows),
            Ok(_) => {}
            Err(_) => {}
        }
    }
    let substring = format!("%{}%", escape_like(query));
    let mut values = params;
    let text_filter = if query.is_empty() {
        String::new()
    } else {
        values.extend(std::iter::repeat_n(Value::Text(substring), 6));
        " AND (o.title LIKE ? ESCAPE '\\' OR o.subtitle LIKE ? ESCAPE '\\' OR o.narrative LIKE ? ESCAPE '\\' OR o.text LIKE ? ESCAPE '\\' OR o.facts LIKE ? ESCAPE '\\' OR o.concepts LIKE ? ESCAPE '\\')".to_owned()
    };
    let fallback_order = if order == "date_asc" {
        "o.created_at_epoch ASC, o.id ASC"
    } else {
        "o.created_at_epoch DESC, o.id DESC"
    };
    values.push(Value::Integer(limit as i64));
    values.push(Value::Integer(offset as i64));
    let sql = format!(
        "SELECT o.* FROM observations o WHERE 1=1{filters}{text_filter} ORDER BY {fallback_order} LIMIT ? OFFSET ?"
    );
    query_rows(connection, &sql, &values)
}

fn search_sessions(
    connection: &Connection,
    query: &str,
    project: Option<&str>,
    limit: usize,
    offset: usize,
    order: &str,
) -> Result<Vec<JsonValue>> {
    if !table_exists(connection, "session_summaries")? || (query.is_empty() && project.is_none()) {
        return Ok(Vec::new());
    }
    let mut conditions = Vec::new();
    let mut params = Vec::new();
    if let Some(project) = project {
        conditions.push("s.project = ?".to_owned());
        params.push(Value::Text(project.to_owned()));
    }
    let filters = if conditions.is_empty() {
        String::new()
    } else {
        format!(" AND {}", conditions.join(" AND "))
    };
    let order_sql = if order == "date_asc" {
        "s.created_at_epoch ASC, s.id ASC"
    } else {
        "s.created_at_epoch DESC, s.id DESC"
    };
    if !query.is_empty() && table_exists(connection, "session_summaries_fts")? {
        let sql = format!(
            "SELECT s.* FROM session_summaries s JOIN session_summaries_fts ON session_summaries_fts.rowid = s.id WHERE session_summaries_fts MATCH ?{filters} ORDER BY session_summaries_fts.rank LIMIT ? OFFSET ?"
        );
        let mut values = vec![Value::Text(fts_query(query))];
        values.extend(params.clone());
        values.push(Value::Integer(limit as i64));
        values.push(Value::Integer(offset as i64));
        match query_rows(connection, &sql, &values) {
            Ok(rows) if !rows.is_empty() => return Ok(rows),
            Ok(_) => {}
            Err(_) => {}
        }
    }
    let like = format!("%{}%", escape_like(query));
    let mut values = params;
    let text_filter = if query.is_empty() {
        String::new()
    } else {
        values.extend(std::iter::repeat_n(Value::Text(like), 6));
        " AND (s.request LIKE ? ESCAPE '\\' OR s.investigated LIKE ? ESCAPE '\\' OR s.learned LIKE ? ESCAPE '\\' OR s.completed LIKE ? ESCAPE '\\' OR s.next_steps LIKE ? ESCAPE '\\' OR s.notes LIKE ? ESCAPE '\\')".to_owned()
    };
    values.push(Value::Integer(limit as i64));
    values.push(Value::Integer(offset as i64));
    query_rows(
        connection,
        &format!(
            "SELECT s.* FROM session_summaries s WHERE 1=1{filters}{text_filter} ORDER BY {order_sql} LIMIT ? OFFSET ?"
        ),
        &values,
    )
}

fn search_prompts(
    connection: &Connection,
    query: &str,
    limit: usize,
    offset: usize,
    order: &str,
) -> Result<Vec<JsonValue>> {
    if !table_exists(connection, "user_prompts")? || query.is_empty() {
        return Ok(Vec::new());
    }
    let order_sql = if order == "date_asc" {
        "created_at_epoch ASC, id ASC"
    } else {
        "created_at_epoch DESC, id DESC"
    };
    query_rows(
        connection,
        &format!(
            "SELECT * FROM user_prompts WHERE prompt_text LIKE ? ESCAPE '\\' ORDER BY {order_sql} LIMIT ? OFFSET ?"
        ),
        &[
            Value::Text(format!("%{}%", escape_like(query))),
            Value::Integer(limit as i64),
            Value::Integer(offset as i64),
        ],
    )
}

fn query_rows(connection: &Connection, sql: &str, params: &[Value]) -> Result<Vec<JsonValue>> {
    let mut statement = connection
        .prepare(sql)
        .with_context(|| format!("Invalid search SQL: {sql}"))?;
    let columns = statement.column_names();
    let names = columns
        .iter()
        .map(|name| name.to_string())
        .collect::<Vec<_>>();
    let mut rows = statement.query(params_from_iter(params.iter()))?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        result.push(row_to_json(row, &names)?);
    }
    Ok(result)
}

fn row_to_json(row: &Row<'_>, names: &[String]) -> Result<JsonValue> {
    let mut object = Map::new();
    for (index, name) in names.iter().enumerate() {
        let value = match row.get_ref(index)? {
            rusqlite::types::ValueRef::Null => JsonValue::Null,
            rusqlite::types::ValueRef::Integer(value) => json!(value),
            rusqlite::types::ValueRef::Real(value) => json!(value),
            rusqlite::types::ValueRef::Text(value) => {
                JsonValue::String(String::from_utf8_lossy(value).into_owned())
            }
            rusqlite::types::ValueRef::Blob(value) => {
                JsonValue::Array(value.iter().map(|value| json!(value)).collect())
            }
        };
        object.insert(name.clone(), value);
    }
    Ok(JsonValue::Object(object))
}

fn table_exists(connection: &Connection, name: &str) -> Result<bool> {
    let found = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?)",
        [name],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(found != 0)
}

fn bounded_usize(arguments: &JsonValue, key: &str, default: usize, max: usize) -> usize {
    arguments
        .get(key)
        .and_then(JsonValue::as_u64)
        .map(|value| value.min(max as u64) as usize)
        .unwrap_or(default)
}

fn string_values(value: &JsonValue) -> Vec<String> {
    match value {
        JsonValue::String(text) => text
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
        JsonValue::Array(values) => values
            .iter()
            .filter_map(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

fn fts_query(query: &str) -> String {
    let tokens = query
        .split_whitespace()
        .filter(|token| token.chars().any(char::is_alphanumeric))
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    if tokens.is_empty() {
        format!("\"{}\"", query.replace('"', "\"\""))
    } else {
        tokens.join(" AND ")
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().expect("temp database directory");
        let path = directory.path().join("claude-mem.db");
        let connection = Connection::open(&path).expect("open fixture database");
        connection
            .execute_batch(
                r#"
            CREATE TABLE observations (
                id INTEGER PRIMARY KEY,
                memory_session_id TEXT NOT NULL,
                project TEXT NOT NULL,
                text TEXT NOT NULL,
                type TEXT NOT NULL,
                title TEXT,
                subtitle TEXT,
                narrative TEXT,
                facts TEXT,
                concepts TEXT,
                files_read TEXT,
                files_modified TEXT,
                prompt_number INTEGER,
                discovery_tokens INTEGER,
                created_at TEXT NOT NULL,
                created_at_epoch INTEGER NOT NULL
            );
            CREATE VIRTUAL TABLE observations_fts USING fts5(
                title, subtitle, narrative, text, facts, concepts,
                content='observations', content_rowid='id', tokenize='unicode61'
            );
            CREATE TABLE invalidated_observations (
                observation_id INTEGER PRIMARY KEY,
                reason TEXT,
                replaced_by INTEGER,
                invalidated_at_epoch INTEGER NOT NULL
            );
        "#,
            )
            .expect("create fixture schema");
        for (id, project, title, narrative, epoch) in [
            (
                1,
                "kioku",
                "API handler",
                "FetchUserProfileAsync failed with E_AUTH_EXPIRED",
                1000,
            ),
            (
                2,
                "kioku",
                "Current API handler",
                "FetchUserProfileAsync now renews the token",
                2000,
            ),
            (
                3,
                "other",
                "Unrelated project",
                "FetchUserProfileAsync has a different contract",
                3000,
            ),
        ] {
            connection.execute(
                "INSERT INTO observations VALUES (?1, 'session', ?2, 'note', 'discovery', ?3, NULL, ?4, '[]', '[]', '[]', '[]', 1, 10, '2026-11-20', ?5)",
                rusqlite::params![id, project, title, narrative, epoch],
            ).expect("insert observation");
            connection.execute(
                "INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts) SELECT id, title, subtitle, narrative, text, facts, concepts FROM observations WHERE id = ?",
                [id],
            ).expect("index observation");
        }
        connection
            .execute(
                "INSERT INTO invalidated_observations VALUES (1, 'superseded', 2, 4000)",
                [],
            )
            .expect("invalidate old observation");
        drop(connection);
        (directory, path)
    }

    #[test]
    fn searches_existing_fts_and_excludes_invalidated_rows() {
        let (_directory, path) = fixture();
        let result = search(
            &path,
            &json!({"query":"FetchUserProfileAsync", "project":"kioku"}),
        )
        .expect("search fixture");
        let ids = result["observations"]
            .as_array()
            .expect("observations array")
            .iter()
            .map(|row| row["id"].as_i64().expect("id"))
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![2]);
    }

    #[test]
    fn search_index_omits_full_observation_content() {
        let (_directory, path) = fixture();
        let result = search_index(
            &path,
            &json!({"query":"FetchUserProfileAsync", "project":"kioku"}),
        )
        .expect("search index");
        let row = &result["observations"][0];
        assert_eq!(row["id"], 2);
        assert_eq!(row["title"], "Current API handler");
        assert!(row.get("narrative").is_none());
        assert!(row["excerpt"].as_str().expect("excerpt").chars().count() <= 180);
    }

    #[test]
    fn reciprocal_rank_fusion_rewards_candidates_from_both_legs() {
        let lexical = vec![json!({"id":1}), json!({"id":2}), json!({"id":3})];
        let semantic = vec![json!({"id":2}), json!({"id":4}), json!({"id":1})];

        let fused = fuse_ranked_rows(&lexical, &semantic, 3, 0);
        let ids = fused
            .iter()
            .map(|row| row["id"].as_i64().expect("id"))
            .collect::<Vec<_>>();

        assert_eq!(ids, vec![2, 1, 4]);
    }

    #[test]
    fn search_index_includes_semantic_only_candidates() {
        let (_directory, path) = fixture();
        let semantic = vec![json!({
            "id": 3,
            "project": "kioku",
            "type": "discovery",
            "title": "Semantic-only match",
            "narrative": "Token refresh pattern without the literal keyword",
            "created_at_epoch": 3000
        })];

        let result = search_index_with_semantic(
            &path,
            &json!({"query":"renews token", "project":"kioku", "limit":5}),
            &semantic,
        )
        .expect("hybrid search index");
        let ids = result["observations"]
            .as_array()
            .expect("observations")
            .iter()
            .map(|row| row["id"].as_i64().expect("id"))
            .collect::<Vec<_>>();

        assert_eq!(ids, vec![2, 3]);
    }

    #[test]
    fn supports_observation_type_alias_and_concepts() {
        let (_directory, path) = fixture();
        let connection = Connection::open(&path).expect("open fixture database");
        connection
            .execute(
                "UPDATE observations SET concepts = '[\"lesson\"]' WHERE id = 2",
                [],
            )
            .expect("set lesson concept");
        drop(connection);
        let result = search(
            &path,
            &json!({"query":"FetchUserProfileAsync", "type":"discovery", "concepts":"lesson", "project":"kioku"}),
        )
        .expect("filtered search");
        let ids = result["observations"]
            .as_array()
            .expect("observations")
            .iter()
            .map(|row| row["id"].as_i64().expect("id"))
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![2]);
        assert!(result["sessions"].as_array().expect("sessions").is_empty());
    }

    #[test]
    fn falls_back_to_substrings_for_unsegmented_text() {
        let (_directory, path) = fixture();
        let connection = Connection::open(&path).expect("open fixture database");
        connection
            .execute(
                "UPDATE observations SET narrative = '設定項目を確認する' WHERE id = 2",
                [],
            )
            .expect("update fixture");
        connection.execute("INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts) VALUES ('delete', 2, 'Current API handler', NULL, 'FetchUserProfileAsync now renews the token', 'note', '[]', '[]')", []).expect("delete stale fts row");
        connection.execute("INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts) VALUES (2, 'Current API handler', NULL, '設定項目を確認する', 'note', '[]', '[]')", []).expect("reindex fixture");
        drop(connection);
        let result = search(&path, &json!({"query":"設定項目", "project":"kioku"}))
            .expect("search Japanese fixture");
        assert_eq!(result["observations"][0]["id"], 2);
    }

    #[test]
    fn timeline_surrounds_the_anchor_without_crossing_projects() {
        let (_directory, path) = fixture();
        let result = timeline(
            &path,
            &json!({"anchor":2,"project":"kioku","depth_before":2,"depth_after":2}),
        )
        .expect("timeline fixture");
        assert_eq!(
            result
                .as_array()
                .expect("timeline array")
                .iter()
                .map(|row| row["id"].as_i64().expect("id"))
                .collect::<Vec<_>>(),
            vec![2]
        );
    }
}
