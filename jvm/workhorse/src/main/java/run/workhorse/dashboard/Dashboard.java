package run.workhorse.dashboard;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.math.BigInteger;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;
import org.jspecify.annotations.Nullable;
import run.workhorse.CompatibilityException;
import run.workhorse.ConnectionSource;
import run.workhorse.JsonCodec;
import run.workhorse.internal.Compatibility;
import run.workhorse.internal.Json;

/**
 * A Jakarta Servlet filter that serves one embedded dashboard and its {@code dashboard/v1} RPC
 * contract from the host application's own server (ADR 0103, "Embedded dashboard backend"). The
 * counterpart of Ruby's Rack {@code Dashboard}.
 *
 * <p>Register it with {@code ServletContext.addFilter} and map it to {@code /*}. The filter reads
 * the request path from {@code getRequestURI} less {@code getContextPath}, so {@link #basePath} is
 * the path under the context path. A request outside the base path goes to {@code chain.doFilter},
 * so the host's own servlets still answer it.
 *
 * <p>For a request under the base path, the filter first checks {@code allowedHosts}, then calls
 * the {@link DashboardAuthorizer}, then checks schema compatibility. Reads and controls go through
 * {@code Admin}, {@code Queue}, and the generated catalogue, so the filter writes no SQL of its
 * own. Each call runs on its own connection from the {@link ConnectionSource}; the dashboard opens
 * no transaction. The filter is blocking and uses no asynchronous servlet API.
 */
public final class Dashboard implements Filter {
  private static final Set<String> MUTATIONS =
      Set.of(
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
          "cancelTaskGroup");
  private static final Set<String> OPTIONAL_MUTATIONS = Set.of("enqueueTest", "setSchedulePaused");
  private static final Map<String, String> CONTENT_TYPES =
      Map.of(
          ".css", "text/css; charset=utf-8",
          ".html", "text/html; charset=utf-8",
          ".js", "text/javascript; charset=utf-8",
          ".png", "image/png",
          ".svg", "image/svg+xml",
          ".woff2", "font/woff2");
  private static final String JSON_TYPE = "application/json; charset=utf-8";

  /** The largest RPC request body the dashboard reads, the same bound the other hosts apply. */
  private static final int MAX_REQUEST_BYTES = 2 << 20;

  private static final String UNVERIFIED_COMPATIBILITY =
      "Unable to verify Workhorse schema compatibility because the database query failed.";
  private static final Map<String, String> DEFAULT_PORTS = Map.of("http", ":80", "https", ":443");

  /**
   * The audit request ID bound of the SQL audit functions, in UTF-8 bytes. JSON Schema measures
   * strings in characters, so the request schema cannot state this bound.
   */
  private static final int MAX_REQUEST_ID_BYTES = 512;

  private static final System.Logger LOG = System.getLogger(Dashboard.class.getName());

  private final ConnectionSource connections;
  private final String basePath;
  private final Set<String> allowedHosts;
  private final DashboardAuthorizer authorize;
  private final String auditActor;
  private final boolean readOnly;
  private final List<String> browserModules;
  private final Map<String, Backend.Procedure> builtIns;
  private final Map<String, DashboardProcedure> extensions;
  private final JsonCodec codec;
  private final ReentrantLock lock = new ReentrantLock();
  private volatile boolean compatible;
  private volatile @Nullable Map<String, byte[]> assets;

  private Dashboard(Builder builder) {
    this.connections = builder.connections;
    this.basePath = normalizePath(builder.path);
    this.allowedHosts = allowedHosts(builder.allowedHosts);
    this.authorize = builder.authorize;
    this.auditActor = builder.auditActor;
    this.readOnly = builder.readOnly;
    this.browserModules = List.copyOf(builder.browserModules);
    this.codec = builder.codec;
    Map<String, Backend.Procedure> procedures =
        new Backend(
                builder.connections,
                builder.environment,
                builder.configuredWorkers,
                builder.maintenanceLoops,
                builder.readOnly)
            .procedures();
    Map<String, DashboardProcedure> added = new HashMap<>(builder.procedures);
    if (builder.enqueueTest != null) {
      added.put("enqueueTest", builder.enqueueTest);
    }
    if (builder.setSchedulePaused != null) {
      added.put("setSchedulePaused", builder.setSchedulePaused);
    }
    procedures.keySet().removeAll(added.keySet());
    this.builtIns = Map.copyOf(procedures);
    this.extensions = Map.copyOf(added);
  }

  /**
   * A builder for a dashboard on {@code connections}.
   *
   * @param connections supplies the connection of each call
   * @param authorize decides each request under the base path
   */
  public static Builder builder(ConnectionSource connections, DashboardAuthorizer authorize) {
    return new Builder(connections, authorize);
  }

  /**
   * The path the dashboard answers under, below the context path: {@code ""} for the root, or
   * {@code "/"} followed by the non-empty segments of the configured path.
   */
  public String basePath() {
    return basePath;
  }

  /** Whether {@code path}, a request path below the context path, is under the base path. */
  public boolean owns(String path) {
    return path.equals(basePath) || path.startsWith(basePath + "/");
  }

  @Override
  public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
      throws IOException, ServletException {
    if (!(request instanceof HttpServletRequest http)
        || !(response instanceof HttpServletResponse httpResponse)) {
      chain.doFilter(request, response);
      return;
    }
    String uri = http.getRequestURI();
    String context = http.getContextPath();
    String path = uri.startsWith(context) ? uri.substring(context.length()) : uri;
    if (!owns(path)) {
      chain.doFilter(request, response);
      return;
    }
    handle(http, path, context).send(httpResponse);
  }

  private Reply handle(HttpServletRequest request, String path, String context)
      throws ServletException, IOException {
    // A name the dashboard does not answer to may resolve to this listener, so its requests are
    // refused before any credential or session is consulted.
    String host = Objects.requireNonNullElse(request.getHeader("Host"), "");
    if (!allowedHosts.isEmpty()
        && !allowedHosts.contains(canonicalHost(host, request.getScheme()))) {
      return json(421, Map.of("error", "Misdirected Request"));
    }

    DashboardAuthorization authorization;
    try {
      authorization = authorize.authorize(request);
    } catch (IOException | ServletException | RuntimeException error) {
      throw error;
    } catch (Exception error) {
      throw new ServletException("the dashboard authorizer failed", error);
    }
    // A verified principal names the actor; the audit actor stands in only for a bare allow.
    String actor;
    switch (authorization) {
      case DashboardAuthorization.Deny deny -> {
        return json(401, Map.of("error", "Unauthorized"));
      }
      case DashboardAuthorization.Allow allow -> actor = auditActor;
      case DashboardAuthorization.Principal principal -> actor = principal.actor();
    }

    Reply refusal = assertCompatible();
    if (refusal != null) {
      return refusal;
    }

    if (path.equals(basePath) || path.equals(basePath + "/")) {
      return new Reply(302, Map.of("Location", context + basePath + "/tasks"), new byte[0]);
    }
    if (path.startsWith(basePath + "/assets/")) {
      return asset(path.substring(basePath.length() + 1));
    }
    String rpcPrefix = basePath + "/rpc/dashboard/";
    if (path.startsWith(rpcPrefix)) {
      return rpc(request, path.substring(rpcPrefix.length()), actor);
    }
    return application(context, actor);
  }

  /** A refusal is not cached, so the dashboard recovers once an operator migrates the schema. */
  private @Nullable Reply assertCompatible() {
    if (compatible) {
      return null;
    }
    lock.lock();
    try {
      if (compatible) {
        return null;
      }
      CompatibilityException.Code code;
      Connection connection = connections.acquire();
      try {
        code = Compatibility.evaluate(connection);
      } finally {
        connections.release(connection, false);
      }
      if (code != null) {
        return json(503, Map.of("error", new CompatibilityException(code).getMessage()));
      }
      compatible = true;
      return null;
    } catch (Exception error) {
      // A driver error can name the database host, user, or path, so it stays in the log.
      LOG.log(
          System.Logger.Level.ERROR,
          "workhorse dashboard: schema compatibility check failed",
          error);
      return json(503, Map.of("error", UNVERIFIED_COMPATIBILITY));
    } finally {
      lock.unlock();
    }
  }

  private Reply rpc(HttpServletRequest request, String procedure, String actor) throws IOException {
    if (!"POST".equals(request.getMethod())) {
      return rpcError(405, "METHOD_NOT_SUPPORTED", "Method Not Supported", null);
    }
    if (MUTATIONS.contains(procedure)) {
      if (!sameOrigin(request)) {
        return json(403, Map.of("error", "A same-origin mutation request is required"));
      }
      if (readOnly) {
        return rpcError(403, "FORBIDDEN", "This dashboard is read-only", null);
      }
    }
    Backend.Procedure builtIn = builtIns.get(procedure);
    DashboardProcedure extension = extensions.get(procedure);
    if (builtIn == null && extension == null) {
      if (OPTIONAL_MUTATIONS.contains(procedure)) {
        return rpcError(403, "FORBIDDEN", "This procedure is not available", null);
      }
      return rpcError(404, "NOT_FOUND", "Procedure not found", null);
    }

    byte[] body = readBody(request);
    if (body == null) {
      return rpcError(413, "PAYLOAD_TOO_LARGE", "Payload Too Large", null);
    }

    @Nullable Object input = null;
    @Nullable Object value;
    boolean extended = builtIn == null;
    try {
      String text = body.length == 0 ? "{}" : utf8(body);
      Map<String, @Nullable Object> envelope = Json.object(Json.parse(text));
      if (envelope == null) {
        throw new Validator.InputValidationException("request envelope must be an object");
      }
      input = envelope.get("json");
      Validator.validate(procedure, input);
      Map<String, @Nullable Object> object = Json.object(input);
      if (procedure.equals("enqueueTest")
          && object != null
          && "feature".equals(object.get("kind"))
          && !object.containsKey("feature")) {
        throw invalid(
            "custom", List.of("feature"), "The feature demo kind requires a feature family");
      }
      if (MUTATIONS.contains(procedure) && oversizedRequestId(object)) {
        throw invalid(
            "custom",
            List.of("audit", "requestId"),
            "The request ID must contain at most 512 UTF-8 bytes");
      }
      Map<String, @Nullable Object> audit =
          object == null ? null : Json.object(object.get("audit"));
      if (object != null && audit != null) {
        Map<String, @Nullable Object> replaced = new LinkedHashMap<>(audit);
        replaced.put("actor", actor);
        Map<String, @Nullable Object> copy = new LinkedHashMap<>(object);
        copy.put("audit", replaced);
        object = copy;
        input = copy;
      }
      value =
          builtIn != null
              ? builtIn.call(object == null ? new LinkedHashMap<>() : object, actor)
              : Objects.requireNonNull(extension).call(input, actor);
    } catch (Validator.InputValidationException error) {
      Map<String, @Nullable Object> object = Json.object(input);
      if (procedure.equals("tasks")
          && object != null
          && ((object.get("page") instanceof Long page && page < 1)
              || (object.get("page") instanceof BigInteger large && large.signum() < 0))) {
        return rpcError(400, "BAD_REQUEST", "Input validation failed", tooSmallPage());
      }
      return rpcError(400, "BAD_REQUEST", Objects.requireNonNullElse(error.getMessage(), ""), null);
    } catch (DashboardRpcException error) {
      return rpcError(error.status(), error.code(), error.getMessage(), error.data());
    } catch (IllegalArgumentException error) {
      return rpcError(400, "BAD_REQUEST", Objects.requireNonNullElse(error.getMessage(), ""), null);
    } catch (Exception error) {
      LOG.log(
          System.Logger.Level.ERROR,
          "workhorse dashboard: procedure " + procedure + " failed",
          error);
      return rpcError(500, "INTERNAL_SERVER_ERROR", "Internal server error", null);
    }
    // A result that the codec cannot encode is a server failure, not a refused request.
    String result;
    try {
      result =
          value == null
              ? null
              : extended ? Json.write(Json.parse(codec.encode(value))) : Json.write(value);
    } catch (RuntimeException error) {
      LOG.log(
          System.Logger.Level.ERROR,
          "workhorse dashboard: procedure " + procedure + " returned a value that is not JSON",
          error);
      return rpcError(500, "INTERNAL_SERVER_ERROR", "Internal server error", null);
    }
    return new Reply(
        200,
        Map.of("Content-Type", JSON_TYPE),
        (result == null ? "{}" : "{\"json\":" + result + "}").getBytes(StandardCharsets.UTF_8));
  }

  private static DashboardRpcException invalid(String code, List<String> path, String message) {
    Map<String, @Nullable Object> issue = new LinkedHashMap<>();
    issue.put("code", code);
    issue.put("path", path);
    issue.put("message", message);
    return new DashboardRpcException(
        400, "BAD_REQUEST", "Input validation failed", Map.of("issues", List.of(issue)));
  }

  private static Map<String, @Nullable Object> tooSmallPage() {
    Map<String, @Nullable Object> issue = new LinkedHashMap<>();
    issue.put("origin", "number");
    issue.put("code", "too_small");
    issue.put("minimum", 1L);
    issue.put("inclusive", true);
    issue.put("path", List.of("page"));
    issue.put("message", "Too small: expected number to be >=1");
    return Map.of("issues", List.of(issue));
  }

  private static boolean oversizedRequestId(@Nullable Map<String, @Nullable Object> input) {
    Map<String, @Nullable Object> audit = input == null ? null : Json.object(input.get("audit"));
    return audit != null
        && audit.get("requestId") instanceof String requestId
        && requestId.getBytes(StandardCharsets.UTF_8).length > MAX_REQUEST_ID_BYTES;
  }

  private static String utf8(byte[] body) {
    try {
      return StandardCharsets.UTF_8
          .newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(body))
          .toString();
    } catch (CharacterCodingException error) {
      throw new IllegalArgumentException("request body is not UTF-8", error);
    }
  }

  /** At most {@code MAX_REQUEST_BYTES} of the request body, or {@code null} when it is larger. */
  private static byte @Nullable [] readBody(HttpServletRequest request) throws IOException {
    String declared = request.getHeader("Content-Length");
    if (declared != null && !declared.isEmpty()) {
      if (!declared.matches("[0-9]+")
          || declared.length() > 9
          || Long.parseLong(declared) > MAX_REQUEST_BYTES) {
        return null;
      }
    }
    try (InputStream input = request.getInputStream()) {
      byte[] body = input.readNBytes(MAX_REQUEST_BYTES + 1);
      return body.length > MAX_REQUEST_BYTES ? null : body;
    }
  }

  private boolean sameOrigin(HttpServletRequest request) {
    String origin = request.getHeader("Origin");
    if (origin == null) {
      return false;
    }
    URI parsed;
    try {
      parsed = new URI(origin);
    } catch (URISyntaxException error) {
      return false;
    }
    String scheme = parsed.getScheme();
    String host = parsed.getHost();
    if (scheme == null || host == null || host.isEmpty()) {
      return false;
    }
    String rest =
        origin.startsWith(scheme + "://") ? origin.substring(scheme.length() + 3) : origin;
    String netloc = rest.split("[/?#]", 2)[0];
    return (scheme + "://" + netloc)
        .equals(
            request.getScheme()
                + "://"
                + Objects.requireNonNullElse(request.getHeader("Host"), ""));
  }

  private Reply application(String context, String actor) {
    Map<String, @Nullable Object> config = new LinkedHashMap<>();
    config.put("basePath", context + basePath);
    config.put("rpcUrl", context + basePath + "/rpc");
    config.put("auditActor", actor);
    config.put("workhorseVersion", version());
    config.put("authentication", null);
    config.put("demoTools", extensions.containsKey("enqueueTest"));
    config.put("workspaces", List.of());
    config.put("workspace", null);
    StringBuilder modules = new StringBuilder();
    for (String source : browserModules) {
      modules
          .append("<script type=\"module\" src=\"")
          .append(escapeHtml(source))
          .append("\"></script>");
    }
    byte[] page = bundleFiles().get("app/index.html");
    if (page == null) {
      throw new IllegalStateException("the dashboard bundle has no app/index.html");
    }
    String html =
        new String(page, StandardCharsets.UTF_8)
            .replaceFirst(
                java.util.regex.Pattern.quote("/*__WORKHORSE_RUNTIME_CONFIG__*/"),
                java.util.regex.Matcher.quoteReplacement(
                    "window.workhorseDashboard = " + scriptSafe(Json.write(config))))
            .replaceFirst(
                java.util.regex.Pattern.quote("<!--__WORKHORSE_BROWSER_MODULES__-->"),
                java.util.regex.Matcher.quoteReplacement(modules.toString()));
    return new Reply(
        200,
        Map.of("Content-Type", "text/html; charset=utf-8"),
        html.getBytes(StandardCharsets.UTF_8));
  }

  private Reply asset(String name) {
    if (List.of(name.split("/", -1)).contains("..") || name.startsWith("/")) {
      return json(404, Map.of("error", "Not Found"));
    }
    byte[] data = bundleFiles().get("app/" + name);
    if (data == null) {
      return json(404, Map.of("error", "Not Found"));
    }
    int dot = name.lastIndexOf('.');
    int slash = name.lastIndexOf('/');
    String extension = dot > slash ? name.substring(dot) : "";
    return new Reply(
        200,
        Map.of(
            "Content-Type",
            CONTENT_TYPES.getOrDefault(extension, "application/octet-stream"),
            "Cache-Control",
            "public, max-age=31536000, immutable"),
        data);
  }

  /** The browser bundle's files by archive path, unpacked once from the class path. */
  private Map<String, byte[]> bundleFiles() {
    Map<String, byte[]> files = assets;
    if (files != null) {
      return files;
    }
    lock.lock();
    try {
      files = assets;
      if (files == null) {
        files = Bundle.files();
        assets = files;
      }
      return files;
    } finally {
      lock.unlock();
    }
  }

  /**
   * The SDK version that the build writes into {@code version.properties} from {@code
   * project.version}, or {@code unknown} when the resource is absent.
   */
  static String version() {
    try (InputStream stream =
        Dashboard.class.getResourceAsStream("/run/workhorse/version.properties")) {
      if (stream == null) {
        return "unknown";
      }
      Properties properties = new Properties();
      properties.load(new InputStreamReader(stream, StandardCharsets.UTF_8));
      String version = properties.getProperty("version", "").trim();
      return version.isEmpty() ? "unknown" : version;
    } catch (IOException error) {
      return "unknown";
    }
  }

  /** Escapes the characters that could close the inline script of the runtime configuration. */
  private static String scriptSafe(String json) {
    StringBuilder out = new StringBuilder(json.length());
    for (int index = 0; index < json.length(); index++) {
      char character = json.charAt(index);
      switch (character) {
        case '<' -> out.append("\\u003c");
        case '>' -> out.append("\\u003e");
        case '&' -> out.append("\\u0026");
        case ' ' -> out.append("\\u2028");
        case ' ' -> out.append("\\u2029");
        default -> out.append(character);
      }
    }
    return out.toString();
  }

  private static String escapeHtml(String text) {
    StringBuilder out = new StringBuilder(text.length());
    for (int index = 0; index < text.length(); index++) {
      char character = text.charAt(index);
      switch (character) {
        case '&' -> out.append("&amp;");
        case '<' -> out.append("&lt;");
        case '>' -> out.append("&gt;");
        case '"' -> out.append("&quot;");
        case '\'' -> out.append("&#39;");
        default -> out.append(character);
      }
    }
    return out.toString();
  }

  private static Reply json(int status, Object value) {
    return new Reply(
        status,
        Map.of("Content-Type", JSON_TYPE),
        Json.write(value).getBytes(StandardCharsets.UTF_8));
  }

  private static Reply rpcError(int status, String code, String message, @Nullable Object data) {
    Map<String, @Nullable Object> error = new LinkedHashMap<>();
    error.put("defined", false);
    error.put("code", code);
    error.put("status", (long) status);
    error.put("message", message);
    if (data != null) {
      error.put("data", data);
    }
    return json(status, Map.of("json", error));
  }

  /** {@code ""} for the root, otherwise {@code "/"} followed by the non-empty segments. */
  static String normalizePath(String path) {
    List<String> segments = new ArrayList<>();
    for (String segment : path.split("/", -1)) {
      if (!segment.isEmpty()) {
        segments.add(segment);
      }
    }
    return segments.isEmpty() ? "" : "/" + String.join("/", segments);
  }

  /** Lowercases a {@code host[:port]} and drops the default port, so one address has one form. */
  static String canonicalHost(String host, String scheme) {
    String lower = host.toLowerCase(Locale.ROOT);
    String port = DEFAULT_PORTS.get(scheme);
    if (port != null && lower.endsWith(port)) {
      lower = lower.substring(0, lower.length() - port.length());
    }
    return scheme + "://" + lower;
  }

  private static Set<String> allowedHosts(List<String> entries) {
    Set<String> allowed = new HashSet<>();
    for (String entry : entries) {
      boolean bare;
      try {
        URI parsed = new URI("http://" + entry);
        String host = parsed.getHost();
        bare =
            !entry.contains("@")
                && parsed.getRawUserInfo() == null
                && parsed.getRawPath().isEmpty()
                && parsed.getRawQuery() == null
                && parsed.getRawFragment() == null
                && host != null
                && !host.isEmpty()
                && (entry.equals(host) || entry.equals(host + ":" + parsed.getPort()));
      } catch (URISyntaxException error) {
        bare = false;
      }
      if (!bare) {
        throw new IllegalArgumentException(
            "dashboard allowed host must be a bare host[:port]: \"" + entry + "\"");
      }
      allowed.add(canonicalHost(entry, "http"));
      allowed.add(canonicalHost(entry, "https"));
    }
    return Set.copyOf(allowed);
  }

  /** One response: a status, its headers, and its body. */
  private static final class Reply {
    private final int status;
    private final Map<String, String> headers;
    private final byte[] body;

    Reply(int status, Map<String, String> headers, byte[] body) {
      this.status = status;
      this.headers = headers;
      this.body = body;
    }

    void send(HttpServletResponse response) throws IOException {
      response.setStatus(status);
      headers.forEach(response::setHeader);
      response.setContentLength(body.length);
      response.getOutputStream().write(body);
    }
  }

  /** Configures a {@link Dashboard}. The options are those of Ruby's {@code Dashboard}. */
  public static final class Builder {
    private final ConnectionSource connections;
    private final DashboardAuthorizer authorize;
    private String path = "/workhorse";
    private String environment = "development";
    private String auditActor = "dashboard";
    private boolean readOnly;
    private List<String> browserModules = List.of();
    private List<String> configuredWorkers = List.of();
    private Map<String, @Nullable Object> maintenanceLoops = Map.of("tickIntervalMs", 1000L);
    private @Nullable DashboardProcedure enqueueTest;
    private @Nullable DashboardProcedure setSchedulePaused;
    private List<String> allowedHosts = List.of();
    private Map<String, DashboardProcedure> procedures = Map.of();
    private JsonCodec codec = JsonCodec.standard();

    private Builder(ConnectionSource connections, DashboardAuthorizer authorize) {
      this.connections = Objects.requireNonNull(connections, "connections");
      this.authorize = Objects.requireNonNull(authorize, "authorize");
    }

    /** The full request path below the context path that the dashboard answers under. */
    public Builder path(String path) {
      this.path = Objects.requireNonNull(path, "path");
      return this;
    }

    /**
     * The environment name that the {@code meta} procedure reports. Default {@code development}.
     */
    public Builder environment(String environment) {
      this.environment = Objects.requireNonNull(environment, "environment");
      return this;
    }

    /**
     * The actor for a request that the authorizer accepts with a bare allow. Default {@code
     * dashboard}. A principal names its own actor.
     */
    public Builder auditActor(String actor) {
      this.auditActor = Objects.requireNonNull(actor, "actor");
      return this;
    }

    /** Refuses every control, and tells the browser to offer none. */
    public Builder readOnly(boolean readOnly) {
      this.readOnly = readOnly;
      return this;
    }

    /** Extra browser module URLs that the application shell loads. */
    public Builder browserModules(List<String> sources) {
      this.browserModules = List.copyOf(sources);
      return this;
    }

    /** The worker IDs that the host expects, so the dashboard can show a missing one. */
    public Builder configuredWorkers(List<String> workerIds) {
      this.configuredWorkers = List.copyOf(workerIds);
      return this;
    }

    /**
     * The maintenance loops that the {@code cron} procedure reports, as a JSON object. Default
     * {@code {"tickIntervalMs": 1000}}.
     */
    public Builder maintenanceLoops(Map<String, ? extends @Nullable Object> loops) {
      this.maintenanceLoops = new LinkedHashMap<>(loops);
      return this;
    }

    /** The demo tools' {@code enqueueTest} procedure. The demo tools are off when it is unset. */
    public Builder enqueueTest(DashboardProcedure procedure) {
      this.enqueueTest = Objects.requireNonNull(procedure, "procedure");
      return this;
    }

    /** The {@code setSchedulePaused} procedure. The dashboard refuses the control when unset. */
    public Builder setSchedulePaused(DashboardProcedure procedure) {
      this.setSchedulePaused = Objects.requireNonNull(procedure, "procedure");
      return this;
    }

    /**
     * The {@code host[:port]} values the dashboard answers to. When set, a request whose {@code
     * Host} is not listed receives 421 Misdirected Request before the authorizer runs. Letter case
     * and a default port do not matter. Leave it empty when the host application already validates
     * {@code Host}.
     *
     * <p>{@link #build} throws {@link IllegalArgumentException} for an entry that is not a bare
     * {@code host[:port]}.
     */
    public Builder allowedHosts(List<String> hosts) {
      this.allowedHosts = List.copyOf(hosts);
      return this;
    }

    /** Adds or replaces procedures by name. */
    public Builder procedures(Map<String, DashboardProcedure> procedures) {
      this.procedures = Map.copyOf(procedures);
      return this;
    }

    /** The codec that encodes the result of each procedure the host supplies. */
    public Builder codec(JsonCodec codec) {
      this.codec = Objects.requireNonNull(codec, "codec");
      return this;
    }

    /** The dashboard. */
    public Dashboard build() {
      return new Dashboard(this);
    }
  }
}
