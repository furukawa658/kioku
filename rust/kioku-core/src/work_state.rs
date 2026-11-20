use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OpenFlags, params_from_iter};
use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};

const FIELD_ORDER_KEY: &str = "\0kioku_field_order";
const STALE_AFTER_MS: i64 = 14 * 24 * 60 * 60 * 1_000;

pub struct RenderOptions {
    pub include_closed: bool,
    pub include_stale: bool,
}

pub fn read(database: &Path, arguments: &Value, context: &Value) -> Result<String> {
    let primary = context
        .get("primary")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .context("Worker work-state context is missing primary")?;
    let projects = required_string_array(context, "projects")?;
    let read_projects = required_string_array(context, "readProjects")?;
    let local_device_id = context
        .get("localDeviceId")
        .and_then(Value::as_str)
        .context("Worker work-state context is missing localDeviceId")?;
    let list = arguments
        .get("list")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let include_closed = arguments
        .get("includeClosed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let include_stale = list.is_some()
        || arguments
            .get("includeStale")
            .and_then(Value::as_bool)
            .unwrap_or(false);

    let entries = if read_projects.is_empty() || list.is_some_and(is_shared_list) {
        Vec::new()
    } else {
        read_entries(database, &read_projects, list, local_device_id, &projects)?
    };
    let now_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("System clock is before the Unix epoch")?
        .as_millis() as i64;
    if let Some(text) = render_read_text(
        &entries,
        now_epoch,
        &RenderOptions {
            include_closed,
            include_stale,
        },
    ) {
        return Ok(text);
    }
    let list_text = list
        .map(|value| format!(" in \"{value}\""))
        .unwrap_or_default();
    if include_closed {
        Ok(format!("Nothing recorded{list_text} for {primary}."))
    } else {
        Ok(format!(
            "Nothing open{list_text} for {primary}. Pass includeClosed to see closed items."
        ))
    }
}

fn required_string_array<'a>(context: &'a Value, key: &str) -> Result<Vec<&'a str>> {
    let values = context
        .get(key)
        .and_then(Value::as_array)
        .with_context(|| format!("Worker work-state context is missing {key}"))?;
    if values.is_empty() {
        anyhow::bail!("Worker work-state context has empty {key}");
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|item| !item.is_empty())
                .with_context(|| format!("Worker work-state context has invalid {key}"))
        })
        .collect()
}

fn read_entries(
    database: &Path,
    read_projects: &[&str],
    list: Option<&str>,
    local_device_id: &str,
    scope_projects: &[&str],
) -> Result<Vec<Value>> {
    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open kioku database at {}", database.display()))?;
    let table_exists = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_state_entries')",
        [],
        |row| row.get::<_, i64>(0),
    )? != 0;
    if !table_exists {
        return Ok(Vec::new());
    }

    let placeholders = (0..read_projects.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let list_filter = if list.is_some() {
        " AND list_name = ?"
    } else {
        ""
    };
    let sql = format!(
        "SELECT id, project, list_name, fields, created_at_epoch \
         FROM work_state_entries \
         WHERE project COLLATE NOCASE IN ({placeholders}){list_filter} \
           AND NOT ( \
             list_name GLOB '__my_work_v[0-9]*:*' \
             AND substr(list_name, 12, instr(substr(list_name, 12), ':') - 1) NOT GLOB '*[^0-9]*' \
           ) \
         ORDER BY created_at_epoch, COALESCE(origin_device_id, ?), COALESCE(CAST(origin_local_id AS INTEGER), id)"
    );
    let mut params = read_projects
        .iter()
        .map(|value| SqlValue::Text((*value).to_owned()))
        .collect::<Vec<_>>();
    if let Some(list) = list {
        params.push(SqlValue::Text(list.to_owned()));
    }
    params.push(SqlValue::Text(local_device_id.to_owned()));
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(params), |row| {
        let fields: String = row.get(3)?;
        let fields_value = serde_json::from_str::<Value>(&fields).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        let field_order = serde_json::from_str::<OrderedFieldNames>(&fields)
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?
            .0;
        Ok(json!({
            "id": row.get::<_, i64>(0)?,
            "project": row.get::<_, String>(1)?,
            "list_name": row.get::<_, String>(2)?,
            "fields": fields_value,
            "field_order": field_order,
            "created_at_epoch": row.get::<_, i64>(4)?,
        }))
    })?;

    let scope_primary = scope_projects.last().copied();
    let mut entries = Vec::new();
    for row in rows {
        let mut row = row?;
        if let Some(primary) = scope_primary
            && let Some(project) = row["project"].as_str()
            && scope_projects
                .iter()
                .any(|alias| alias.eq_ignore_ascii_case(project))
        {
            row["scope_project"] = Value::String(primary.to_owned());
        }
        entries.push(row);
    }
    Ok(entries)
}

#[derive(Default)]
struct FoldedList {
    state: Map<String, Value>,
    state_updated_at_epoch: Option<i64>,
    tasks: Vec<(String, Map<String, Value>, i64)>,
}

fn entry_epoch(entry: &Value) -> i64 {
    entry["created_at_epoch"].as_i64().unwrap_or_default()
}

fn entry_project(entry: &Value) -> &str {
    entry["scope_project"]
        .as_str()
        .or_else(|| entry["project"].as_str())
        .unwrap_or_default()
}

fn entry_list(entry: &Value) -> &str {
    entry["list_name"].as_str().unwrap_or_default()
}

fn entry_fields(entry: &Value) -> Map<String, Value> {
    let mut fields = entry["fields"].as_object().cloned().unwrap_or_default();
    if let Some(order) = entry.get("field_order").cloned() {
        fields.insert(FIELD_ORDER_KEY.to_owned(), order);
    }
    fields
}

fn field_order(fields: &Map<String, Value>) -> Vec<String> {
    fields
        .get(FIELD_ORDER_KEY)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

struct OrderedFieldNames(Vec<String>);

impl<'de> Deserialize<'de> for OrderedFieldNames {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct FieldNameVisitor;

        impl<'de> Visitor<'de> for FieldNameVisitor {
            type Value = OrderedFieldNames;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a work-state fields object")
            }

            fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut names = Vec::new();
                while let Some((name, _)) = map.next_entry::<String, IgnoredAny>()? {
                    names.push(name);
                }
                Ok(OrderedFieldNames(names))
            }
        }

        deserializer.deserialize_map(FieldNameVisitor)
    }
}

fn scalar_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn is_closed(fields: &Map<String, Value>) -> bool {
    fields
        .get("status")
        .and_then(scalar_string)
        .is_some_and(|status| {
            status.eq_ignore_ascii_case("done") || status.eq_ignore_ascii_case("dropped")
        })
}

fn is_shared_list(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("__my_work_v") else {
        return false;
    };
    let Some(version_end) = rest.find(':') else {
        return false;
    };
    let version = &rest[..version_end];
    !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit())
}

fn describe_duration(milliseconds: i64) -> String {
    let minutes = (milliseconds.max(0) as f64 / 60_000.0).round().max(1.0) as i64;
    if minutes < 60 {
        format!("{minutes} minute{}", if minutes == 1 { "" } else { "s" })
    } else {
        let hours = (minutes as f64 / 60.0).round() as i64;
        if hours < 48 {
            format!("about {hours} hour{}", if hours == 1 { "" } else { "s" })
        } else {
            format!("about {} days", (hours as f64 / 24.0).round() as i64)
        }
    }
}

fn updated_ago(epoch: i64, now_epoch: i64) -> String {
    format!("updated {} ago", describe_duration(now_epoch - epoch))
}

fn format_fields(fields: &Map<String, Value>, omitted: &[&str]) -> String {
    let ordered_names = field_order(fields);
    let mut names = ordered_names
        .iter()
        .filter(|key| fields.contains_key(*key))
        .cloned()
        .collect::<Vec<_>>();
    let remaining = fields
        .keys()
        .filter(|key| key.as_str() != FIELD_ORDER_KEY && !names.contains(key))
        .cloned()
        .collect::<Vec<_>>();
    names.extend(remaining);
    names
        .into_iter()
        .filter(|key| !omitted.contains(&key.as_str()))
        .filter_map(|key| {
            let value = fields.get(&key)?;
            if value.is_null() {
                return None;
            }
            let value = match value {
                Value::String(value) => value.clone(),
                other => other.to_string(),
            };
            Some(format!("{key}={value}"))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn merge_fields(target: &mut Map<String, Value>, fields: Map<String, Value>) {
    let mut order = field_order(target);
    let incoming_order = field_order(&fields);
    for name in incoming_order {
        if !order.contains(&name) {
            order.push(name);
        }
    }
    for (key, value) in fields {
        if key != FIELD_ORDER_KEY {
            if !order.contains(&key) {
                order.push(key.clone());
            }
            target.insert(key, value);
        }
    }
    target.insert(FIELD_ORDER_KEY.to_owned(), json!(order));
}

fn fold(entries: &[&Value]) -> FoldedList {
    let mut folded = FoldedList::default();
    for entry in entries {
        let fields = entry_fields(entry);
        let task = fields
            .get("task")
            .and_then(scalar_string)
            .filter(|task| !task.is_empty());
        if let Some(task) = task {
            if let Some((_, existing, updated_at)) =
                folded.tasks.iter_mut().find(|(name, _, _)| name == &task)
            {
                merge_fields(existing, fields);
                *updated_at = entry_epoch(entry);
            } else {
                folded.tasks.push((task, fields, entry_epoch(entry)));
            }
        } else {
            merge_fields(&mut folded.state, fields);
            folded.state_updated_at_epoch = Some(entry_epoch(entry));
        }
    }
    folded
}

fn render_list(
    list_name: &str,
    folded: &FoldedList,
    now_epoch: i64,
    include_closed: bool,
) -> Vec<String> {
    let task_lines = folded
        .tasks
        .iter()
        .filter(|(_, fields, _)| include_closed || !is_closed(fields))
        .map(|(task, fields, updated_at)| {
            let status = fields
                .get("status")
                .filter(|value| !value.is_null())
                .map(|value| format!("[{}] ", value.as_str().unwrap_or(&value.to_string())))
                .unwrap_or_default();
            let details = format_fields(fields, &["task", "status"]);
            let details = if details.is_empty() {
                String::new()
            } else {
                format!(" ({details})")
            };
            format!(
                "  - {status}{task}{details}, {}",
                updated_ago(*updated_at, now_epoch)
            )
        })
        .collect::<Vec<_>>();

    let state_fields = format_fields(&folded.state, &["task"]);
    let show_state = !state_fields.is_empty() && (include_closed || !is_closed(&folded.state));
    if !show_state && task_lines.is_empty() {
        return Vec::new();
    }
    let state_updated_at = folded.state_updated_at_epoch.unwrap_or(now_epoch);
    let header = if show_state {
        format!(
            "- {list_name}: {state_fields}, {}",
            updated_ago(state_updated_at, now_epoch)
        )
    } else {
        format!("- {list_name}")
    };
    std::iter::once(header).chain(task_lines).collect()
}

pub fn render_read_text(
    entries: &[Value],
    now_epoch: i64,
    options: &RenderOptions,
) -> Option<String> {
    if options.include_stale || options.include_closed {
        let lines = render_lines(entries, now_epoch, options.include_closed);
        return (!lines.is_empty()).then(|| lines.join("\n"));
    }

    let mut grouped: Vec<(String, Vec<&Value>)> = Vec::new();
    for entry in entries {
        if is_shared_list(entry_list(entry)) {
            continue;
        }
        let key = format!(
            "{}\0{}",
            entry_project(entry).to_ascii_lowercase(),
            entry_list(entry)
        );
        if let Some((_, values)) = grouped.iter_mut().find(|(name, _)| name == &key) {
            values.push(entry);
        } else {
            grouped.push((key, vec![entry]));
        }
    }

    let mut current_keys = HashSet::new();
    let mut stale = Vec::new();
    for (key, list_entries) in &grouped {
        let latest = list_entries
            .iter()
            .map(|entry| entry_epoch(entry))
            .max()
            .unwrap_or_default();
        if now_epoch - latest <= STALE_AFTER_MS {
            current_keys.insert(key.clone());
            continue;
        }
        let folded = fold(list_entries);
        let name = entry_list(list_entries[0]);
        let lines = render_list(name, &folded, now_epoch, false);
        if !lines.is_empty() {
            let open = (lines.len() - 1).max(1);
            stale.push(format!(
                "{name} ({open} open, {})",
                updated_ago(latest, now_epoch)
            ));
        }
    }

    let current = entries
        .iter()
        .filter(|entry| {
            let key = format!(
                "{}\0{}",
                entry_project(entry).to_ascii_lowercase(),
                entry_list(entry)
            );
            current_keys.contains(&key)
        })
        .collect::<Vec<_>>();
    let lines = render_lines_from_refs(&current, now_epoch, false);
    if lines.is_empty() && stale.is_empty() {
        return None;
    }
    let mut parts = if lines.is_empty() {
        vec!["Nothing updated in the last 14 days is open.".to_owned()]
    } else {
        vec![lines.join("\n")]
    };
    if !stale.is_empty() {
        parts.push(format!(
            "{} list{} not updated for 14+ days {} folded: {}. Read one with list=\"<name>\", show all with includeStale=true, or close finished items with work_state_write.",
            stale.len(),
            if stale.len() == 1 { "" } else { "s" },
            if stale.len() == 1 { "is" } else { "are" },
            stale.join(", ")
        ));
    }
    Some(parts.join("\n\n"))
}

fn render_lines(entries: &[Value], now_epoch: i64, include_closed: bool) -> Vec<String> {
    let references = entries.iter().collect::<Vec<_>>();
    render_lines_from_refs(&references, now_epoch, include_closed)
}

fn render_lines_from_refs(entries: &[&Value], now_epoch: i64, include_closed: bool) -> Vec<String> {
    let mut groups: Vec<(String, Vec<&Value>, usize)> = Vec::new();
    let mut project_counts = HashMap::<String, usize>::new();
    for (position, entry) in entries.iter().copied().enumerate() {
        if is_shared_list(entry_list(entry)) {
            continue;
        }
        let project = entry_project(entry).to_ascii_lowercase();
        let list = entry_list(entry);
        let key = format!("{project}\0{list}");
        if let Some((_, values, last_position)) =
            groups.iter_mut().find(|(name, _, _)| name == &key)
        {
            values.push(entry);
            *last_position = position;
        } else {
            project_counts
                .entry(list.to_owned())
                .and_modify(|count| *count += 1)
                .or_insert(1);
            groups.push((key, vec![entry], position));
        }
    }
    groups.sort_by(|(_, left, left_position), (_, right, right_position)| {
        let left_epoch = left
            .last()
            .map(|entry| entry_epoch(entry))
            .unwrap_or_default();
        let right_epoch = right
            .last()
            .map(|entry| entry_epoch(entry))
            .unwrap_or_default();
        right_epoch
            .cmp(&left_epoch)
            .then_with(|| right_position.cmp(left_position))
    });
    groups
        .into_iter()
        .flat_map(|(_, entries, _)| {
            let first = entries[0];
            let project = entry_project(first);
            let list = entry_list(first);
            let label = if project_counts.get(list).copied().unwrap_or_default() > 1 {
                format!("{list} [{project}]")
            } else {
                list.to_owned()
            };
            render_list(&label, &fold(&entries), now_epoch, include_closed)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_latest_open_state_and_tasks() {
        let entries = vec![
            json!({
                "id": 1,
                "project": "kioku",
                "list_name": "release",
                "fields": {"version": "1.0.0", "task": "ship", "status": "doing"},
                "created_at_epoch": 900
            }),
            json!({
                "id": 2,
                "project": "kioku",
                "list_name": "release",
                "fields": {"task": "ship", "status": "done", "detail": "published"},
                "created_at_epoch": 950
            }),
            json!({
                "id": 3,
                "project": "kioku",
                "list_name": "release",
                "fields": {"version": "1.1.0"},
                "created_at_epoch": 1_000
            }),
        ];

        let output = render_read_text(
            &entries,
            1_000,
            &RenderOptions {
                include_closed: false,
                include_stale: true,
            },
        )
        .expect("rendered work state");

        assert_eq!(output, "- release: version=1.1.0, updated 1 minute ago");
    }

    #[test]
    fn treats_closed_status_case_insensitively_and_accepts_primitive_tasks() {
        let entries = vec![json!({
            "project":"kioku",
            "list_name":"release",
            "fields":{"task":42,"status":"DROPPED"},
            "created_at_epoch":1
        })];
        assert_eq!(
            render_read_text(
                &entries,
                2,
                &RenderOptions {
                    include_closed: false,
                    include_stale: true,
                }
            ),
            None
        );
        assert_eq!(
            render_read_text(
                &entries,
                2,
                &RenderOptions {
                    include_closed: true,
                    include_stale: true,
                }
            )
            .expect("closed task"),
            "- release\n  - [DROPPED] 42, updated 1 minute ago"
        );
    }

    #[test]
    fn preserves_original_order_when_equal_epoch_lists_are_rendered() {
        let entries = vec![
            json!({"project":"kioku","list_name":"alpha","fields":{"task":"a"},"created_at_epoch":5}),
            json!({"project":"kioku","list_name":"beta","fields":{"task":"b"},"created_at_epoch":10}),
            json!({"project":"kioku","list_name":"alpha","fields":{"task":"a","detail":"latest"},"created_at_epoch":10}),
        ];
        let output = render_read_text(
            &entries,
            11,
            &RenderOptions {
                include_closed: false,
                include_stale: false,
            },
        )
        .expect("ordered lists");
        assert!(output.find("- alpha").expect("alpha") < output.find("- beta").expect("beta"));
    }

    #[test]
    fn reads_resolved_project_history_from_sqlite() {
        let directory = tempfile::tempdir().expect("temporary database directory");
        let database = directory.path().join("claude-mem.db");
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
                INSERT INTO work_state_entries
                    (project, list_name, fields, created_at, created_at_epoch)
                VALUES
                    ('legacy-kioku', 'release', '{"task":"ship","status":"doing"}', '2026-11-20', 1000),
                    ('kioku', 'release', '{"task":"ship","status":"done"}', '2026-11-20', 2000),
                    ('unrelated', 'release', '{"task":"private","status":"doing"}', '2026-11-20', 3000);
                "#,
            )
            .expect("create work state fixture");
        drop(connection);

        let output = read(
            &database,
            &json!({"list":"release","includeClosed":false}),
            &json!({
                "primary":"kioku",
                "projects":["legacy-kioku","kioku"],
                "readProjects":["legacy-kioku","kioku"],
                "localDeviceId":""
            }),
        )
        .expect("read work state");
        assert_eq!(
            output,
            "Nothing open in \"release\" for kioku. Pass includeClosed to see closed items."
        );

        let closed = read(
            &database,
            &json!({"list":"release","includeClosed":true}),
            &json!({
                "primary":"kioku",
                "projects":["legacy-kioku","kioku"],
                "readProjects":["legacy-kioku","kioku"],
                "localDeviceId":""
            }),
        )
        .expect("read closed work state");
        assert!(closed.starts_with("- release\n  - [done] ship,"));
        assert!(!closed.contains("private"));
    }

    #[test]
    fn rejects_malformed_worker_context() {
        let directory = tempfile::tempdir().expect("temporary database directory");
        let database = directory.path().join("claude-mem.db");
        Connection::open(&database).expect("create database");
        let error = read(&database, &json!({}), &json!({"primary":"kioku"}))
            .expect_err("invalid worker context");
        assert!(format!("{error:#}").contains("missing projects"));
    }

    #[test]
    fn folds_stale_lists_into_one_line_by_default() {
        let now = 20 * 24 * 60 * 60 * 1_000;
        let entries = vec![json!({
            "id": 1,
            "project": "kioku",
            "list_name": "release",
            "fields": {"task": "ship", "status": "doing"},
            "created_at_epoch": 1
        })];

        let output = render_read_text(
            &entries,
            now,
            &RenderOptions {
                include_closed: false,
                include_stale: false,
            },
        )
        .expect("stale work state");

        assert_eq!(
            output,
            "Nothing updated in the last 14 days is open.\n\n1 list not updated for 14+ days is folded: release (1 open, updated about 20 days ago). Read one with list=\"<name>\", show all with includeStale=true, or close finished items with work_state_write."
        );
    }
}
