//! Execute every `protocol/v1` fixture through the Rust lane.
//!
//! The Go and Python lanes execute the same fixtures. A fixture here either passes through a Rust
//! adapter or appears in `conformance/expected-unsupported.json` with the Issue that owns the gap.
//! The run fails on a fixture that does neither, and on a listed fixture that now passes.
//!
//! Fixtures that need PostgreSQL run in scratch databases created beside `DATABASE_URL_TEST`.
//! Without that variable a local run skips them and says so on standard error. CI, or
//! `WORKHORSE_REQUIRE_DATABASE=1`, fails instead.

mod conformance;
mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use support::ScratchDatabase;
use tokio_postgres::Client;
use workhorse::{EnqueueRequest, Error as ClientError, Queue, ScheduleDefinition};

use conformance::database;
use conformance::ledger::{reconcile, Ledger, Outcome};
use conformance::matcher::{
    assert_value, normalize_timestamp, read_pointer, resolve, same, single_key, References,
};

/// Files in `protocol/v1` that describe fixtures rather than declare them.
const METADATA: &[&str] = &["manifest.json", "cron.md", "governed-surface.json"];
/// Fixture files, keyed by the category name the list uses.
const CATEGORIES: &[&str] = &[
    "compatibility",
    "contracts",
    "cron-occurrences",
    "failures",
    "interpreter",
    "requests",
    "runtime",
    "scenarios",
    "schedules",
];

fn protocol_directory() -> PathBuf {
    database::repository().join("protocol/v1")
}

fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn ledger() -> Ledger {
    let path = database::repository().join("rust/tests/conformance/expected-unsupported.json");
    serde_json::from_value(read_json(&path))
        .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

/// Every fixture each category file declares, in file order.
struct Catalogue {
    fixtures: BTreeMap<&'static str, Vec<Value>>,
    manifest: Value,
}

impl Catalogue {
    fn load(directory: &Path) -> Result<Self, String> {
        let mut unknown = Vec::new();
        let entries = std::fs::read_dir(directory)
            .map_err(|error| format!("read {}: {error}", directory.display()))?;
        for entry in entries {
            let name = entry
                .map_err(|error| error.to_string())?
                .file_name()
                .to_string_lossy()
                .into_owned();
            let known = METADATA.contains(&name.as_str())
                || name.strip_suffix(".json").is_some_and(|stem| CATEGORIES.contains(&stem));
            if !known {
                unknown.push(name);
            }
        }
        if !unknown.is_empty() {
            unknown.sort();
            return Err(format!(
                "protocol/v1 holds files the Rust runner does not classify: {}; execute them or name them as metadata",
                unknown.join(", ")
            ));
        }
        let mut fixtures = BTreeMap::new();
        for category in CATEGORIES {
            let document = read_json(&directory.join(format!("{category}.json")));
            // `failures.json` wraps its fixtures beside the envelope they share.
            let list =
                if *category == "failures" { document["fixtures"].clone() } else { document };
            let Value::Array(list) = list else {
                return Err(format!("{category}.json declares no fixture array"));
            };
            fixtures.insert(*category, list);
        }
        Ok(Self { fixtures, manifest: read_json(&directory.join("manifest.json")) })
    }

    fn declared(&self) -> BTreeSet<String> {
        self.fixtures
            .iter()
            .flat_map(|(category, list)| list.iter().map(move |fixture| key(category, fixture)))
            .collect()
    }

    fn category(&self, name: &str) -> &[Value] {
        &self.fixtures[name]
    }
}

fn key(category: &str, fixture: &Value) -> String {
    format!("{category}/{}", fixture["id"].as_str().expect("every fixture has a string id"))
}

fn record(
    outcomes: &mut BTreeMap<String, Outcome>,
    category: &str,
    fixture: &Value,
    outcome: Outcome,
) {
    outcomes.insert(key(category, fixture), outcome);
}

fn outcome(result: Result<(), String>) -> Outcome {
    match result {
        Ok(()) => Outcome::Passed,
        Err(reason) => Outcome::Failed(reason),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_protocol_fixture_passes_or_is_listed() {
    let catalogue =
        Catalogue::load(&protocol_directory()).unwrap_or_else(|error| panic!("{error}"));
    let ledger = ledger();
    let mut outcomes = BTreeMap::new();

    for fixture in catalogue.category("interpreter") {
        record(&mut outcomes, "interpreter", fixture, outcome(run_interpreter(fixture)));
    }
    for fixture in catalogue.category("contracts") {
        let reason = "the Rust client does not validate instances against a contract schema";
        record(&mut outcomes, "contracts", fixture, Outcome::Unsupported(reason.to_owned()));
    }
    for fixture in catalogue.category("failures") {
        let reason = "the Rust worker does not record a handler failure envelope";
        record(&mut outcomes, "failures", fixture, Outcome::Unsupported(reason.to_owned()));
    }
    for fixture in catalogue.category("runtime") {
        let reason = format!(
            "no Rust worker runtime executes {} fixtures",
            fixture["kind"].as_str().unwrap_or("runtime")
        );
        record(&mut outcomes, "runtime", fixture, Outcome::Unsupported(reason));
    }

    let mut problems = Vec::new();
    match support::scratch_database("protocol_conformance_scenarios").await {
        Some(scenarios) => {
            let coverage = run_scenarios(&scenarios, &catalogue, &ledger, &mut outcomes).await;
            problems.extend(coverage);
            drop(scenarios);

            let adapters = support::scratch_database("protocol_conformance_adapters")
                .await
                .expect("DATABASE_URL_TEST was set for the scenarios");
            run_cron(&adapters, &catalogue, &mut outcomes).await;
            run_requests(&adapters, &catalogue, &mut outcomes).await;
            run_schedules(&adapters, &catalogue, &mut outcomes).await;
            // Compatibility rewrites the version tables, so it runs after every other adapter.
            run_compatibility(&adapters, &catalogue, &mut outcomes).await;
        }
        None => {
            for category in
                ["scenarios", "cron-occurrences", "requests", "schedules", "compatibility"]
            {
                for fixture in catalogue.category(category) {
                    record(
                        &mut outcomes,
                        category,
                        fixture,
                        Outcome::Skipped("DATABASE_URL_TEST is unset".to_owned()),
                    );
                }
            }
        }
    }

    report(&outcomes);
    problems.extend(reconcile(&catalogue.declared(), &outcomes, &ledger));
    assert!(
        problems.is_empty(),
        "Rust protocol conformance disagrees with its list:\n  {}",
        problems.join("\n  ")
    );
}

fn report(outcomes: &BTreeMap<String, Outcome>) {
    let mut counts = BTreeMap::new();
    for outcome in outcomes.values() {
        let label = match outcome {
            Outcome::Passed => "passed",
            Outcome::Failed(_) => "failed",
            Outcome::Unsupported(_) => "unsupported",
            Outcome::Skipped(_) => "skipped",
        };
        *counts.entry(label).or_insert(0) += 1;
    }
    eprintln!("Rust protocol conformance: {counts:?}");
    for (fixture, outcome) in outcomes {
        match outcome {
            Outcome::Passed => {}
            Outcome::Failed(reason) => eprintln!("  failed      {fixture}: {reason}"),
            Outcome::Unsupported(reason) => eprintln!("  unsupported {fixture}: {reason}"),
            Outcome::Skipped(reason) => eprintln!("  skipped     {fixture}: {reason}"),
        }
    }
}

// ----- interpreter ---------------------------------------------------------------------------

fn run_interpreter(fixture: &Value) -> Result<(), String> {
    let id = fixture["id"].as_str().unwrap_or_default();
    let mut references = References::new();
    for step in fixture["steps"].as_array().ok_or("interpreter fixture has no steps")? {
        let location = format!("{id}/{}", step["id"].as_str().unwrap_or_default());
        let actual = materialize(&step["actual"])?;
        let result = assert_value(&step["expect"], &actual, &references, &location);
        if step["rejects"].as_bool().unwrap_or(false) {
            if result.is_ok() {
                return Err(format!("{location} accepted a value the fixture rejects"));
            }
        } else {
            result?;
        }
        capture(step, &actual, &mut references)?;
    }
    for error in fixture["errors"].as_array().ok_or("interpreter fixture has no errors")? {
        let location = format!("{id}/{}", error["id"].as_str().unwrap_or_default());
        assert_error_value(&error["expect"], &error["actual"], &references, &location)?;
    }
    Ok(())
}

/// Turn `{"$native": kind, "value": text}` into the value a driver would produce, then normalize it
/// the way the scenario decoder does.
fn materialize(value: &Value) -> Result<Value, String> {
    match value {
        Value::Array(items) => {
            items.iter().map(materialize).collect::<Result<_, _>>().map(Value::Array)
        }
        Value::Object(fields)
            if fields.len() == 2
                && fields.contains_key("$native")
                && fields.contains_key("value") =>
        {
            let raw = &fields["value"];
            let text = || raw.as_str().ok_or_else(|| format!("native value {raw} is not text"));
            match fields["$native"].as_str() {
                // PostgreSQL numeric: integral values become integers, as the decoder does.
                Some("integer") => {
                    let text = text()?;
                    match text.parse::<i64>() {
                        Ok(integer) => Ok(json!(integer)),
                        Err(_) => text
                            .parse::<f64>()
                            .map(|float| json!(float))
                            .map_err(|error| error.to_string()),
                    }
                }
                // serde_json renders a non-finite float as null, so the number matcher rejects it.
                Some("number") => text()?
                    .parse::<f64>()
                    .map(|float| serde_json::to_value(float).unwrap_or(Value::Null))
                    .map_err(|error| error.to_string()),
                Some("timestamp") => DateTime::parse_from_rfc3339(text()?)
                    .map(|instant| normalize_timestamp(instant.with_timezone(&Utc)))
                    .map_err(|error| error.to_string()),
                Some("uuid") => uuid::Uuid::parse_str(text()?)
                    .map(|uuid| Value::String(uuid.to_string()))
                    .map_err(|error| error.to_string()),
                Some("json") => Ok(raw.clone()),
                other => Err(format!("unknown interpreter native value {other:?}")),
            }
        }
        Value::Object(fields) => fields
            .iter()
            .map(|(key, item)| Ok((key.clone(), materialize(item)?)))
            .collect::<Result<_, String>>()
            .map(Value::Object),
        _ => Ok(value.clone()),
    }
}

fn capture(step: &Value, actual: &Value, references: &mut References) -> Result<(), String> {
    if let Some(captures) = step["capture"].as_object() {
        for (name, pointer) in captures {
            let pointer =
                pointer.as_str().ok_or_else(|| format!("capture {name} has no pointer"))?;
            references.insert(name.clone(), read_pointer(actual, pointer)?);
        }
    }
    Ok(())
}

fn assert_error_value(
    expected: &Value,
    actual: &Value,
    references: &References,
    location: &str,
) -> Result<(), String> {
    for field in ["code", "message"] {
        if actual.get(field) != expected.get(field) {
            return Err(format!(
                "{location} expected error {field} {}, received {}",
                expected.get(field).unwrap_or(&Value::Null),
                actual.get(field).unwrap_or(&Value::Null)
            ));
        }
    }
    if let Some(detail) = expected.get("detail") {
        let actual = actual
            .get("detail")
            .ok_or_else(|| format!("{location} expected error detail, received none"))?;
        assert_value(detail, actual, references, &format!("{location}.detail"))?;
    }
    Ok(())
}

// ----- scenarios -----------------------------------------------------------------------------

/// Run every SQL scenario and return coverage problems. A scenario that fails stops at its first
/// failing step; the next scenario still runs.
async fn run_scenarios(
    database: &ScratchDatabase,
    catalogue: &Catalogue,
    ledger: &Ledger,
    outcomes: &mut BTreeMap<String, Outcome>,
) -> Vec<String> {
    let client = database.connect().await;
    let listed: BTreeSet<&str> =
        ledger.fixtures.iter().map(|entry| entry.fixture.as_str()).collect();
    let mut coverage = BTreeSet::new();
    for scenario in catalogue.category("scenarios") {
        let result = run_scenario(&client, scenario).await;
        // A listed scenario keeps the capabilities it declares, so its gap is reported once, by the list.
        if result.is_ok() || listed.contains(key("scenarios", scenario).as_str()) {
            coverage.extend(covers(scenario));
        }
        record(outcomes, "scenarios", scenario, outcome(result));
    }
    manifest_coverage(&catalogue.manifest, &coverage).err().into_iter().collect()
}

fn covers(scenario: &Value) -> impl Iterator<Item = String> + '_ {
    scenario["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|step| step["covers"].as_array().into_iter().flatten())
        .filter_map(|capability| capability.as_str().map(str::to_owned))
}

fn manifest_coverage(manifest: &Value, coverage: &BTreeSet<String>) -> Result<(), String> {
    let runtime: BTreeSet<&str> = manifest["runtimeCoverage"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let missing: Vec<&str> = manifest["coverage"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|capability| !runtime.contains(capability) && !coverage.contains(*capability))
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("SQL protocol fixtures lack coverage: {}", missing.join(", ")))
    }
}

async fn run_scenario(client: &Client, scenario: &Value) -> Result<(), String> {
    let id = scenario["id"].as_str().unwrap_or_default();
    let mut references = References::new();
    for step in scenario["steps"].as_array().ok_or("scenario has no steps")? {
        let location = format!("{id}/{}", step["id"].as_str().unwrap_or_default());
        run_step(client, step, &mut references, &location).await?;
    }
    Ok(())
}

async fn run_step(
    client: &Client,
    step: &Value,
    references: &mut References,
    location: &str,
) -> Result<(), String> {
    let sql = step["sql"].as_str().ok_or_else(|| format!("{location} has no SQL"))?;
    let values = match step.get("parameters") {
        Some(parameters) => match resolve(parameters, references)? {
            Value::Array(values) => values,
            other => return Err(format!("{location} parameters are not a list: {other}")),
        },
        None => Vec::new(),
    };
    let result = match client.prepare(sql).await {
        Ok(statement) => {
            let bound = database::parameters(&statement, &values)
                .map_err(|error| format!("{location}: {error}"))?;
            client.query(&statement, &database::borrow(&bound)).await
        }
        Err(error) => Err(error),
    };
    match (result, step.get("error")) {
        (Err(error), Some(expected)) => {
            let actual = database::database_error(&error)
                .map_err(|problem| format!("{location}: {problem}"))?;
            assert_error_value(expected, &actual, references, location)
        }
        (Ok(rows), Some(expected)) => {
            Err(format!("{location} expected error {expected}, received {} rows", rows.len()))
        }
        (Err(error), None) => Err(format!("{location} failed: {}", database::describe(&error))),
        (Ok(rows), None) => {
            let actual = database::rows(&rows).map_err(|error| format!("{location}: {error}"))?;
            let expected = step.pointer("/expect/rows").cloned().unwrap_or_else(|| json!([]));
            assert_value(&expected, &actual, references, location)?;
            capture(step, &actual, references)
        }
    }
}

// ----- cron occurrences ----------------------------------------------------------------------

async fn run_cron(
    database: &ScratchDatabase,
    catalogue: &Catalogue,
    outcomes: &mut BTreeMap<String, Outcome>,
) {
    let client = database.connect().await;
    for fixture in catalogue.category("cron-occurrences") {
        let result = async {
            // A new definition has no previous occurrence, which the fixture writes as null.
            let parse = |field: &str| -> Result<Option<DateTime<Utc>>, String> {
                fixture[field]
                    .as_str()
                    .map(|text| {
                        DateTime::parse_from_rfc3339(text)
                            .map(|instant| instant.with_timezone(&Utc))
                            .map_err(|error| format!("{field}: {error}"))
                    })
                    .transpose()
            };
            let limit = i32::try_from(fixture["limit"].as_i64().ok_or("limit is not an integer")?)
                .map_err(|error| error.to_string())?;
            let rows = client
                .query(
                    "SELECT occurrence_at FROM workhorse.cron_occurrences_v1($1::text, $2::timestamptz, $3::timestamptz, $4::integer, $5::text) occurrence_at",
                    &[&fixture["expression"].as_str(), &parse("lastOccurrenceAt")?, &parse("now")?, &limit, &fixture["timezone"].as_str()],
                )
                .await
                .map_err(|error| database::describe(&error))?;
            let actual = rows
                .iter()
                .map(|row| row.try_get::<_, DateTime<Utc>>(0).map(|instant| instant.timestamp_micros()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            let expected = fixture["expected"]
                .as_array()
                .ok_or("expected is not a list")?
                .iter()
                .map(|instant| {
                    DateTime::parse_from_rfc3339(instant.as_str().unwrap_or_default())
                        .map(|instant| instant.timestamp_micros())
                        .map_err(|error| error.to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            if actual == expected {
                Ok(())
            } else {
                Err(format!("expected occurrences {expected:?}, received {actual:?} (microseconds since the epoch)"))
            }
        }
        .await;
        record(outcomes, "cron-occurrences", fixture, outcome(result));
    }
}

// ----- request and schedule serialization ------------------------------------------------------

/// Route calls to one SQL function through a wrapper that records its arguments first.
///
/// The Rust client owns a concrete `tokio_postgres::Client`, so the runner cannot substitute an
/// executor the way the Go lane does. It interposes in the database instead: the real function
/// keeps running, and the runner reads the recorded arguments back.
async fn record_calls(client: &Client, function: &str) -> Result<(), String> {
    let overloads = client
        .query(
            "SELECT p.oid::regprocedure::text AS signature, pg_get_function_arguments(p.oid) AS arguments, \
                    pg_get_function_result(p.oid) AS result, p.proretset AS returns_set, p.pronargs::integer AS arity \
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
              WHERE n.nspname = 'workhorse' AND p.proname = $1",
            &[&function],
        )
        .await
        .map_err(|error| database::describe(&error))?;
    if overloads.is_empty() {
        return Err(format!("workhorse.{function} does not exist"));
    }
    client
        .batch_execute("CREATE TABLE IF NOT EXISTS public.conformance_calls (sequence bigserial PRIMARY KEY, function_name text NOT NULL, arguments jsonb NOT NULL)")
        .await
        .map_err(|error| database::describe(&error))?;
    for (index, overload) in overloads.iter().enumerate() {
        let signature: String = overload.get("signature");
        let arguments: String = overload.get("arguments");
        let result: String = overload.get("result");
        let returns_set: bool = overload.get("returns_set");
        let arity: i32 = overload.get("arity");
        let inner = format!("{function}__recorded_{index}");
        let placeholders =
            (1..=arity).map(|position| format!("${position}")).collect::<Vec<_>>().join(", ");
        let call = if returns_set {
            format!("SELECT * FROM workhorse.{inner}({placeholders})")
        } else {
            format!("SELECT workhorse.{inner}({placeholders})")
        };
        client
            .batch_execute(&format!(
                "ALTER FUNCTION {signature} RENAME TO {inner};
                 CREATE FUNCTION workhorse.{function}({arguments}) RETURNS {result} LANGUAGE sql AS $recorded$
                   INSERT INTO public.conformance_calls (function_name, arguments)
                   VALUES ('{function}', jsonb_build_array({placeholders}));
                   {call};
                 $recorded$;"
            ))
            .await
            .map_err(|error| format!("interpose {signature}: {}", database::describe(&error)))?;
    }
    Ok(())
}

/// Return the arguments of every recorded call to `function` since the last read, and forget them.
async fn recorded(client: &Client, function: &str) -> Result<Vec<Value>, String> {
    let rows = client
        .query(
            "DELETE FROM public.conformance_calls WHERE function_name = $1 RETURNING sequence, arguments",
            &[&function],
        )
        .await
        .map_err(|error| database::describe(&error))?;
    let mut calls: Vec<(i64, Value)> = rows.iter().map(|row| (row.get(0), row.get(1))).collect();
    calls.sort_by_key(|(sequence, _)| *sequence);
    Ok(calls.into_iter().map(|(_, arguments)| arguments).collect())
}

fn client_error(error: ClientError) -> String {
    match error {
        ClientError::Postgres(error) => format!("postgres: {}", database::describe(&error)),
        other => other.to_string(),
    }
}

/// Options `EnqueueRequest` has no field for. A fixture that sets one cannot be expressed in Rust.
const INEXPRESSIBLE_OPTIONS: &[&str] =
    &["concurrencyKey", "budget", "retryPolicy", "idempotency", "delayMs", "executionTimeoutMs"];

/// A request fixture records the JSON request every client sends to `enqueue_many_v1`, so the Rust
/// `Queue::enqueue` passes only when it sends that call with that request.
async fn run_requests(
    database: &ScratchDatabase,
    catalogue: &Catalogue,
    outcomes: &mut BTreeMap<String, Outcome>,
) {
    let setup = database.connect().await;
    let interposed = record_calls(&setup, "enqueue_many_v1").await;
    for fixture in catalogue.category("requests") {
        let application = &fixture["application"];
        let options = application["options"].as_object().cloned().unwrap_or_default();
        let inexpressible: Vec<&str> = INEXPRESSIBLE_OPTIONS
            .iter()
            .copied()
            .filter(|option| options.contains_key(*option))
            .collect();
        if !inexpressible.is_empty() {
            let reason = format!("EnqueueRequest cannot express {}", inexpressible.join(", "));
            record(outcomes, "requests", fixture, Outcome::Unsupported(reason));
            continue;
        }
        let result = async {
            interposed.clone()?;
            let queue_name = fixture
                .pointer("/postgres/queue")
                .and_then(Value::as_str)
                .ok_or("fixture names no queue")?;
            let mut request = EnqueueRequest::new(
                options.get("queue").and_then(Value::as_str).unwrap_or(queue_name),
                application["type"].as_str().ok_or("fixture names no type")?,
                application["payload"].clone(),
            );
            if let Some(priority) = options.get("priority").and_then(Value::as_i64) {
                request.priority = i32::try_from(priority).map_err(|error| error.to_string())?;
            }
            if let Some(attempts) = options.get("maxAttempts").and_then(Value::as_i64) {
                request.max_attempts =
                    Some(i32::try_from(attempts).map_err(|error| error.to_string())?);
            }
            if let Some(tags) = options.get("tags").and_then(Value::as_array) {
                request.tags = tags.iter().filter_map(Value::as_str).map(str::to_owned).collect();
            }
            let queue = Queue::new(database.connect().await, queue_name);
            queue.enqueue(request).await.map_err(client_error)?;
            let calls = recorded(&setup, "enqueue_many_v1").await?;
            let [arguments] = calls.as_slice() else {
                return Err(format!("expected one enqueue_many_v1 call, recorded {}", calls.len()));
            };
            assert_value(
                &json!([fixture["postgres"]]),
                &arguments[0],
                &References::new(),
                "enqueue_many_v1.p_requests",
            )
        }
        .await;
        // A failed attempt may have recorded a call; the next fixture must start clean.
        let _ = recorded(&setup, "enqueue_many_v1").await;
        record(outcomes, "requests", fixture, outcome(result));
    }
}

async fn run_schedules(
    database: &ScratchDatabase,
    catalogue: &Catalogue,
    outcomes: &mut BTreeMap<String, Outcome>,
) {
    let setup = database.connect().await;
    let interposed = record_calls(&setup, "sync_schedule_definitions_v2").await;
    for fixture in catalogue.category("schedules") {
        let result = async {
            interposed.clone()?;
            let namespace = fixture["namespace"].as_str().ok_or("fixture names no namespace")?;
            let prune = fixture["prune"].as_bool().ok_or("fixture sets no prune flag")?;
            let definitions = fixture["application"]
                .as_array()
                .ok_or("fixture has no application definitions")?
                .iter()
                .map(|definition| ScheduleDefinition {
                    namespace: namespace.to_owned(),
                    name: definition["name"].as_str().unwrap_or_default().to_owned(),
                    definition: definition.clone(),
                })
                .collect::<Vec<_>>();
            let default_queue =
                fixture["defaultQueue"].as_str().ok_or("fixture names no default queue")?;
            let queue = Queue::new(database.connect().await, default_queue);
            queue.sync_schedule(namespace, &definitions, prune).await.map_err(client_error)?;
            let calls = recorded(&setup, "sync_schedule_definitions_v2").await?;
            let [arguments] = calls.as_slice() else {
                return Err(format!(
                    "expected one sync_schedule_definitions_v2 call, recorded {}",
                    calls.len()
                ));
            };
            assert_value(
                &json!([namespace, fixture["postgres"], prune]),
                arguments,
                &References::new(),
                "sync_schedule_definitions_v2",
            )
        }
        .await;
        let _ = recorded(&setup, "sync_schedule_definitions_v2").await;
        record(outcomes, "schedules", fixture, outcome(result));
    }
}

// ----- compatibility -------------------------------------------------------------------------

/// Install the versions a compatibility fixture describes, then ask the Rust client whether it
/// would run against them. The client reports no refusal code, so a refusing fixture cannot pass.
async fn run_compatibility(
    database: &ScratchDatabase,
    catalogue: &Catalogue,
    outcomes: &mut BTreeMap<String, Outcome>,
) {
    let setup = database.connect().await;
    for fixture in catalogue.category("compatibility") {
        if fixture["clientProtocolVersion"].as_i64()
            != Some(i64::from(workhorse::CLIENT_PROTOCOL_VERSION))
        {
            let reason = format!(
                "the Rust client always speaks protocol {}; it cannot present protocol {}",
                workhorse::CLIENT_PROTOCOL_VERSION,
                fixture["clientProtocolVersion"]
            );
            record(outcomes, "compatibility", fixture, Outcome::Unsupported(reason));
            continue;
        }
        let result = async {
            let installed = fixture["installedSchemaVersion"].as_i64();
            let served: Vec<i32> = fixture["servedProtocolVersions"]
                .as_array()
                .ok_or("fixture lists no served protocols")?
                .iter()
                .map(|version| {
                    version
                        .as_i64()
                        .and_then(|version| i32::try_from(version).ok())
                        .ok_or("bad protocol version")
                })
                .collect::<Result<_, _>>()?;
            install_versions(&setup, installed, &served).await?;
            let queue = Queue::new(database.connect().await, "default");
            let checked = queue.check_compatibility().await;
            if installed.is_none() {
                setup
                    .batch_execute("ALTER SCHEMA workhorse_hidden RENAME TO workhorse")
                    .await
                    .map_err(|error| database::describe(&error))?;
            }
            let expected = fixture["compatible"].as_bool().ok_or("fixture states no verdict")?;
            match (checked, expected) {
                (Ok(_), true) => Ok(()),
                (Ok(found), false) => {
                    Err(format!("accepted {found:?}; expected refusal {}", fixture["refusalCode"]))
                }
                (Err(error), true) => {
                    Err(format!("refused a compatible installation: {}", client_error(error)))
                }
                (Err(error), false) => Err(format!(
                    "refused without refusal code {} ({})",
                    fixture["refusalCode"],
                    client_error(error)
                )),
            }
        }
        .await;
        record(outcomes, "compatibility", fixture, outcome(result));
    }
}

async fn install_versions(
    client: &Client,
    installed: Option<i64>,
    served: &[i32],
) -> Result<(), String> {
    let describe = |error: tokio_postgres::Error| database::describe(&error);
    client
        .batch_execute(
            "DELETE FROM workhorse.schema_version; DELETE FROM workhorse.protocol_version",
        )
        .await
        .map_err(describe)?;
    for version in served {
        client
            .execute("INSERT INTO workhorse.protocol_version (version) VALUES ($1)", &[version])
            .await
            .map_err(describe)?;
    }
    match installed {
        Some(version) => {
            let version = i32::try_from(version).map_err(|error| error.to_string())?;
            client
                .execute("INSERT INTO workhorse.schema_version (version) VALUES ($1)", &[&version])
                .await
                .map_err(describe)?;
        }
        // No installed schema: the client must find no `workhorse` schema at all.
        None => client
            .batch_execute("ALTER SCHEMA workhorse RENAME TO workhorse_hidden")
            .await
            .map_err(describe)?,
    }
    Ok(())
}

// ----- self-tests ----------------------------------------------------------------------------

#[cfg(test)]
mod self_tests {
    use super::*;
    use conformance::ledger::ExpectedUnsupported;

    fn listed(entries: &[(&str, &str)]) -> Ledger {
        Ledger {
            _comment: String::new(),
            fixtures: entries
                .iter()
                .map(|(fixture, issue)| ExpectedUnsupported {
                    fixture: (*fixture).to_owned(),
                    issue: (*issue).to_owned(),
                    reason: "tracked".to_owned(),
                })
                .collect(),
        }
    }

    fn declared(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn an_unlisted_failing_fixture_fails_the_run() {
        let outcomes =
            BTreeMap::from([("requests/a".to_owned(), Outcome::Failed("wrong column".to_owned()))]);
        let problems = reconcile(&declared(&["requests/a"]), &outcomes, &listed(&[]));
        assert_eq!(problems, ["requests/a does not pass and is not listed: wrong column"]);
    }

    #[test]
    fn an_unlisted_unsupported_fixture_fails_the_run() {
        let outcomes = BTreeMap::from([(
            "runtime/a".to_owned(),
            Outcome::Unsupported("no worker".to_owned()),
        )]);
        let problems = reconcile(&declared(&["runtime/a"]), &outcomes, &listed(&[]));
        assert_eq!(problems, ["runtime/a does not pass and is not listed: no worker"]);
    }

    #[test]
    fn a_listed_fixture_that_passes_fails_the_run() {
        let outcomes = BTreeMap::from([("requests/a".to_owned(), Outcome::Passed)]);
        let problems =
            reconcile(&declared(&["requests/a"]), &outcomes, &listed(&[("requests/a", "SM-874")]));
        assert_eq!(
            problems,
            ["requests/a now passes; remove it from the expected-unsupported list (SM-874)"]
        );
    }

    #[test]
    fn a_listed_failing_fixture_and_a_skipped_fixture_are_accepted() {
        let outcomes = BTreeMap::from([
            ("requests/a".to_owned(), Outcome::Failed("wrong column".to_owned())),
            ("scenarios/b".to_owned(), Outcome::Skipped("no database".to_owned())),
        ]);
        let problems = reconcile(
            &declared(&["requests/a", "scenarios/b"]),
            &outcomes,
            &listed(&[("requests/a", "SM-874")]),
        );
        assert!(problems.is_empty(), "{problems:?}");
    }

    #[test]
    fn list_entries_must_name_a_declared_fixture_once_with_an_issue() {
        let outcomes = BTreeMap::from([("requests/a".to_owned(), Outcome::Failed("x".to_owned()))]);
        let problems = reconcile(
            &declared(&["requests/a"]),
            &outcomes,
            &listed(&[
                ("requests/a", "SM-874"),
                ("requests/a", "SM-874"),
                ("requests/gone", "WH-12"),
            ]),
        );
        assert_eq!(
            problems,
            [
                "requests/a is listed twice",
                "requests/gone names tracking issue \"WH-12\", not SM-<number>",
                "requests/gone is listed but no protocol/v1 fixture declares it",
            ]
        );
    }

    #[test]
    fn a_declared_fixture_that_never_ran_fails_the_run() {
        let problems = reconcile(
            &declared(&["requests/a", "requests/b"]),
            &BTreeMap::from([("requests/a".to_owned(), Outcome::Passed)]),
            &listed(&[]),
        );
        assert_eq!(problems, ["requests/b was never executed"]);
    }

    #[test]
    fn an_unclassified_protocol_file_fails_the_run() {
        let directory =
            std::env::temp_dir().join(format!("workhorse-rust-conformance-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        for entry in std::fs::read_dir(protocol_directory()).unwrap() {
            let entry = entry.unwrap();
            std::fs::copy(entry.path(), directory.join(entry.file_name())).unwrap();
        }
        std::fs::write(directory.join("leases.json"), "[]").unwrap();
        let error = Catalogue::load(&directory).err();
        std::fs::remove_dir_all(&directory).unwrap();
        assert_eq!(
            error.as_deref(),
            Some("protocol/v1 holds files the Rust runner does not classify: leases.json; execute them or name them as metadata")
        );
    }

    #[test]
    fn missing_manifest_coverage_fails_the_run() {
        let manifest = json!({"coverage": ["enqueue", "claim"], "runtimeCoverage": []});
        let coverage = BTreeSet::from(["enqueue".to_owned()]);
        assert_eq!(
            manifest_coverage(&manifest, &coverage),
            Err("SQL protocol fixtures lack coverage: claim".to_owned())
        );
    }

    #[test]
    fn the_interpreter_rejects_a_matcher_that_accepts_everything() {
        // The shared self-test must fail when a step it expects to reject is accepted.
        let fixture = json!({
            "id": "self-test",
            "steps": [{"id": "reject", "expect": {"$type": "any"}, "actual": true, "rejects": true}],
            "errors": []
        });
        assert_eq!(
            run_interpreter(&fixture),
            Err("self-test/reject accepted a value the fixture rejects".to_owned())
        );
    }

    #[test]
    fn the_matcher_compares_numbers_by_value() {
        assert!(same(&json!(1), &json!(1.0)));
        assert!(single_key(json!({"$ref": "a"}).as_object().unwrap(), "$ref").is_some());
    }
}
