using System.Buffers;
using System.Collections.Frozen;
using System.Globalization;
using System.Numerics;
using System.Reflection;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Workhorse.AspNetCore.Internal;

/// <summary>
/// Serves one embedded dashboard and its <c>dashboard/v1</c> RPC contract from the host
/// application's own server (ADR 0107, "Embedded dashboard backend"). The counterpart of the JVM
/// servlet filter and of Ruby's Rack <c>Dashboard</c>.
/// </summary>
/// <remarks>
/// For each request under the mount path, the host first checks <see cref="DashboardOptions.AllowedHosts"/>,
/// then calls <see cref="DashboardOptions.Authorize"/>, then checks schema compatibility. A
/// mutation then needs a same-origin <c>Origin</c> header and a writable dashboard. The procedure
/// runs only after its input passes the request schema.
/// </remarks>
internal sealed partial class DashboardHost
{
    private static readonly FrozenSet<string> Mutations = FrozenSet.Create(
        StringComparer.Ordinal,
        "enqueueTest",
        "setSchedulePaused",
        "setQueuePaused",
        "purgeQueue",
        "setQueueTier",
        "setQueueHistory",
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

    private static readonly FrozenSet<string> OptionalMutations = FrozenSet.Create(StringComparer.Ordinal, "enqueueTest", "setSchedulePaused");

    private static readonly FrozenDictionary<string, string> ContentTypes = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [".css"] = "text/css; charset=utf-8",
        [".html"] = "text/html; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".png"] = "image/png",
        [".svg"] = "image/svg+xml",
        [".woff2"] = "font/woff2",
        [".txt"] = "text/plain; charset=utf-8",
    }.ToFrozenDictionary(StringComparer.Ordinal);

    private const string JsonType = "application/json; charset=utf-8";

    /// <summary>The largest RPC request body that the dashboard reads, the same bound that the other hosts apply.</summary>
    internal const int MaxRequestBytes = 2 << 20;

    /// <summary>
    /// The most characters, after an optional minus sign, in a number token of a request body. The
    /// browser application reads a number as a double, so it never sends a longer number. The limit
    /// keeps the parse time of a request body small, as in the JVM host.
    /// </summary>
    internal const int MaxRequestNumberLength = 1000;

    /// <summary>2^53, the largest magnitude at which every binary64 integer is exact.</summary>
    private const double MaxSafeInteger = 9007199254740992;

    /// <summary>
    /// The audit request ID bound of the SQL audit functions, in UTF-8 bytes. JSON Schema measures
    /// strings in characters, so the request schema cannot state this bound.
    /// </summary>
    private const int MaxRequestIdBytes = 512;

    private const string UnverifiedCompatibility =
        "Unable to verify Workhorse schema compatibility because the database query failed.";

    private static readonly JsonSerializerOptions DefaultJson = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// Writes the runtime configuration without the default escapes, so that <see cref="ScriptSafe"/>
    /// alone decides which characters the inline script escapes.
    /// </summary>
    private static readonly JsonSerializerOptions ScriptJson = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private readonly string _basePath;
    private readonly FrozenSet<string> _allowedHosts;
    private readonly Func<HttpContext, ValueTask<DashboardAuthorization>> _authorize;
    private readonly string _auditActor;
    private readonly bool _readOnly;
    private readonly IReadOnlyList<string> _browserModules;
    private readonly FrozenDictionary<string, BuiltInProcedure> _builtIns;
    private readonly FrozenDictionary<string, DashboardProcedure> _extensions;
    private readonly JsonSerializerOptions _json;
    private readonly Npgsql.NpgsqlDataSource _dataSource;
    private readonly Backend _backend;
    private readonly ILogger _logger;
    private volatile bool _compatible;

    internal DashboardHost(string pattern, DashboardOptions options, ILogger logger)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(options.DataSource);
        ArgumentNullException.ThrowIfNull(options.Authorize);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.AuditActor, nameof(options));
        ArgumentNullException.ThrowIfNull(options.Environment);
        _basePath = NormalizePath(pattern);
        _allowedHosts = AllowedHosts(options.AllowedHosts ?? []);
        _authorize = options.Authorize;
        _auditActor = options.AuditActor;
        _readOnly = options.ReadOnly;
        _browserModules = [.. options.BrowserModules ?? []];
        _json = options.Json ?? DefaultJson;
        _dataSource = options.DataSource;
        _logger = logger;
        _backend = new Backend(
            options.DataSource,
            options.Environment,
            [.. options.ConfiguredWorkers ?? []],
            options.MaintenanceLoops ?? new Dictionary<string, JsonElement>(),
            options.ReadOnly);
        var procedures = _backend.Procedures();
        var added = new Dictionary<string, DashboardProcedure>(options.Procedures ?? new Dictionary<string, DashboardProcedure>(), StringComparer.Ordinal);
        if (options.EnqueueTest is { } enqueueTest)
        {
            added["enqueueTest"] = enqueueTest;
        }

        if (options.SetSchedulePaused is { } setSchedulePaused)
        {
            added["setSchedulePaused"] = setSchedulePaused;
        }

        foreach (var name in added.Keys)
        {
            procedures.Remove(name);
        }

        _builtIns = procedures.ToFrozenDictionary(StringComparer.Ordinal);
        _extensions = added.ToFrozenDictionary(StringComparer.Ordinal);
    }

    /// <summary>
    /// The path that the dashboard answers under, below the path base: <c>""</c> for the root, or
    /// <c>"/"</c> followed by the non-empty segments of the pattern.
    /// </summary>
    internal string BasePath => _basePath;

    /// <summary>Answers one request that the route group matched.</summary>
    internal async Task HandleAsync(HttpContext context)
    {
        Reply reply;
        try
        {
            reply = await ReplyAsync(context).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            return;
        }

        await reply.SendAsync(context).ConfigureAwait(false);
    }

    private async Task<Reply> ReplyAsync(HttpContext context)
    {
        var request = context.Request;

        // A name that the dashboard does not answer to can resolve to this listener, so the
        // dashboard refuses its requests before it calls the authorizer.
        if (_allowedHosts.Count > 0 && !_allowedHosts.Contains(CanonicalHost(request.Headers.Host.ToString(), request.Scheme)))
        {
            return Json(421, new JsonObject { ["error"] = "Misdirected Request" });
        }

        DashboardAuthorization authorization;
        try
        {
            authorization = await _authorize(context).ConfigureAwait(false);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            LogAuthorizerFailed(_logger, error);
            return Json(500, new JsonObject { ["error"] = "Internal Server Error" });
        }

        // A verified principal names the actor. The audit actor stands in only for a bare allow.
        string actor;
        switch (authorization)
        {
            case DashboardAuthorization.AllowResult:
                actor = _auditActor;
                break;
            case DashboardAuthorization.PrincipalResult principal:
                actor = principal.Actor;
                break;
            case DashboardAuthorization.ResponseResult response:
                return new Reply(response.Status, response.Headers, response.Body);
            default:
                return Json(401, new JsonObject { ["error"] = "Unauthorized" });
        }

        if (await CompatibilityAsync(context.RequestAborted).ConfigureAwait(false) is { } refusal)
        {
            return refusal;
        }

        // A browser sends Origin on every cross-origin fetch, so a host CORS policy cannot expose a
        // read to a foreign page. A navigation sends none.
        var (mount, rest) = Split(context);
        var rpc = rest.StartsWith("/rpc/dashboard/", StringComparison.Ordinal);
        if (!rpc && request.Headers.Origin.Count > 0 && !SameOrigin(request))
        {
            return Json(403, new JsonObject { ["error"] = "A same-origin request is required" });
        }

        if (rest is "" or "/")
        {
            return new Reply(302, new Dictionary<string, string> { ["Location"] = $"{mount}/tasks" }, ReadOnlyMemory<byte>.Empty);
        }

        if (rest.StartsWith("/assets/", StringComparison.Ordinal))
        {
            return Asset(rest[1..]);
        }

        if (rpc)
        {
            return await RpcAsync(context, rest["/rpc/dashboard/".Length..], actor).ConfigureAwait(false);
        }

        return Application(mount, actor);
    }

    /// <summary>
    /// The mount as the browser sees it, with the path base and every parent route group, and the
    /// path below it. The catch-all route value holds the path below the mount, so the mount is the
    /// rest of the request path.
    /// </summary>
    private (string Mount, string Below) Split(HttpContext context)
    {
        var path = context.Request.Path.Value ?? "";
        var below = context.Request.RouteValues.TryGetValue("path", out var value) && value is string { Length: > 0 } text ? "/" + text : "";
        var mount = below.Length > 0 && path.EndsWith(below, StringComparison.Ordinal)
            ? path[..^below.Length]
            : below.Length == 0 ? path.TrimEnd('/') : _basePath;
        var rest = below.Length > 0 ? below : path[Math.Min(mount.Length, path.Length)..];
        return ((context.Request.PathBase.Value ?? "") + mount.TrimEnd('/'), rest);
    }

    /// <summary>
    /// The 503 refusal while the schema is not compatible, or <c>null</c>. The dashboard caches only
    /// a success, so it recovers after an operator migrates the schema. Two first requests can both
    /// run the check, which does no harm.
    /// </summary>
    private async Task<Reply?> CompatibilityAsync(CancellationToken cancellationToken)
    {
        if (_compatible)
        {
            return null;
        }

        try
        {
            // A Queue keeps its verdict, a refusal too, so each check after a refusal uses a new one.
            await new Queue(_dataSource).AssertCompatibleAsync(cancellationToken).ConfigureAwait(false);
            _compatible = true;
            return null;
        }
        catch (CompatibilityException error)
        {
            return Json(503, new JsonObject { ["error"] = error.Message });
        }
        catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // A driver error can name the database host, user, or path, so it stays in the log (SM-1473).
            LogCompatibilityFailed(_logger, error);
            return Json(503, new JsonObject { ["error"] = UnverifiedCompatibility });
        }
    }

    private async Task<Reply> RpcAsync(HttpContext context, string procedure, string actor)
    {
        var request = context.Request;
        if (!HttpMethods.IsPost(request.Method))
        {
            return RpcError(405, "METHOD_NOT_SUPPORTED", "Method Not Supported");
        }

        var mutation = Mutations.Contains(procedure);
        if (!mutation && request.Headers.Origin.Count > 0 && !SameOrigin(request))
        {
            return Json(403, new JsonObject { ["error"] = "A same-origin request is required" });
        }

        if (mutation)
        {
            if (!SameOrigin(request))
            {
                return Json(403, new JsonObject { ["error"] = "A same-origin mutation request is required" });
            }

            if (_readOnly)
            {
                return RpcError(403, "FORBIDDEN", "This dashboard is read-only");
            }
        }

        _builtIns.TryGetValue(procedure, out var builtIn);
        _extensions.TryGetValue(procedure, out var extension);
        if (builtIn is null && extension is null)
        {
            return OptionalMutations.Contains(procedure)
                ? RpcError(403, "FORBIDDEN", $"This dashboard host does not provide the {procedure} action")
                : RpcError(404, "NOT_FOUND", "Procedure not found");
        }

        var body = await ReadBodyAsync(request, context.RequestAborted).ConfigureAwait(false);
        if (body is null)
        {
            return RpcError(413, "PAYLOAD_TOO_LARGE", "Payload Too Large");
        }

        JsonNode? input = null;
        string? result;
        try
        {
            var envelope = Parse(body.Length == 0 ? "{}"u8.ToArray() : body) as JsonObject
                ?? throw new InputValidationException("request envelope must be an object");
            input = envelope["json"];
            Validator.Validate(procedure, input);
            var document = input as JsonObject;
            if (procedure == "enqueueTest" && document is not null
                && document["kind"]?.GetValueKind() == JsonValueKind.String
                && document["kind"]!.GetValue<string>() == "feature"
                && !document.ContainsKey("feature"))
            {
                throw Invalid(["feature"], "The feature demo kind requires a feature family");
            }

            if (procedure == "events" && document is not null && EventRangeIssue(document) is { } issue)
            {
                throw Invalid(issue.Path, issue.Message);
            }

            if (mutation && OversizedRequestId(document))
            {
                throw Invalid(["audit", "requestId"], "The request ID must contain at most 512 UTF-8 bytes");
            }

            // The server assigns the audit actor from the principal. It ignores the value that the
            // browser sent.
            if (document?["audit"] is JsonObject audit)
            {
                audit["actor"] = actor;
            }

            result = builtIn is not null
                ? await builtIn(document ?? [], actor, context.RequestAborted).ConfigureAwait(false)
                : await ExtensionAsync(extension!, procedure, input, actor, context.RequestAborted).ConfigureAwait(false);
        }
        catch (InputValidationException error)
        {
            if (procedure == "tasks" && input is JsonObject query && TooSmallPage(query["page"]))
            {
                return RpcError(400, "BAD_REQUEST", "Input validation failed", TooSmallPageData());
            }

            return RpcError(400, "BAD_REQUEST", error.Message);
        }
        catch (DashboardRpcException error)
        {
            // A host chooses the data, so its serialization can fail on a value that JSON cannot hold.
            try
            {
                return RpcError(error.Status, error.Code, error.Message, Details(error.Details));
            }
            catch (Exception failure) when (failure is not OperationCanceledException)
            {
                LogProcedureFailed(_logger, procedure, failure);
                return RpcError(500, "INTERNAL_SERVER_ERROR", "Internal server error");
            }
        }
        catch (CompatibilityException error)
        {
            // The schema changed after the first check. The next request checks it again.
            _compatible = false;
            _backend.Reset();
            return Json(503, new JsonObject { ["error"] = error.Message });
        }
        catch (ArgumentException error) when (builtIn is not null)
        {
            // The core's checks and the input readers name the field that they refuse.
            return RpcError(400, "BAD_REQUEST", error.Message);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error)
        {
            // A database or driver error can hold an address or a stored value, so it stays in the log.
            LogProcedureFailed(_logger, procedure, error);
            return RpcError(500, "INTERNAL_SERVER_ERROR", "Internal server error");
        }

        return new Reply(
            200,
            new Dictionary<string, string> { ["Content-Type"] = JsonType },
            Encoding.UTF8.GetBytes(result is null ? "{}" : $"{{\"json\":{result}}}"));
    }

    /// <summary>Calls a host procedure, and encodes its result with <see cref="DashboardOptions.Json"/>.</summary>
    private async Task<string?> ExtensionAsync(
        DashboardProcedure extension, string procedure, JsonNode? input, string actor, CancellationToken cancellationToken)
    {
        var value = await extension(JsonSerializer.SerializeToElement(input), actor, cancellationToken).ConfigureAwait(false);
        if (value is null)
        {
            return null;
        }

        try
        {
            return JsonSerializer.Serialize(value, value.GetType(), _json);
        }
        catch (Exception error) when (error is NotSupportedException or JsonException or InvalidOperationException)
        {
            throw new InvalidOperationException($"procedure {procedure} returned a value that is not JSON", error);
        }
    }

    private JsonNode? Details(object? data) => data switch
    {
        null => null,
        JsonNode node => node.DeepClone(),
        _ => JsonSerializer.SerializeToNode(data, data.GetType(), _json),
    };

    /// <summary>
    /// Parses a request body. A number token longer than <see cref="MaxRequestNumberLength"/>
    /// characters, a duplicate key, or text that is not UTF-8 refuses the request.
    /// </summary>
    internal static JsonNode? Parse(byte[] body)
    {
        var options = new JsonReaderOptions { MaxDepth = 256 };
        var reader = new Utf8JsonReader(body, options);
        try
        {
            while (reader.Read())
            {
                if (reader.TokenType == JsonTokenType.Number)
                {
                    var length = reader.HasValueSequence ? reader.ValueSequence.Length : reader.ValueSpan.Length;
                    var sign = (reader.HasValueSequence ? reader.ValueSequence.FirstSpan : reader.ValueSpan)[0] == '-' ? 1 : 0;
                    if (length - sign > MaxRequestNumberLength)
                    {
                        throw new InputValidationException(
                            $"request body has a number longer than {MaxRequestNumberLength} characters");
                    }
                }
            }

            return Integral(JsonNode.Parse(body, documentOptions: new JsonDocumentOptions { MaxDepth = 256, AllowDuplicateProperties = false }));
        }
        catch (JsonException error)
        {
            throw new InputValidationException($"request body is not valid JSON: {error.Message}");
        }
    }

    /// <summary>
    /// Writes each number whose binary64 value is an integer, such as <c>1.0</c> or <c>1e0</c>, as
    /// that integer. JSON Schema defines an integer by its value, and the reference server reads the
    /// body with <c>JSON.parse</c>, which gives the same number. A fraction, such as <c>1e-29</c>,
    /// and an integer beyond 2^53 keep their text, so the backend changes no other value.
    /// </summary>
    private static JsonNode? Integral(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject document:
                foreach (var key in document.Select(entry => entry.Key).ToList())
                {
                    if (Integral(document[key]) is var changed && !ReferenceEquals(changed, document[key]))
                    {
                        document[key] = changed;
                    }
                }

                return document;
            case JsonArray items:
                for (var index = 0; index < items.Count; index++)
                {
                    if (Integral(items[index]) is var changed && !ReferenceEquals(changed, items[index]))
                    {
                        items[index] = changed;
                    }
                }

                return items;
            case JsonValue value when value.GetValueKind() == JsonValueKind.Number:
                var text = value.ToJsonString();
                if (Validator.IsIntegerText(text)
                    || !double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number)
                    || !double.IsFinite(number)
                    || Math.Abs(number) > MaxSafeInteger
                    || number != Math.Floor(number))
                {
                    return value;
                }

                return JsonValue.Create((long)number);
            default:
                return node;
        }
    }

    private static DashboardRpcException Invalid(string[] path, string message) =>
        new(400, "BAD_REQUEST", "Input validation failed", new JsonObject
        {
            ["issues"] = new JsonArray(new JsonObject
            {
                ["code"] = "custom",
                ["path"] = new JsonArray([.. path.Select(segment => (JsonNode?)segment)]),
                ["message"] = message,
            }),
        });

    /// <summary>
    /// The custom issue of the <c>events</c> range that the request schema cannot state: both
    /// endpoints or neither, and an end later than the start. The reference router states the same.
    /// </summary>
    private static (string[] Path, string Message)? EventRangeIssue(JsonObject input)
    {
        var start = input["rangeStart"]?.GetValue<string>();
        var end = input["rangeEnd"]?.GetValue<string>();
        if ((start is null) != (end is null))
        {
            return ([start is null ? "rangeStart" : "rangeEnd"], "rangeStart and rangeEnd must be supplied together");
        }

        return start is not null && end is not null && Instant(start) >= Instant(end)
            ? (["rangeEnd"], "rangeEnd must be later than rangeStart")
            : null;
    }

    /// <summary>
    /// An instant that the request pattern accepted. The pattern allows any number of fractional
    /// digits, and JavaScript keeps three, so the comparison keeps three too.
    /// </summary>
    private static DateTimeOffset Instant(string text)
    {
        var dot = text.IndexOf('.', StringComparison.Ordinal);
        var trimmed = dot < 0 ? text : text[..Math.Min(text.Length - 1, dot + 4)].TrimEnd('.') + "Z";
        return DateTimeOffset.Parse(trimmed, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);
    }

    private static bool TooSmallPage(JsonNode? page)
    {
        if (Validator.Kind(page) != JsonValueKind.Number)
        {
            return false;
        }

        var text = page!.ToJsonString();
        return Validator.IsIntegerText(text) && BigInteger.Parse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture) < 1;
    }

    private static JsonObject TooSmallPageData() => new()
    {
        ["issues"] = new JsonArray(new JsonObject
        {
            ["origin"] = "number",
            ["code"] = "too_small",
            ["minimum"] = 1,
            ["inclusive"] = true,
            ["path"] = new JsonArray("page"),
            ["message"] = "Too small: expected number to be >=1",
        }),
    };

    /// <summary>Whether the request ID is longer than its bound, measured as the client sent it.</summary>
    private static bool OversizedRequestId(JsonObject? input) =>
        input?["audit"] is JsonObject audit
        && audit["requestId"] is JsonValue value
        && value.TryGetValue<string>(out var requestId)
        && Encoding.UTF8.GetByteCount(requestId) > MaxRequestIdBytes;

    /// <summary>At most <see cref="MaxRequestBytes"/> of the request body, or <c>null</c> when it is larger.</summary>
    private static async Task<byte[]?> ReadBodyAsync(HttpRequest request, CancellationToken cancellationToken)
    {
        if (request.ContentLength is > MaxRequestBytes)
        {
            return null;
        }

        var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
        try
        {
            using var body = new MemoryStream();
            while (true)
            {
                var read = await request.Body.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    return body.ToArray();
                }

                if (body.Length + read > MaxRequestBytes)
                {
                    return null;
                }

                body.Write(buffer, 0, read);
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    /// <summary>
    /// Whether the <c>Origin</c> header names the origin of the request URL. It is the CSRF check of
    /// every mutation. A host behind a proxy that ends TLS must apply the forwarded headers
    /// middleware first, so that <see cref="HttpRequest.Scheme"/> is the scheme that the browser used.
    /// </summary>
    private static bool SameOrigin(HttpRequest request)
    {
        var origins = request.Headers.Origin;
        if (origins.Count != 1 || origins[0] is not { Length: > 0 } origin
            || !Uri.TryCreate(origin, UriKind.Absolute, out var parsed)
            || parsed.Host.Length == 0
            || parsed.UserInfo.Length > 0
            || parsed.PathAndQuery is not ("/" or "")
            || parsed.Fragment.Length > 0
            || origin.EndsWith('/'))
        {
            return false;
        }

        if (!Uri.TryCreate($"{request.Scheme}://{request.Headers.Host}", UriKind.Absolute, out var target) || target.Host.Length == 0)
        {
            return false;
        }

        // Uri lowercases the scheme and the host, and gives the default port when the text has none.
        return string.Equals(parsed.Scheme, target.Scheme, StringComparison.Ordinal)
            && string.Equals(parsed.IdnHost, target.IdnHost, StringComparison.Ordinal)
            && parsed.Port == target.Port;
    }

    private Reply Application(string mount, string actor)
    {
        var config = new JsonObject
        {
            ["basePath"] = mount,
            ["rpcUrl"] = mount + "/rpc",
            ["auditActor"] = actor,
            ["workhorseVersion"] = Version(),
            ["authentication"] = null,
            ["demoTools"] = _extensions.ContainsKey("enqueueTest"),
            ["workspaces"] = new JsonArray(),
            ["workspace"] = null,
        };
        var modules = new StringBuilder();
        foreach (var source in _browserModules)
        {
            modules.Append("<script type=\"module\" src=\"").Append(HtmlEncoder.Default.Encode(source)).Append("\"></script>");
        }

        var page = Bundle.Files.TryGetValue("app/index.html", out var bytes)
            ? Encoding.UTF8.GetString(bytes)
            : throw new InvalidOperationException("the dashboard bundle has no app/index.html");
        var html = ReplaceFirst(page, "/*__WORKHORSE_RUNTIME_CONFIG__*/", "window.workhorseDashboard = " + ScriptSafe(config.ToJsonString(ScriptJson)));
        html = ReplaceFirst(html, "<!--__WORKHORSE_BROWSER_MODULES__-->", modules.ToString());
        return new Reply(200, new Dictionary<string, string> { ["Content-Type"] = "text/html; charset=utf-8" }, Encoding.UTF8.GetBytes(html));
    }

    private static string ReplaceFirst(string text, string placeholder, string value)
    {
        var index = text.IndexOf(placeholder, StringComparison.Ordinal);
        return index < 0 ? text : string.Concat(text.AsSpan(0, index), value, text.AsSpan(index + placeholder.Length));
    }

    private static Reply Asset(string name)
    {
        if (name.Split('/').Contains("..") || name.StartsWith('/') || !Bundle.Files.TryGetValue("app/" + name, out var data))
        {
            return Json(404, new JsonObject { ["error"] = "Not Found" });
        }

        var dot = name.LastIndexOf('.');
        var extension = dot > name.LastIndexOf('/') ? name[dot..] : "";
        return new Reply(
            200,
            new Dictionary<string, string>
            {
                ["Content-Type"] = ContentTypes.GetValueOrDefault(extension, "application/octet-stream"),
                ["Cache-Control"] = "public, max-age=31536000, immutable",
                ["X-Content-Type-Options"] = "nosniff",
            },
            data);
    }

    /// <summary>The informational version of this assembly, which is the train version.</summary>
    internal static string Version() =>
        typeof(DashboardHost).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown";

    /// <summary>Escapes the characters that could close the inline script of the runtime configuration.</summary>
    internal static string ScriptSafe(string json)
    {
        var builder = new StringBuilder(json.Length);
        foreach (var character in json)
        {
            builder.Append(character switch
            {
                '<' => "\\u003c",
                '>' => "\\u003e",
                '&' => "\\u0026",
                '\u2028' => "\\u2028",
                '\u2029' => "\\u2029",
                _ => character.ToString(),
            });
        }

        return builder.ToString();
    }

    private static Reply Json(int status, JsonNode value) =>
        new(status, new Dictionary<string, string> { ["Content-Type"] = JsonType }, Encoding.UTF8.GetBytes(value.ToJsonString()));

    private static Reply RpcError(int status, string code, string message, JsonNode? data = null)
    {
        var error = new JsonObject
        {
            ["defined"] = false,
            ["code"] = code,
            ["status"] = status,
            ["message"] = message,
        };
        if (data is not null)
        {
            error["data"] = data;
        }

        return Json(status, new JsonObject { ["json"] = error });
    }

    /// <summary><c>""</c> for the root, otherwise <c>"/"</c> followed by the non-empty segments.</summary>
    internal static string NormalizePath(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        if (path.AsSpan().IndexOfAny("{}*?#") >= 0)
        {
            throw new ArgumentException("the dashboard pattern must be a literal path without route parameters", nameof(path));
        }

        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return segments.Length == 0 ? "" : "/" + string.Join('/', segments);
    }

    /// <summary>Lowercases a <c>host[:port]</c> and drops the default port, so one address has one form.</summary>
    internal static string CanonicalHost(string host, string scheme)
    {
        var lower = host.ToLowerInvariant();
        var port = scheme switch
        {
            "http" => ":80",
            "https" => ":443",
            _ => null,
        };
        if (port is not null && lower.EndsWith(port, StringComparison.Ordinal))
        {
            lower = lower[..^port.Length];
        }

        return $"{scheme}://{lower}";
    }

    private static FrozenSet<string> AllowedHosts(IReadOnlyList<string> entries)
    {
        var allowed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in entries)
        {
            var bare = entry is { Length: > 0 }
                && !entry.Contains('@', StringComparison.Ordinal)
                && Uri.TryCreate("http://" + entry, UriKind.Absolute, out var parsed)
                && parsed.Host.Length > 0
                && parsed.AbsolutePath == "/"
                && parsed.Query.Length == 0
                && parsed.Fragment.Length == 0
                && (string.Equals(entry, parsed.Host, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(entry, $"{parsed.Host}:{parsed.Port.ToString(CultureInfo.InvariantCulture)}", StringComparison.OrdinalIgnoreCase));
            if (!bare)
            {
                throw new ArgumentException($"dashboard allowed host must be a bare host[:port]: \"{entry}\"", nameof(entries));
            }

            allowed.Add(CanonicalHost(entry, "http"));
            allowed.Add(CanonicalHost(entry, "https"));
        }

        return allowed.ToFrozenSet(StringComparer.Ordinal);
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "workhorse dashboard: the authorizer failed")]
    private static partial void LogAuthorizerFailed(ILogger logger, Exception error);

    [LoggerMessage(Level = LogLevel.Error, Message = "workhorse dashboard: schema compatibility check failed")]
    private static partial void LogCompatibilityFailed(ILogger logger, Exception error);

    [LoggerMessage(Level = LogLevel.Error, Message = "workhorse dashboard: procedure {Procedure} failed")]
    private static partial void LogProcedureFailed(ILogger logger, string procedure, Exception error);

    /// <summary>One response: a status, its headers, and its body.</summary>
    private sealed class Reply(int status, IReadOnlyDictionary<string, string> headers, ReadOnlyMemory<byte> body)
    {
        internal async Task SendAsync(HttpContext context)
        {
            var response = context.Response;
            response.StatusCode = status;
            foreach (var (name, value) in headers)
            {
                response.Headers[name] = value;
            }

            // An authorizer's response can state its own length, for example for a HEAD request.
            if (!headers.Keys.Any(name => string.Equals(name, "Content-Length", StringComparison.OrdinalIgnoreCase)))
            {
                response.ContentLength = body.Length;
            }

            if (body.Length > 0 && !HttpMethods.IsHead(context.Request.Method))
            {
                await response.Body.WriteAsync(body, context.RequestAborted).ConfigureAwait(false);
            }
        }
    }
}
