//! The embedded dashboard backend as a [`tower_service::Service`].
//!
//! [`handler`] serves the dashboard/v1 RPC contract, the browser bundle and its application shell
//! under one mount path. Every procedure is one statement from the generated catalogue or one
//! [`Admin`](crate::Admin) call, so PostgreSQL still decides every state transition.
//!
//! The service accepts a path either with the mount prefix or with it stripped, so it works both
//! as a whole application and under a router that strips the prefix, such as axum's
//! `Router::nest_service`. Nest it at the same path as [`DashboardOptions::path`], because the
//! redirects, asset URLs and RPC URL the service emits start with that path.
//!
//! ```ignore
//! let authorize = workhorse::dashboard::authorize(|_parts| async {
//!     Authorization::Principal(Principal { actor: "operator@example.com".into() })
//! });
//! let dashboard = workhorse::dashboard::handler(DashboardOptions::new(pool, authorize))?;
//! let app = axum::Router::new().nest_service("/workhorse", dashboard);
//! ```
mod backend;
mod v1_generated;

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::future::Future;
use std::io::Read;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};

use http::header::{CACHE_CONTROL, CONTENT_TYPE, HOST, LOCATION, ORIGIN};
use http::{Method, StatusCode};
use http_body_util::{BodyExt, Full, Limited};
use serde_json::{json, Map, Value};

pub use bytes;
pub use http;
pub use http_body_util;
pub use v1_generated::PROCEDURES;

use crate::{Error, Executor};
use backend::Backend;

/// A boxed future that a callback returns to the service.
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// Every response the service writes.
pub type Response = http::Response<Full<bytes::Bytes>>;

/// The identity an embedding application's authorization boundary establishes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Principal {
    pub actor: String,
}

/// One authorization decision for a dashboard, asset or RPC request.
#[derive(Debug)]
pub enum Authorization {
    Principal(Principal),
    /// The service answers 401 Unauthorized.
    Unauthenticated,
    /// The service returns this response as it is, for example a redirect to a sign-in page.
    Response(Response),
}

/// Authenticates and authorizes every request under the mount path. It sees the request head
/// only; the service never exposes the body to it.
pub type Authorize = Arc<dyn Fn(&http::request::Parts) -> BoxFuture<Authorization> + Send + Sync>;

/// Implements one dashboard/v1 procedure. It receives the validated input and the audit actor.
pub type Procedure =
    Arc<dyn Fn(Value, String) -> BoxFuture<Result<Value, ProcedureError>> + Send + Sync>;

/// Wraps an async closure as an [`Authorize`] callback.
pub fn authorize<F, Fut>(callback: F) -> Authorize
where
    F: Fn(&http::request::Parts) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Authorization> + Send + 'static,
{
    Arc::new(move |parts| Box::pin(callback(parts)))
}

/// Wraps an async closure as a [`Procedure`].
pub fn procedure<F, Fut>(callback: F) -> Procedure
where
    F: Fn(Value, String) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Value, ProcedureError>> + Send + 'static,
{
    Arc::new(move |input, actor| Box::pin(callback(input, actor)))
}

/// A defined dashboard error a procedure returns with its own status and code.
#[derive(Clone, Debug, PartialEq)]
pub struct RpcError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { status, code: code.into(), message: message.into(), data: None }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, "NOT_FOUND", message)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, "BAD_REQUEST", message)
    }

    fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

/// Why a procedure failed.
#[derive(Debug)]
pub enum ProcedureError {
    /// Returned to the browser as it is.
    Rpc(RpcError),
    /// [`Error::InvalidArgument`] becomes 400 Bad Request; any other error becomes 500 Internal
    /// Server Error without its details.
    Client(Error),
}

impl From<RpcError> for ProcedureError {
    fn from(error: RpcError) -> Self {
        Self::Rpc(error)
    }
}

impl From<Error> for ProcedureError {
    fn from(error: Error) -> Self {
        Self::Client(error)
    }
}

/// Configures one single-workspace embedded dashboard.
pub struct DashboardOptions<E> {
    pub executor: E,
    pub authorize: Authorize,
    /// The mount path; `/workhorse` by default and empty for the root.
    pub path: String,
    /// Shown by the dashboard; `development` by default.
    pub environment: String,
    /// When not empty, attributes every mutation to this actor instead of the principal's.
    pub audit_actor: String,
    /// Refuses every mutation with 403 Forbidden.
    pub read_only: bool,
    /// Script URLs the application shell loads as modules.
    pub browser_modules: Vec<String>,
    /// Worker names the dashboard lists even before they report.
    pub configured_workers: Vec<String>,
    /// `{"tickIntervalMs": 1000}` by default.
    pub maintenance_loops: Option<Value>,
    /// Lists the `host[:port]` values this dashboard answers to. When set, a request whose host
    /// is not listed receives 421 Misdirected Request before `authorize` runs. Letter case and a
    /// default port do not matter. Leave it empty when the embedding application already
    /// validates the host.
    pub allowed_hosts: Vec<String>,
    /// Treats a request whose URI carries no scheme as HTTPS. Set it when the listener
    /// terminates TLS, so same-origin checks and default ports use the right scheme.
    pub https: bool,
    /// Host-supplied procedures, such as `enqueueTest` and `setSchedulePaused`. An entry replaces
    /// the built-in procedure of the same name.
    pub procedures: HashMap<String, Procedure>,
}

impl<E> DashboardOptions<E> {
    pub fn new(executor: E, authorize: Authorize) -> Self {
        Self {
            executor,
            authorize,
            path: "/workhorse".into(),
            environment: "development".into(),
            audit_actor: String::new(),
            read_only: false,
            browser_modules: Vec::new(),
            configured_workers: Vec::new(),
            maintenance_loops: None,
            allowed_hosts: Vec::new(),
            https: false,
            procedures: HashMap::new(),
        }
    }
}

/// The dashboard as a cloneable [`tower_service::Service`].
pub struct DashboardService<E: Executor> {
    inner: Arc<Host<E>>,
}

impl<E: Executor> Clone for DashboardService<E> {
    fn clone(&self) -> Self {
        Self { inner: Arc::clone(&self.inner) }
    }
}

/// Builds the dashboard service. It refuses an allowed host that is not a bare `host[:port]`.
pub fn handler<E: Executor>(options: DashboardOptions<E>) -> Result<DashboardService<E>, Error> {
    let mut allowed_hosts = HashSet::new();
    for entry in &options.allowed_hosts {
        let bare = entry.parse::<http::uri::Authority>().is_ok_and(|authority| {
            authority.as_str() == entry && !entry.contains('@') && !entry.is_empty()
        });
        if !bare {
            return Err(Error::invalid(format!(
                "dashboard allowed host must be a bare host[:port]: {entry:?}"
            )));
        }
        allowed_hosts.insert(canonical_host(entry, "http"));
        allowed_hosts.insert(canonical_host(entry, "https"));
    }
    let backend = Backend::new(
        options.executor,
        options.environment,
        options.configured_workers,
        options.read_only,
        options.maintenance_loops.unwrap_or_else(|| json!({ "tickIntervalMs": 1000 })),
    );
    let host = Host {
        backend,
        base_path: normalize_path(&options.path),
        allowed_hosts,
        authorize: options.authorize,
        audit_actor: options.audit_actor,
        read_only: options.read_only,
        https: options.https,
        browser_modules: options.browser_modules,
        extensions: options.procedures,
        compatible: tokio::sync::Mutex::new(false),
    };
    Ok(DashboardService { inner: Arc::new(host) })
}

impl<E, B> tower_service::Service<http::Request<B>> for DashboardService<E>
where
    E: Executor + 'static,
    B: http_body::Body + Send + 'static,
    B::Data: Send,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    type Response = Response;
    type Error = Infallible;
    type Future = BoxFuture<Result<Response, Infallible>>;

    fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: http::Request<B>) -> Self::Future {
        let host = Arc::clone(&self.inner);
        Box::pin(async move { Ok(host.handle(request).await) })
    }
}

/// Procedures that change state. Each needs a same-origin request and a writable dashboard.
const MUTATIONS: [&str; 15] = [
    "enqueueTest",
    "setSchedulePaused",
    "setQueuePaused",
    "purgeQueue",
    "setWorkerPaused",
    "overrideMaintenancePolicy",
    "revertMaintenancePolicy",
    "overrideRetentionPolicy",
    "revertRetentionPolicy",
    "runTaskNow",
    "cancelTask",
    "signalTask",
    "completeHumanWait",
    "redriveTask",
    "redriveDeadLetters",
];

/// Mutations only a host extension implements.
const OPTIONAL_MUTATIONS: [&str; 2] = ["enqueueTest", "setSchedulePaused"];

/// The largest RPC request body the service reads.
const MAX_REQUEST_BYTES: usize = 2 << 20;

struct Host<E: Executor> {
    backend: Backend<E>,
    base_path: String,
    allowed_hosts: HashSet<String>,
    authorize: Authorize,
    audit_actor: String,
    read_only: bool,
    https: bool,
    browser_modules: Vec<String>,
    extensions: HashMap<String, Procedure>,
    /// Set once the installed schema passed the compatibility check; a failure is retried.
    compatible: tokio::sync::Mutex<bool>,
}

impl<E: Executor> Host<E> {
    async fn handle<B>(&self, request: http::Request<B>) -> Response
    where
        B: http_body::Body,
        B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
    {
        let (parts, body) = request.into_parts();
        let path = self.resolve(parts.uri.path());
        let scheme = match parts.uri.scheme_str() {
            Some(scheme) => scheme,
            None if self.https => "https",
            None => "http",
        };
        let host = parts
            .headers
            .get(HOST)
            .and_then(|value| value.to_str().ok())
            .or_else(|| parts.uri.authority().map(|authority| authority.as_str()))
            .unwrap_or_default();
        // A name the dashboard does not answer to may resolve to this listener, so its requests
        // are refused before any credential or session is consulted.
        if !self.allowed_hosts.is_empty()
            && !self.allowed_hosts.contains(&canonical_host(host, scheme))
        {
            return json_response(421, &json!({ "error": "Misdirected Request" }));
        }
        let principal = match (self.authorize)(&parts).await {
            Authorization::Principal(principal) => principal,
            Authorization::Unauthenticated => {
                return json_response(401, &json!({ "error": "Unauthorized" }))
            }
            Authorization::Response(response) => return response,
        };
        let actor =
            if self.audit_actor.is_empty() { principal.actor } else { self.audit_actor.clone() };
        if let Err(error) = self.assert_compatible().await {
            return json_response(503, &json!({ "error": error.to_string() }));
        }

        let mount_root = if self.base_path.is_empty() { "/" } else { &self.base_path };
        if path == mount_root {
            let mut response = http::Response::new(Full::default());
            *response.status_mut() = StatusCode::FOUND;
            let location = format!("{}/tasks", self.base_path);
            if let Ok(location) = http::HeaderValue::try_from(location) {
                response.headers_mut().insert(LOCATION, location);
            }
            return response;
        }
        let relative = &path[self.base_path.len() + 1..];
        if relative.starts_with("assets/") {
            return asset(relative);
        }
        if let Some(procedure) = relative.strip_prefix("rpc/dashboard/") {
            let request = RpcRequest { parts: &parts, scheme, host, procedure, actor };
            return self.rpc(request, body).await;
        }
        self.application(&actor)
    }

    /// Maps a request path to one under the mount path. A router that strips the mount prefix
    /// passes the remainder, so a path the mount does not own is relative to it.
    fn resolve(&self, path: &str) -> String {
        let path = if path.is_empty() { "/" } else { path };
        let owned = self.base_path.is_empty()
            || path == self.base_path
            || path.strip_prefix(&self.base_path).is_some_and(|rest| rest.starts_with('/'));
        match path {
            _ if owned => path.to_string(),
            "/" => self.base_path.clone(),
            _ if path.starts_with('/') => format!("{}{path}", self.base_path),
            _ => format!("{}/{path}", self.base_path),
        }
    }

    async fn assert_compatible(&self) -> Result<(), Error> {
        let mut compatible = self.compatible.lock().await;
        if !*compatible {
            crate::compatibility::assert_schema_compatible(self.backend.executor()).await?;
            *compatible = true;
        }
        Ok(())
    }

    async fn rpc<B>(&self, request: RpcRequest<'_>, body: B) -> Response
    where
        B: http_body::Body,
        B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
    {
        let name = request.procedure;
        if request.parts.method != Method::POST {
            return rpc_error(RpcError::new(405, "METHOD_NOT_SUPPORTED", "Method Not Supported"));
        }
        if MUTATIONS.contains(&name) {
            if !same_origin(&request) {
                let error = json!({ "error": "A same-origin mutation request is required" });
                return json_response(403, &error);
            }
            if self.read_only {
                return rpc_error(RpcError::new(403, "FORBIDDEN", "This dashboard is read-only"));
            }
        }
        let extension = self.extensions.get(name);
        if extension.is_none() && !backend::BUILT_INS.contains(&name) {
            return rpc_error(if OPTIONAL_MUTATIONS.contains(&name) {
                RpcError::new(403, "FORBIDDEN", "This procedure is not available")
            } else {
                RpcError::new(404, "NOT_FOUND", "Procedure not found")
            });
        }
        let mut input = match read_input(name, body).await {
            Ok(input) => input,
            Err(error) => return rpc_error(error),
        };
        if let Some(Value::Object(audit)) = input.get_mut("audit") {
            audit.insert("actor".into(), Value::String(request.actor.clone()));
        }
        let result = match extension {
            Some(procedure) => procedure(input, request.actor).await,
            None => match self.backend.call(name, input, &request.actor).await {
                Some(result) => result,
                None => Err(RpcError::new(404, "NOT_FOUND", "Procedure not found").into()),
            },
        };
        match result {
            Ok(Value::Null) => json_response(200, &json!({})),
            Ok(value) => json_response(200, &json!({ "json": value })),
            Err(ProcedureError::Rpc(error)) => rpc_error(error),
            Err(ProcedureError::Client(Error::InvalidArgument(message))) => {
                rpc_error(RpcError::bad_request(message))
            }
            Err(ProcedureError::Client(_)) => {
                rpc_error(RpcError::new(500, "INTERNAL_SERVER_ERROR", "Internal server error"))
            }
        }
    }

    fn application(&self, actor: &str) -> Response {
        let files = match bundle() {
            Ok(files) => files,
            Err(message) => return json_response(500, &json!({ "error": message })),
        };
        let template = String::from_utf8_lossy(&files["app/index.html"]);
        let config = json!({
            "basePath": self.base_path,
            "rpcUrl": format!("{}/rpc", self.base_path),
            "auditActor": actor,
            "workhorseVersion": env!("CARGO_PKG_VERSION"),
            "authentication": null,
            "demoTools": self.extensions.contains_key("enqueueTest"),
            "workspaces": [],
            "workspace": null,
        });
        let modules: String = self
            .browser_modules
            .iter()
            .map(|source| {
                format!(r#"<script type="module" src="{}"></script>"#, escape_html(source))
            })
            .collect();
        let html = template
            .replace(
                "/*__WORKHORSE_RUNTIME_CONFIG__*/",
                &format!("window.workhorseDashboard = {}", script_json(&config)),
            )
            .replace("<!--__WORKHORSE_BROWSER_MODULES__-->", &modules);
        response(200, "text/html; charset=utf-8", html.into())
    }
}

struct RpcRequest<'a> {
    parts: &'a http::request::Parts,
    scheme: &'a str,
    host: &'a str,
    procedure: &'a str,
    actor: String,
}

/// Reads the `{"json": input}` envelope and validates the input against the procedure's schema.
async fn read_input<B>(name: &str, body: B) -> Result<Value, RpcError>
where
    B: http_body::Body,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let bytes = Limited::new(body, MAX_REQUEST_BYTES)
        .collect()
        .await
        .map_err(|error| RpcError::bad_request(error.to_string()))?
        .to_bytes();
    let envelope: Value = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&bytes).map_err(|error| RpcError::bad_request(error.to_string()))?
    };
    let Value::Object(mut envelope) = envelope else {
        return Err(RpcError::bad_request("request envelope must be an object"));
    };
    let input = envelope.remove("json").unwrap_or(Value::Null);
    if let Err(message) = validate_input(name, &input) {
        let page = input.get("page").and_then(Value::as_i64);
        if name == "tasks" && page.is_some_and(|page| page < 1) {
            let issue = json!({
                "origin": "number",
                "code": "too_small",
                "minimum": 1,
                "inclusive": true,
                "path": ["page"],
                "message": "Too small: expected number to be >=1",
            });
            let error = RpcError::bad_request("Input validation failed");
            return Err(error.with_data(json!({ "issues": [issue] })));
        }
        return Err(RpcError::bad_request(message));
    }
    let feature = input.get("feature").unwrap_or(&Value::Null);
    if name == "enqueueTest" && input.get("kind") == Some(&json!("feature")) && feature.is_null() {
        let issue = json!({
            "code": "custom",
            "path": ["feature"],
            "message": "The feature demo kind requires a feature family",
        });
        let error = RpcError::bad_request("Input validation failed");
        return Err(error.with_data(json!({ "issues": [issue] })));
    }
    Ok(input)
}

/// Validates one procedure's input. A procedure without a schema accepts no input.
fn validate_input(name: &str, input: &Value) -> Result<(), String> {
    static VALIDATORS: OnceLock<HashMap<String, Option<jsonschema::Validator>>> = OnceLock::new();
    let validators = VALIDATORS.get_or_init(|| {
        let schemas: Map<String, Value> =
            serde_json::from_str(v1_generated::INPUT_SCHEMAS).expect("generated input schemas");
        schemas
            .into_iter()
            .map(|(name, schema)| {
                let validator = (!schema.is_null()).then(|| {
                    jsonschema::options()
                        .with_draft(jsonschema::Draft::Draft202012)
                        .should_validate_formats(false)
                        .build(&schema)
                        .expect("generated input schema compiles")
                });
                (name, validator)
            })
            .collect()
    });
    match validators.get(name) {
        None => Err(format!("unknown dashboard procedure {name:?}")),
        Some(None) if input.is_null() => Ok(()),
        Some(None) => Err(format!("{name} does not accept input")),
        Some(Some(validator)) => match validator.iter_errors(input).next() {
            None => Ok(()),
            Some(error) => Err(format!("{}: {error}", error.instance_path())),
        },
    }
}

/// A mutation's `Origin` must name this request's scheme and host.
fn same_origin(request: &RpcRequest<'_>) -> bool {
    let origin = request.parts.headers.get(ORIGIN).and_then(|value| value.to_str().ok());
    let Some(origin) = origin.and_then(|origin| origin.parse::<http::Uri>().ok()) else {
        return false;
    };
    match (origin.scheme_str(), origin.authority()) {
        (Some(scheme), Some(authority)) => {
            scheme == request.scheme && authority.as_str() == request.host
        }
        _ => false,
    }
}

fn asset(name: &str) -> Response {
    let clean = name.split('/').all(|segment| !matches!(segment, "" | "." | ".."));
    let files = match bundle() {
        Ok(files) => files,
        Err(message) => return json_response(500, &json!({ "error": message })),
    };
    let Some(data) = files.get(&format!("app/{name}")).filter(|_| clean) else {
        return json_response(404, &json!({ "error": "Not Found" }));
    };
    let content_type = match name.rsplit_once('.').map(|(_, extension)| extension) {
        Some("css") => "text/css; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    };
    let mut response = response(200, content_type, data.clone());
    let immutable = http::HeaderValue::from_static("public, max-age=31536000, immutable");
    response.headers_mut().insert(CACHE_CONTROL, immutable);
    response
}

/// The browser bundle, unpacked once from the archive `bundle.json` names.
fn bundle() -> Result<&'static HashMap<String, bytes::Bytes>, String> {
    static FILES: OnceLock<Result<HashMap<String, bytes::Bytes>, String>> = OnceLock::new();
    const MANIFEST: &[u8] = include_bytes!("../../dashboard/bundle.json");
    const ARCHIVE_NAME: &str = "read-surface-1.tar.gz";
    const ARCHIVE: &[u8] = include_bytes!("../../dashboard/read-surface-1.tar.gz");
    let unpack = || -> Result<HashMap<String, bytes::Bytes>, String> {
        let manifest: Value =
            serde_json::from_slice(MANIFEST).map_err(|error| error.to_string())?;
        if manifest["archive"] != ARCHIVE_NAME {
            return Err(format!("dashboard bundle names archive {}", manifest["archive"]));
        }
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(ARCHIVE));
        let mut files = HashMap::new();
        for entry in archive.entries().map_err(|error| error.to_string())? {
            let mut entry = entry.map_err(|error| error.to_string())?;
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let name = entry.path().map_err(|error| error.to_string())?;
            let name = name.to_string_lossy().trim_start_matches("./").to_string();
            let mut data = Vec::new();
            entry.read_to_end(&mut data).map_err(|error| error.to_string())?;
            files.insert(name, data.into());
        }
        if !files.contains_key("app/index.html") {
            return Err("dashboard bundle has no app/index.html".into());
        }
        Ok(files)
    };
    FILES.get_or_init(unpack).as_ref().map_err(Clone::clone)
}

/// Joins the non-empty segments of a mount path; the root mount is empty.
fn normalize_path(value: &str) -> String {
    value
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| format!("/{segment}"))
        .collect()
}

/// Lowercases a `host[:port]` and drops the scheme's default port, so one address has one
/// spelling.
fn canonical_host(host: &str, scheme: &str) -> String {
    let host = host.to_ascii_lowercase();
    let default_port = match scheme {
        "http" => "80",
        "https" => "443",
        _ => "",
    };
    match split_host_port(&host) {
        Some((name, port)) if port == default_port => {
            let name = if name.contains(':') { format!("[{name}]") } else { name.to_string() };
            format!("{scheme}://{name}")
        }
        _ => format!("{scheme}://{host}"),
    }
}

fn split_host_port(host: &str) -> Option<(&str, &str)> {
    if let Some(rest) = host.strip_prefix('[') {
        let (name, after) = rest.split_once(']')?;
        return Some((name, after.strip_prefix(':')?));
    }
    let (name, port) = host.rsplit_once(':')?;
    (!name.contains(':')).then_some((name, port))
}

/// Serializes JSON for an inline script, escaping what could close the element or the string.
fn script_json(value: &Value) -> String {
    value
        .to_string()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}

fn response(status: u16, content_type: &'static str, body: bytes::Bytes) -> Response {
    let mut response = http::Response::new(Full::new(body));
    *response.status_mut() =
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    response.headers_mut().insert(CONTENT_TYPE, http::HeaderValue::from_static(content_type));
    response
}

fn json_response(status: u16, value: &Value) -> Response {
    response(status, "application/json; charset=utf-8", value.to_string().into())
}

fn rpc_error(error: RpcError) -> Response {
    let mut body = json!({
        "defined": false,
        "code": error.code,
        "status": error.status,
        "message": error.message,
    });
    if let Some(data) = error.data {
        body["data"] = data;
    }
    json_response(error.status, &json!({ "json": body }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_host_drops_only_the_default_port() {
        assert_eq!(canonical_host("Example.COM:80", "http"), "http://example.com");
        assert_eq!(canonical_host("example.com:443", "http"), "http://example.com:443");
        assert_eq!(canonical_host("[::1]:443", "https"), "https://[::1]");
        assert_eq!(canonical_host("[::1]:8443", "https"), "https://[::1]:8443");
        assert_eq!(canonical_host("example.com", "https"), "https://example.com");
    }

    #[test]
    fn normalizes_mount_paths() {
        assert_eq!(normalize_path("workhorse//admin/"), "/workhorse/admin");
        assert_eq!(normalize_path("/"), "");
    }

    #[test]
    fn escapes_runtime_config_for_an_inline_script() {
        let value = json!({ "auditActor": "</script><script>alert(1)</script>&" });
        assert!(!script_json(&value).contains('<'));
        assert_eq!(serde_json::from_str::<Value>(&script_json(&value)).unwrap(), value);
    }

    #[test]
    fn unpacks_the_embedded_bundle() {
        let files = bundle().unwrap();
        let template = String::from_utf8_lossy(&files["app/index.html"]);
        assert!(template.contains("/*__WORKHORSE_RUNTIME_CONFIG__*/"));
    }

    #[test]
    fn every_contract_procedure_has_a_schema_entry() {
        for name in PROCEDURES {
            assert_ne!(
                validate_input(name, &Value::Null),
                Err(format!("unknown dashboard procedure {name:?}"))
            );
        }
    }
}
