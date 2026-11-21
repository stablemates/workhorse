//! Writes the demo's NDJSON log records, in the format of `typescript/demo/file-log-exporter.cjs`.
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Level, Metadata, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

const DEFAULT_MAX_BYTES: u64 = 10 * 1024 * 1024;
const DEFAULT_ARCHIVES: u32 = 5;

/// Appends records to one file. It rotates the file before a record would take it past
/// `max_bytes`, and keeps `archives` numbered archives. A write that fails reports once to
/// standard error and never reaches the worker.
pub struct DemoLogFile {
    path: PathBuf,
    max_bytes: u64,
    archives: u32,
    resource: Value,
    failed: Mutex<bool>,
}

fn safe_path_segment(value: &str) -> String {
    let safe: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "._-".contains(character) {
                character
            } else {
                '_'
            }
        })
        .take(100)
        .collect();
    if safe.is_empty() {
        "unknown".into()
    } else {
        safe
    }
}

fn positive_integer(name: &str, value: Option<String>, fallback: u64) -> Result<u64, String> {
    match value {
        None => Ok(fallback),
        Some(value) => match value.parse::<u64>() {
            Ok(parsed) if parsed >= 1 => Ok(parsed),
            _ => Err(format!("{name} must be a positive integer")),
        },
    }
}

/// Formats a time as UTC with milliseconds, such as `2026-11-21T15:12:55.802Z`.
fn utc_milliseconds(moment: SystemTime) -> String {
    let elapsed = moment.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = elapsed.as_secs() as i64;
    let (days, of_day) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // The civil-from-days algorithm of Howard Hinnant, for the proleptic Gregorian calendar.
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600,
        of_day % 3_600 / 60,
        of_day % 60,
        elapsed.subsec_millis()
    )
}

fn host_name() -> String {
    fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "localhost".into())
}

impl DemoLogFile {
    /// The log file of this worker, or `None` when the launcher names no log directory or no
    /// service name.
    pub fn from_env() -> Result<Option<Self>, String> {
        let directory = std::env::var("WORKHORSE_DEMO_LOG_DIRECTORY").unwrap_or_default();
        let service = std::env::var("WORKHORSE_DEMO_SERVICE_NAME").unwrap_or_default();
        if directory.is_empty() || service.is_empty() {
            return Ok(None);
        }
        let environment = std::env::var("WORKHORSE_DEMO_ENV")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "development".into());
        let max_bytes = positive_integer(
            "WORKHORSE_DEMO_LOG_MAX_BYTES",
            std::env::var("WORKHORSE_DEMO_LOG_MAX_BYTES").ok(),
            DEFAULT_MAX_BYTES,
        )?;
        let archives = positive_integer(
            "WORKHORSE_DEMO_LOG_ARCHIVES",
            std::env::var("WORKHORSE_DEMO_LOG_ARCHIVES").ok(),
            u64::from(DEFAULT_ARCHIVES),
        )?;
        let root = std::path::absolute(&directory).map_err(|error| error.to_string())?;
        let path = root
            .join(safe_path_segment(&environment))
            .join(format!("{}.ndjson", safe_path_segment(&service)));
        let resource = serde_json::json!({
            "service.name": service,
            "deployment.environment.name": environment,
            "deployment.environment": environment,
            "host.name": host_name(),
            "process.pid": std::process::id(),
            "telemetry.sdk.language": "rust",
        });
        Ok(Some(Self::new(path, max_bytes, u32::try_from(archives).unwrap_or(u32::MAX), resource)))
    }

    pub fn new(path: PathBuf, max_bytes: u64, archives: u32, resource: Value) -> Self {
        Self { path, max_bytes, archives, resource, failed: Mutex::new(false) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Writes one record. `fields` holds the record fields before `resource`, in their order.
    fn write(&self, fields: &[(&str, Value)], scope: &str) {
        // `serde_json::Map` sorts its keys, so the line is assembled in the order of the TypeScript
        // exporter. The `preserve_order` feature would also change the SDK's own JSON.
        let mut line = String::from("{");
        for (key, value) in fields {
            line.push_str(&format!("{}:{value},", Value::from(*key)));
        }
        line.push_str(&format!(
            "\"resource\":{},\"scope\":{}}}\n",
            self.resource,
            serde_json::json!({ "name": scope })
        ));
        let mut failed = self.failed.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Err(error) = self.append(line.as_bytes()) {
            if !*failed {
                *failed = true;
                eprintln!("Could not write the demo log file {}: {error}", self.path.display());
            }
        }
    }

    fn append(&self, line: &[u8]) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let size = match fs::metadata(&self.path) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == ErrorKind::NotFound => 0,
            Err(error) => return Err(error),
        };
        if size > 0 && size + line.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        OpenOptions::new().create(true).append(true).open(&self.path)?.write_all(line)
    }

    fn rotate(&self) -> std::io::Result<()> {
        let archive = |index: u32| PathBuf::from(format!("{}.{index}", self.path.display()));
        match fs::remove_file(archive(self.archives)) {
            Err(error) if error.kind() != ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        for index in (1..self.archives).rev() {
            match fs::rename(archive(index), archive(index + 1)) {
                Err(error) if error.kind() != ErrorKind::NotFound => return Err(error),
                _ => {}
            }
        }
        fs::rename(&self.path, archive(1))
    }
}

#[derive(Default)]
struct Fields(Map<String, Value>);

impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.insert(field.name().into(), Value::String(format!("{value:?}")));
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().into(), Value::String(value.into()));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.0.insert(field.name().into(), Value::String(value.to_string()));
    }
}

/// Writes each `tracing` event to a [`DemoLogFile`], with the fields of its spans. It records
/// debug events of the Workhorse crates and info events of every crate.
pub struct DemoLogLayer {
    file: DemoLogFile,
}

impl DemoLogLayer {
    pub fn new(file: DemoLogFile) -> Self {
        Self { file }
    }

    /// Whether the file records an event or span with this metadata.
    pub fn records(metadata: &Metadata<'_>) -> bool {
        *metadata.level() <= Level::INFO
            || (*metadata.level() <= Level::DEBUG && metadata.target().starts_with("workhorse"))
    }
}

fn severity(level: &Level) -> (&'static str, u64) {
    match *level {
        Level::TRACE | Level::DEBUG => ("DEBUG", 5),
        Level::INFO => ("INFO", 9),
        Level::WARN => ("WARN", 13),
        Level::ERROR => ("ERROR", 17),
    }
}

impl<S> Layer<S> for DemoLogLayer
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    fn on_new_span(&self, attributes: &Attributes<'_>, id: &Id, context: Context<'_, S>) {
        let mut fields = Fields::default();
        attributes.record(&mut fields);
        if let Some(span) = context.span(id) {
            span.extensions_mut().insert(fields);
        }
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, context: Context<'_, S>) {
        if let Some(span) = context.span(id) {
            if let Some(fields) = span.extensions_mut().get_mut::<Fields>() {
                values.record(fields);
            }
        }
    }

    fn on_event(&self, event: &Event<'_>, context: Context<'_, S>) {
        let metadata = event.metadata();
        if !Self::records(metadata) {
            return;
        }
        let mut attributes = Map::new();
        if let Some(scope) = context.event_scope(event) {
            for span in scope.from_root() {
                if let Some(fields) = span.extensions().get::<Fields>() {
                    for (key, value) in &fields.0 {
                        if !key.starts_with("otel.") {
                            attributes.insert(key.clone(), value.clone());
                        }
                    }
                }
            }
        }
        let mut fields = Fields::default();
        event.record(&mut fields);
        attributes.extend(fields.0);
        let body = match attributes.remove("message") {
            Some(Value::String(message)) => message,
            Some(other) => other.to_string(),
            None => String::new(),
        };
        let event_name = attributes.remove("event.name");
        let now = utc_milliseconds(SystemTime::now());
        let (text, number) = severity(metadata.level());
        let mut fields = vec![
            ("timestamp", Value::String(now.clone())),
            ("observedTimestamp", Value::String(now)),
            ("severityText", text.into()),
            ("severityNumber", number.into()),
        ];
        if let Some(event_name) = event_name {
            fields.push(("eventName", event_name));
        }
        fields.push(("body", Value::String(body)));
        fields.push(("attributes", Value::Object(attributes)));
        self.file.write(&fields, metadata.target());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt;

    fn scratch_directory() -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("workhorse-demo-log-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn formats_utc_milliseconds() {
        let moment = UNIX_EPOCH + std::time::Duration::from_millis(1_795_273_975_802);
        assert_eq!(utc_milliseconds(moment), "2026-11-21T15:12:55.802Z");
        assert_eq!(utc_milliseconds(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn refuses_an_invalid_size() {
        assert!(positive_integer("WORKHORSE_DEMO_LOG_MAX_BYTES", Some("0".into()), 1).is_err());
        assert_eq!(positive_integer("X", None, 7), Ok(7));
    }

    #[test]
    fn writes_the_typescript_record_shape_with_span_fields() {
        let directory = scratch_directory();
        let path = directory.join("w.ndjson");
        let file =
            DemoLogFile::new(path.clone(), 10_000, 1, serde_json::json!({ "service.name": "w" }));
        let subscriber = tracing_subscriber::registry().with(DemoLogLayer::new(file));
        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!(
                "workhorse.handler",
                otel.kind = "consumer",
                workhorse.queue.name = "demo-rust"
            );
            let _entered = span.enter();
            tracing::info!(
                event.name = "workhorse.task.completed",
                workhorse.task.attempt = 1,
                "Task completed"
            );
            tracing::debug!("kept");
            tracing::debug!(target: "tokio_postgres::query", "dropped");
        });
        let contents = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2, "{contents}");
        let keys = [
            "\"timestamp\"",
            "\"observedTimestamp\"",
            "\"severityText\"",
            "\"severityNumber\"",
            "\"eventName\"",
            "\"body\"",
            "\"attributes\"",
            "\"resource\"",
            "\"scope\"",
        ];
        let positions: Vec<usize> = keys.iter().map(|key| lines[0].find(key).unwrap()).collect();
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]), "{}", lines[0]);
        let record: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(record["eventName"], "workhorse.task.completed");
        assert_eq!(record["body"], "Task completed");
        assert_eq!(record["severityNumber"], 9);
        assert_eq!(
            record["attributes"],
            serde_json::json!({ "workhorse.queue.name": "demo-rust", "workhorse.task.attempt": 1 })
        );
        assert_eq!(record["resource"]["service.name"], "w");
        assert_eq!(record["scope"]["name"], module_path!());
        assert!(record["timestamp"].as_str().unwrap().ends_with('Z'));
        let debug: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(debug["severityText"], "DEBUG");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rotates_before_the_limit() {
        let directory = scratch_directory();
        let file = DemoLogFile::new(directory.join("w.ndjson"), 400, 2, Value::Null);
        let subscriber = tracing_subscriber::registry().with(DemoLogLayer::new(file));
        tracing::subscriber::with_default(subscriber, || {
            for index in 0..12 {
                tracing::info!(index, "record");
            }
        });
        let mut names: Vec<String> = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                assert!(entry.metadata().unwrap().len() <= 400);
                entry.file_name().into_string().unwrap()
            })
            .collect();
        names.sort();
        assert_eq!(names, ["w.ndjson", "w.ndjson.1", "w.ndjson.2"]);
        let current = fs::read_to_string(directory.join("w.ndjson")).unwrap();
        assert!(current.contains("\"index\":11"), "{current}");
        fs::remove_dir_all(directory).unwrap();
    }
}
