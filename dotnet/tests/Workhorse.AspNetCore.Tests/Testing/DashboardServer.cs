using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Workhorse.AspNetCore.Tests.Testing;

/// <summary>One HTTP response: the status, the headers, and the body as text.</summary>
internal sealed record DashboardResponse(int Status, IReadOnlyDictionary<string, string> Headers, string Text)
{
    /// <summary>The value of one header, or an empty string.</summary>
    internal string Header(string name) => Headers.TryGetValue(name, out var value) ? value : "";
}

/// <summary>
/// A Kestrel server on a loopback port that maps the dashboard and one host endpoint, which answers
/// <c>host</c> for every path outside the dashboard.
/// </summary>
internal sealed class DashboardServer : IAsyncDisposable
{
    private readonly WebApplication _app;
    private readonly HttpClient _client;

    private DashboardServer(WebApplication app, Uri address, LogCapture logs)
    {
        _app = app;
        Address = address;
        Logs = logs;
        _client = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false }) { BaseAddress = address };
    }

    /// <summary>The address of the listener, such as <c>http://127.0.0.1:5123/</c>.</summary>
    internal Uri Address { get; }

    /// <summary>Each log record of the server.</summary>
    internal LogCapture Logs { get; }

    /// <summary>The <c>host:port</c> of the listener.</summary>
    internal string Authority => Address.Authority;

    /// <summary>Starts a server whose dashboard <paramref name="map"/> maps, under <paramref name="pathBase"/>, with extra <paramref name="services"/>.</summary>
    internal static async Task<DashboardServer> StartAsync(
        Action<WebApplication> map, string? pathBase = null, Action<IServiceCollection>? services = null)
    {
        var builder = WebApplication.CreateSlimBuilder();
        services?.Invoke(builder.Services);
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
        var logs = new LogCapture();
        builder.Logging.ClearProviders();
        builder.Logging.AddProvider(logs);
        var app = builder.Build();
        if (pathBase is not null)
        {
            app.UsePathBase(pathBase);
        }

        app.UseRouting();
        map(app);
        app.MapFallback(() => "host");
        await app.StartAsync().ConfigureAwait(false);
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        return new DashboardServer(app, new Uri(address + "/"), logs);
    }

    /// <summary>A GET request.</summary>
    internal Task<DashboardResponse> GetAsync(string path) => RequestAsync("GET", path, new Dictionary<string, string>(), null);

    /// <summary>A same-origin JSON POST request.</summary>
    internal Task<DashboardResponse> PostAsync(string path, string body) =>
        RequestAsync("POST", path, new Dictionary<string, string> { ["Origin"] = $"http://{Authority}" }, Encoding.UTF8.GetBytes(body));

    /// <summary>A request with exact headers. A <c>Host</c> header replaces the listener's.</summary>
    internal async Task<DashboardResponse> RequestAsync(string method, string path, IReadOnlyDictionary<string, string> headers, byte[]? body)
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), path.TrimStart('/'));
        if (body is not null)
        {
            request.Content = new ByteArrayContent(body);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        }

        foreach (var (name, value) in headers)
        {
            if (string.Equals(name, "Host", StringComparison.OrdinalIgnoreCase))
            {
                request.Headers.Host = value;
            }
            else if (string.Equals(name, "Content-Type", StringComparison.OrdinalIgnoreCase))
            {
                if (request.Content is not null)
                {
                    request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(value);
                }
            }
            else
            {
                request.Headers.TryAddWithoutValidation(name, value);
            }
        }

        using var response = await _client.SendAsync(request).ConfigureAwait(false);
        var received = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, values) in response.Headers.Concat(response.Content.Headers))
        {
            received[name] = string.Join(", ", values);
        }

        var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        return new DashboardResponse((int)response.StatusCode, received, text);
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _app.DisposeAsync().ConfigureAwait(false);
    }
}

/// <summary>Keeps each log record, with its exception.</summary>
internal sealed class LogCapture : ILoggerProvider
{
    private readonly ConcurrentQueue<(string Message, Exception? Error)> _records = new();

    /// <summary>The records so far.</summary>
    internal IReadOnlyList<(string Message, Exception? Error)> Records => [.. _records];

    public ILogger CreateLogger(string categoryName) => new Logger(_records);

    public void Dispose()
    {
    }

    private sealed class Logger(ConcurrentQueue<(string Message, Exception? Error)> records) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Warning;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (IsEnabled(logLevel))
            {
                records.Enqueue((formatter(state, exception), exception));
            }
        }
    }
}
