using System.Net;
using System.Net.Sockets;

namespace Workhorse.Tests.Testing;

/// <summary>
/// A TCP proxy in front of PostgreSQL that a test can freeze. A frozen proxy stops forwarding bytes
/// on every open connection, so a statement in flight waits without an error, as on a network that
/// drops packets. New connections then either get no answer, because the proxy stops accepting, or
/// are refused, because the proxy closes its listener.
/// </summary>
internal sealed class FaultProxy : IAsyncDisposable
{
    private readonly string _targetHost;
    private readonly int _targetPort;
    private readonly CancellationTokenSource _closed = new();
    private readonly List<TcpClient> _sockets = [];
    private TcpListener _listener;
    private TaskCompletionSource _thawed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private volatile bool _frozen;
    private Task _accepting;

    internal FaultProxy(string targetHost, int targetPort)
    {
        _targetHost = targetHost;
        _targetPort = targetPort;
        _listener = Listen(0);
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _thawed.SetResult();
        _accepting = AcceptAsync(_listener);
    }

    /// <summary>The loopback port that clients connect to.</summary>
    internal int Port { get; }

    /// <summary>
    /// Stops forwarding on every connection. With <paramref name="refuseConnections"/>, the proxy
    /// closes its listener, so a new connection is refused. Without it, the proxy stops accepting, so
    /// a new connection completes its TCP handshake and then gets no answer.
    /// </summary>
    internal async Task FreezeAsync(bool refuseConnections)
    {
        _thawed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _frozen = true;
        if (refuseConnections)
        {
            _listener.Stop();
            await _accepting.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        }
    }

    /// <summary>Forwards again, and accepts again on the same port.</summary>
    internal void Thaw()
    {
        if (!_listener.Server.IsBound)
        {
            _listener = Listen(Port);
            _accepting = AcceptAsync(_listener);
        }

        _frozen = false;
        _thawed.TrySetResult();
    }

    private static TcpListener Listen(int port)
    {
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        listener.Start(128);
        return listener;
    }

    private async Task AcceptAsync(TcpListener listener)
    {
        try
        {
            while (!_closed.IsCancellationRequested)
            {
                // A frozen proxy that still listens accepts nothing, so the kernel's backlog holds the
                // new connections.
                await _thawed.Task.WaitAsync(_closed.Token);
                var client = await listener.AcceptTcpClientAsync(_closed.Token);
                var server = new TcpClient();
                await server.ConnectAsync(_targetHost, _targetPort, _closed.Token);
                lock (_sockets)
                {
                    _sockets.Add(client);
                    _sockets.Add(server);
                }

                _ = PumpAsync(client.GetStream(), server.GetStream());
                _ = PumpAsync(server.GetStream(), client.GetStream());
            }
        }
        catch (Exception error) when (error is OperationCanceledException or SocketException or ObjectDisposedException or InvalidOperationException)
        {
            // The listener stopped.
        }
    }

    private async Task PumpAsync(NetworkStream from, NetworkStream to)
    {
        var buffer = new byte[16 * 1024];
        try
        {
            while (true)
            {
                var read = await from.ReadAsync(buffer, _closed.Token);
                if (read == 0)
                {
                    break;
                }

                while (_frozen)
                {
                    await _thawed.Task.WaitAsync(_closed.Token);
                }

                await to.WriteAsync(buffer.AsMemory(0, read), _closed.Token);
            }
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException or SocketException)
        {
            // One side closed.
        }
        finally
        {
            try
            {
                to.Socket.Shutdown(SocketShutdown.Send);
            }
            catch (Exception error) when (error is SocketException or ObjectDisposedException)
            {
                // The other side is already gone.
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _closed.CancelAsync();
        _listener.Stop();
        lock (_sockets)
        {
            foreach (var socket in _sockets)
            {
                socket.Dispose();
            }
        }

        await _accepting.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        _closed.Dispose();
    }
}
