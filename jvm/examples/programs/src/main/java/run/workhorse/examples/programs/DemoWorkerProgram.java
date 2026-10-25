package run.workhorse.examples.programs;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.net.SocketAddress;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.net.UnixDomainSocketAddress;
import java.net.UnknownHostException;
import java.nio.ByteBuffer;
import java.nio.channels.ClosedChannelException;
import java.nio.channels.ClosedSelectorException;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.SocketFactory;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.postgresql.ds.PGSimpleDataSource;
import run.workhorse.CompatibilityException;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.Worker;
import run.workhorse.WorkerProcess;

/**
 * Serves the JVM queues of the dashboard demo, plus the queue every demo language shares. It is the
 * JVM counterpart of {@code ruby/examples/demo_worker.rb}.
 *
 * <p>Both demo launchers start this worker. The program reads {@code DATABASE_URL_PRIMARY} as a
 * {@code postgres://} URL, as the other demo workers do, or as a PgJDBC URL.
 *
 * <p>Documentation: https://workhorse.run/docs/dashboard
 */
public final class DemoWorkerProgram {
  /** The task type of each language's own demo queue. */
  public static final String LANGUAGE_TASK_TYPE = "demo.language-worker";

  /** The task type of the queue that every demo language serves. */
  public static final String SHARED_TASK_TYPE = "demo.shared-worker";

  /** The full-tier JVM queue. */
  public static final String JVM_QUEUE = "demo-jvm";

  /** The fast-tier JVM queue. */
  public static final String JVM_FAST_QUEUE = "demo-jvm-fast";

  /** The queue that every demo language serves. */
  public static final String SHARED_QUEUE = "demo-shared";

  static final String SCHEDULE_NAMESPACE = "workhorse-demo";
  static final String FAST_TIER_SCHEDULE_NAMESPACE = "workhorse-demo-fast-tier";
  static final int WORKER_CONCURRENCY = 3;
  static final long DEFAULT_POLL_MS = 15_000;
  static final Duration SCHEMA_RETRY = Duration.ofMillis(500);
  static final int DEFAULT_PORT = 5432;

  /** The start of a URL with an empty host, such as {@code postgresql://app@/demo}. */
  private static final Pattern EMPTY_HOST =
      Pattern.compile("postgres(?:ql)?://(?:[^/?#@]*@)?(?=[/?#]|$)");

  private static final SecureRandom RANDOM = new SecureRandom();

  private DemoWorkerProgram() {}

  /** Reads {@code DATABASE_URL_PRIMARY}. */
  static String databaseUrl(Map<String, String> environment) {
    String value = environment.get("DATABASE_URL_PRIMARY");
    if (value == null || value.isEmpty()) {
      throw new IllegalArgumentException("DATABASE_URL_PRIMARY is required");
    }
    return value;
  }

  /**
   * Builds the data source for {@code url}. A {@code jdbc:} URL goes to PgJDBC as it is. PgJDBC
   * reads no {@code postgres://} URL, so the program maps its parts to the data source. Each value
   * uses percent decoding only, as libpq decodes it, so a {@code +} stays a {@code +}.
   *
   * <p>As in libpq, a {@code host} parameter replaces the host of the URL, and a host that starts
   * with {@code /} is the directory of the server's Unix socket. PgJDBC connects over TCP only, so
   * the data source then opens that socket through {@link UnixSocketFactory}.
   *
   * @throws IllegalArgumentException if the URL is not a PostgreSQL URL, has no host and no {@code
   *     host} parameter, or names a parameter the program does not map
   */
  static PGSimpleDataSource dataSource(String url) {
    PGSimpleDataSource dataSource = new PGSimpleDataSource();
    if (url.startsWith("jdbc:")) {
      dataSource.setURL(url);
      return dataSource;
    }
    // libpq reads an empty host with a host parameter as a Unix socket URL, but URI then reads the
    // authority as a registry name and drops the credentials. A placeholder host lets URI parse
    // it, and the host parameter must replace it.
    Matcher emptyHost = EMPTY_HOST.matcher(url);
    boolean placeholder = emptyHost.lookingAt();
    String parsed =
        placeholder
            ? url.substring(0, emptyHost.end()) + "localhost" + url.substring(emptyHost.end())
            : url;
    URI uri;
    try {
      uri = new URI(parsed);
    } catch (URISyntaxException error) {
      throw new IllegalArgumentException("DATABASE_URL_PRIMARY is not a valid URL", error);
    }
    String scheme = uri.getScheme();
    if (!"postgres".equals(scheme) && !"postgresql".equals(scheme)) {
      throw new IllegalArgumentException(
          "DATABASE_URL_PRIMARY must be a jdbc:, postgres://, or postgresql:// URL");
    }
    String host = uri.getHost();
    if (host == null || host.isEmpty()) {
      throw new IllegalArgumentException("DATABASE_URL_PRIMARY must name a host");
    }
    int port = uri.getPort() >= 0 ? uri.getPort() : DEFAULT_PORT;
    boolean hostParameter = false;
    boolean sslMode = false;
    String path = uri.getRawPath();
    if (path != null && path.length() > 1) {
      dataSource.setDatabaseName(decode(path.substring(1)));
    }
    String userInfo = uri.getRawUserInfo();
    if (userInfo != null) {
      int colon = userInfo.indexOf(':');
      dataSource.setUser(decode(colon < 0 ? userInfo : userInfo.substring(0, colon)));
      if (colon >= 0) {
        dataSource.setPassword(decode(userInfo.substring(colon + 1)));
      }
    }
    String query = uri.getRawQuery();
    if (query != null) {
      for (String pair : query.split("&", -1)) {
        if (pair.isEmpty()) {
          continue;
        }
        int equals = pair.indexOf('=');
        String name = decode(equals < 0 ? pair : pair.substring(0, equals));
        String value = equals < 0 ? "" : decode(pair.substring(equals + 1));
        switch (name) {
          case "host" -> {
            host = value;
            hostParameter = true;
          }
          case "port" -> port = Integer.parseInt(value, 10);
          case "sslmode" -> {
            dataSource.setSslMode(value);
            sslMode = true;
          }
          case "application_name" -> dataSource.setApplicationName(value);
          case "connect_timeout" -> dataSource.setConnectTimeout(Integer.parseInt(value, 10));
          case "options" -> dataSource.setOptions(value);
          default ->
              throw new IllegalArgumentException(
                  "DATABASE_URL_PRIMARY names the parameter "
                      + name
                      + ", which the JVM demo worker does not map");
        }
      }
    }
    if (placeholder && !hostParameter) {
      throw new IllegalArgumentException(
          "DATABASE_URL_PRIMARY without a host must name the socket directory in its host"
              + " parameter");
    }
    dataSource.setPortNumbers(new int[] {port});
    if (host.startsWith("/")) {
      // PgJDBC still needs a server name, but the socket factory ignores the address.
      dataSource.setServerNames(new String[] {"localhost"});
      dataSource.setSocketFactory(UnixSocketFactory.class.getName());
      dataSource.setSocketFactoryArg(Path.of(host, ".s.PGSQL." + port).toString());
      // libpq uses no TLS over a Unix socket.
      if (!sslMode) {
        dataSource.setSslMode("disable");
      }
    } else {
      dataSource.setServerNames(new String[] {host});
    }
    return dataSource;
  }

  private static String decode(String value) {
    return URLDecoder.decode(value.replace("+", "%2B"), StandardCharsets.UTF_8);
  }

  /**
   * Reads {@code WORKHORSE_WORKER_POLL_MS} in milliseconds. Zero leaves the SDK default in place,
   * so the result is empty.
   */
  static Optional<Duration> pollInterval(Map<String, String> environment) {
    String value = environment.get("WORKHORSE_WORKER_POLL_MS");
    long milliseconds;
    if (value == null || value.isEmpty()) {
      milliseconds = DEFAULT_POLL_MS;
    } else {
      try {
        milliseconds = Long.parseLong(value, 10);
      } catch (NumberFormatException error) {
        milliseconds = -1;
      }
    }
    if (milliseconds < 0) {
      throw new IllegalArgumentException("WORKHORSE_WORKER_POLL_MS must be a non-negative integer");
    }
    return milliseconds == 0 ? Optional.empty() : Optional.of(Duration.ofMillis(milliseconds));
  }

  /** Only the development demo waits for a missing schema; production refuses at once. */
  static boolean waitsForSchema(Map<String, String> environment) {
    String mode = environment.get("WORKHORSE_DEMO_MODE");
    if (mode == null || mode.isEmpty()) {
      mode = "production";
    }
    if (!mode.equals("development") && !mode.equals("production")) {
      throw new IllegalArgumentException(
          "WORKHORSE_DEMO_MODE must be either development or production");
    }
    return mode.equals("development");
  }

  /**
   * Waits while the demo server has not installed the schema yet.
   *
   * <p>In development the server installs the schema on first start, so a worker that starts beside
   * it can see an empty database. Every other compatibility refusal fails at once. Each check
   * builds a new queue, so no earlier refusal is reused.
   */
  static void waitForSchema(DataSource dataSource, Duration retry) throws InterruptedException {
    boolean logged = false;
    while (true) {
      try {
        new Queue(ConnectionSource.of(dataSource)).assertCompatible();
        return;
      } catch (CompatibilityException error) {
        if (error.code() != CompatibilityException.Code.SCHEMA_NOT_INSTALLED) {
          throw error;
        }
        if (!logged) {
          System.out.println("Waiting for the demo server to install the Workhorse schema");
          System.out.flush();
          logged = true;
        }
        Thread.sleep(retry.toMillis());
      }
    }
  }

  /** The result of a task on the JVM queue. A task for another language fails. */
  static Map<String, Object> languageTask(@Nullable Map<?, ?> payload, int attempt) {
    if (payload == null || !"jvm".equals(payload.get("language"))) {
      throw new IllegalArgumentException("JVM worker received a task for another language");
    }
    return Map.of("language", "jvm", "runtime", "jvm", "attempt", attempt);
  }

  /** The result of a task on the shared queue. A task without a source fails. */
  static Map<String, Object> sharedTask(@Nullable Map<?, ?> payload, int attempt) {
    if (payload == null || !(payload.get("source") instanceof String source)) {
      throw new IllegalArgumentException("Shared worker requires a source");
    }
    return Map.of("source", source, "runtime", "jvm", "attempt", attempt);
  }

  /** A worker id that names the runtime and the host, and is unique for each process. */
  static String workerId() {
    String hostname;
    try {
      hostname = InetAddress.getLocalHost().getHostName().replaceAll("[^A-Za-z0-9._-]", "-");
    } catch (UnknownHostException error) {
      hostname = "";
    }
    if (hostname.isEmpty()) {
      hostname = "unknown-host";
    }
    byte[] suffix = new byte[4];
    RANDOM.nextBytes(suffix);
    return "demo-jvm-"
        + hostname
        + "-"
        + ProcessHandle.current().pid()
        + "-"
        + HexFormat.of().formatHex(suffix);
  }

  /** Builds the worker that serves the JVM queue, the fast-tier JVM queue, and the shared queue. */
  static Worker buildWorker(
      DataSource dataSource, Optional<Duration> pollInterval, String workerId) {
    Worker.Builder builder =
        Worker.builder(dataSource)
            .queues(JVM_QUEUE, SHARED_QUEUE, JVM_FAST_QUEUE)
            .workerId(workerId)
            .concurrency(WORKER_CONCURRENCY)
            .scheduleNamespaces(SCHEDULE_NAMESPACE, FAST_TIER_SCHEDULE_NAMESPACE)
            .maintenanceInterval(Duration.ofSeconds(1))
            .registryInterval(Duration.ofMillis(250))
            .shutdownGrace(Duration.ofSeconds(25));
    pollInterval.ifPresent(builder::pollInterval);
    return builder
        .handle(
            LANGUAGE_TASK_TYPE,
            Map.class,
            (context, payload) -> languageTask(payload, context.task().attempt()))
        .handle(
            SHARED_TASK_TYPE,
            Map.class,
            (context, payload) -> sharedTask(payload, context.task().attempt()))
        .build();
  }

  public static void main(String[] arguments) throws InterruptedException {
    Map<String, String> environment = System.getenv();
    Optional<Duration> poll = pollInterval(environment);
    boolean waits = waitsForSchema(environment);
    PGSimpleDataSource dataSource = dataSource(databaseUrl(environment));
    if (waits) {
      waitForSchema(dataSource, SCHEMA_RETRY);
    }
    WorkerProcess.runWorkerProcess(buildWorker(dataSource, poll, workerId()));
  }

  /**
   * Opens the Unix socket of a PostgreSQL server for PgJDBC, which connects over TCP only. PgJDBC
   * creates the factory with its {@code socketFactoryArg} property, the path of the socket.
   */
  public static final class UnixSocketFactory extends SocketFactory {
    private final Path path;

    public UnixSocketFactory(String path) {
      this.path = Path.of(path);
    }

    @Override
    public Socket createSocket() {
      return new UnixSocket(path);
    }

    @Override
    public Socket createSocket(String host, int port) throws IOException {
      return connected();
    }

    @Override
    public Socket createSocket(String host, int port, InetAddress localHost, int localPort)
        throws IOException {
      return connected();
    }

    @Override
    public Socket createSocket(InetAddress host, int port) throws IOException {
      return connected();
    }

    @Override
    public Socket createSocket(
        InetAddress address, int port, InetAddress localAddress, int localPort) throws IOException {
      return connected();
    }

    private Socket connected() throws IOException {
      Socket socket = createSocket();
      socket.connect(null);
      return socket;
    }
  }

  /**
   * A {@link Socket} over a Unix domain socket channel. PgJDBC sets a read timeout when it waits
   * for a notification or bounds a statement, so each read waits on a selector for at most {@link
   * #getSoTimeout}. A Unix socket has no TCP options, so the socket ignores them.
   */
  static final class UnixSocket extends Socket {
    private record Open(SocketChannel channel, Selector readable, Selector writable) {}

    private final Path path;
    private final Object readLock = new Object();
    private final Object writeLock = new Object();
    private volatile @Nullable Open open;
    private volatile boolean closed;
    private volatile int timeout;

    UnixSocket(Path path) {
      this.path = path;
    }

    @Override
    public void connect(@Nullable SocketAddress address) throws IOException {
      connect(address, 0);
    }

    /**
     * Connects to the socket path. The address does not apply, and a local connect needs no
     * timeout.
     */
    @Override
    public synchronized void connect(@Nullable SocketAddress address, int connectTimeout)
        throws IOException {
      if (closed) {
        throw new SocketException("Socket is closed");
      }
      if (open != null) {
        throw new SocketException("Socket is already connected");
      }
      SocketChannel channel = SocketChannel.open(UnixDomainSocketAddress.of(path));
      Selector readable = null;
      Selector writable = null;
      try {
        channel.configureBlocking(false);
        readable = Selector.open();
        channel.register(readable, SelectionKey.OP_READ);
        writable = Selector.open();
        channel.register(writable, SelectionKey.OP_WRITE);
      } catch (IOException error) {
        for (Closeable resource : new Closeable[] {writable, readable, channel}) {
          if (resource != null) {
            resource.close();
          }
        }
        throw error;
      }
      open = new Open(channel, readable, writable);
    }

    @Override
    public boolean isConnected() {
      return open != null;
    }

    @Override
    public boolean isBound() {
      return open != null;
    }

    @Override
    public boolean isClosed() {
      return closed;
    }

    @Override
    public void setSoTimeout(int timeout) throws SocketException {
      if (timeout < 0) {
        throw new IllegalArgumentException("timeout must not be negative");
      }
      this.timeout = timeout;
    }

    @Override
    public int getSoTimeout() {
      return timeout;
    }

    @Override
    public void setTcpNoDelay(boolean on) {}

    @Override
    public boolean getTcpNoDelay() {
      return false;
    }

    @Override
    public void setKeepAlive(boolean on) {}

    @Override
    public boolean getKeepAlive() {
      return false;
    }

    @Override
    public void setReceiveBufferSize(int size) {}

    @Override
    public void setSendBufferSize(int size) {}

    @Override
    public void setSoLinger(boolean on, int linger) {}

    @Override
    public InputStream getInputStream() throws IOException {
      Open connection = connection();
      return new InputStream() {
        @Override
        public int read() throws IOException {
          byte[] one = new byte[1];
          return read(one, 0, 1) < 0 ? -1 : one[0] & 0xff;
        }

        @Override
        public int read(byte[] bytes, int offset, int length) throws IOException {
          Objects.checkFromIndexSize(offset, length, bytes.length);
          if (length == 0) {
            return 0;
          }
          ByteBuffer buffer = ByteBuffer.wrap(bytes, offset, length);
          int wait = timeout;
          long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(wait);
          synchronized (readLock) {
            try {
              while (true) {
                int read = connection.channel().read(buffer);
                if (read != 0) {
                  return read;
                }
                long remaining = 0;
                if (wait > 0) {
                  remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
                  if (remaining <= 0) {
                    throw new SocketTimeoutException("Read timed out");
                  }
                }
                // A select with no timeout waits until the channel is readable.
                connection.readable().select(remaining);
                connection.readable().selectedKeys().clear();
                if (closed) {
                  throw new SocketException("Socket is closed");
                }
              }
            } catch (ClosedChannelException | ClosedSelectorException error) {
              throw new SocketException("Socket is closed", error);
            }
          }
        }

        @Override
        public void close() throws IOException {
          UnixSocket.this.close();
        }
      };
    }

    @Override
    public OutputStream getOutputStream() throws IOException {
      Open connection = connection();
      return new OutputStream() {
        @Override
        public void write(int value) throws IOException {
          write(new byte[] {(byte) value}, 0, 1);
        }

        @Override
        public void write(byte[] bytes, int offset, int length) throws IOException {
          Objects.checkFromIndexSize(offset, length, bytes.length);
          ByteBuffer buffer = ByteBuffer.wrap(bytes, offset, length);
          synchronized (writeLock) {
            try {
              while (buffer.hasRemaining()) {
                if (connection.channel().write(buffer) == 0) {
                  connection.writable().select();
                  connection.writable().selectedKeys().clear();
                  if (closed) {
                    throw new SocketException("Socket is closed");
                  }
                }
              }
            } catch (ClosedChannelException | ClosedSelectorException error) {
              throw new SocketException("Socket is closed", error);
            }
          }
        }

        @Override
        public void close() throws IOException {
          UnixSocket.this.close();
        }
      };
    }

    /** Closes the channel and wakes a read or a write that waits on it. */
    @Override
    public void close() throws IOException {
      Open connection;
      synchronized (this) {
        if (closed) {
          return;
        }
        closed = true;
        connection = open;
      }
      if (connection != null) {
        connection.readable().wakeup();
        connection.writable().wakeup();
        try {
          connection.channel().close();
        } finally {
          connection.readable().close();
          connection.writable().close();
        }
      }
    }

    private Open connection() throws SocketException {
      Open connection = open;
      if (closed) {
        throw new SocketException("Socket is closed");
      }
      if (connection == null) {
        throw new SocketException("Socket is not connected");
      }
      return connection;
    }
  }
}
