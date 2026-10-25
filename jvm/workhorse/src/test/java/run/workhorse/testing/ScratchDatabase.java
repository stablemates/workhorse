package run.workhorse.testing;

import java.io.IOException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Properties;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.extension.BeforeAllCallback;
import org.junit.jupiter.api.extension.BeforeEachCallback;
import org.junit.jupiter.api.extension.ExtensionContext;

/**
 * A per-process scratch PostgreSQL database for the JVM database tests.
 *
 * <p>A database test never uses the checkout's {@code test} database directly. This extension
 * derives a scratch database from {@code DATABASE_URL_TEST}, named after that database plus a
 * per-process digest, and installs {@code sql/schema/current.sql} into it. It drops the database
 * when the test run ends. {@code pnpm db:sweep} recognizes the same name shape if the drop never
 * runs.
 *
 * <p>A session on {@code postgres} holds the lease of the scratch database, of the schema template,
 * and of each extra database, from before its creation until after its drop: a shared advisory lock
 * on {@code hashtextextended(name, 0)}. A test can have no session on one of these databases.
 * {@code pnpm db:sweep} takes the exclusive lock with no wait before it drops a database, and skips
 * a busy one. If the process stops or crashes, PostgreSQL ends the session and its locks, so the
 * sweep can drop the databases again (SM-1689, SM-1702).
 *
 * <p>The scratch database and each extra database set {@code synchronous_commit = off}. Their
 * commits do not wait for the WAL flush. Thus a host I/O stall does not add a flush wait to each
 * commit of a test (SM-1804).
 *
 * <p>All test classes of the process share the scratch database, so {@link #reset} runs before each
 * test. Otherwise a test can see the rows, the {@code maintenance_state} values, and the policy
 * rows that an earlier test left, and its result depends on the order (SM-1732).
 *
 * <p>Without {@code DATABASE_URL_TEST} a local run skips with a visible reason. {@code CI} or
 * {@code WORKHORSE_REQUIRE_DATABASE=1} turns that skip into a failure.
 */
public final class ScratchDatabase implements BeforeAllCallback, BeforeEachCallback {
  private static final List<String> LOOPBACK = List.of("localhost", "127.0.0.1", "::1", "[::1]");
  private static final int DROP_ATTEMPTS = 40;
  private static final String OBJECT_IN_USE = "55006";
  // 55P03 is lock_not_available, the error of an expired lock_timeout.
  private static final String LOCK_NOT_AVAILABLE = "55P03";
  private static final long RESET_LOCK_WAIT_NANOS = 30_000_000_000L;

  // The statements of `reset`. They come from `createDatabaseTestHarness` in
  // `typescript/core/test/support/db.ts`, and the Ruby and .NET test support use the same text. The
  // TypeScript reset keeps the three policy tables. This reset empties them and inserts the rows
  // that POLICY_SNAPSHOT read after the schema install.
  static final String RESET_TABLES =
      """
      SELECT format('%I.%I', namespace.nspname, relation.relname) AS table_name
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'workhorse'
         AND relation.relkind IN ('r', 'p')
         AND relation.relname <> ALL (ARRAY[
           'schema_version', 'schema_migration', 'protocol_version', 'maintenance_state',
           'task_stat_state'
         ])
         AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = relation.oid)
       ORDER BY relation.relname
      """;
  static final String MAINTENANCE_STATE_RESET =
      """
      UPDATE workhorse.maintenance_state SET
        last_started_at = NULL,
        last_completed_at = NULL,
        last_completed_local_date = NULL,
        history_retained_before = CASE WHEN routine_name = 'history_retention'
          THEN date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            - interval '14 days'
          ELSE NULL END,
        terminal_prune_dependency_starved = false,
        terminal_prune_fast_first = false,
        terminal_cleanup_backlog_since = NULL,
        lease_recovery_started_at = NULL,
        updated_at = clock_timestamp()
      """;

  /** The columns of maintenance_state that {@link #MAINTENANCE_STATE_RESET} knows. */
  static final List<String> MAINTENANCE_COLUMNS =
      List.of(
          "history_retained_before",
          "last_completed_at",
          "last_completed_local_date",
          "last_started_at",
          "lease_recovery_started_at",
          "routine_name",
          "terminal_cleanup_backlog_since",
          "terminal_prune_dependency_starved",
          "terminal_prune_fast_first",
          "updated_at");

  static final String POLICY_SNAPSHOT =
      """
      SELECT jsonb_build_object(
        'maintenance_policy', (SELECT to_jsonb(policy) FROM workhorse.maintenance_policy AS policy),
        'queue_health_policy', (SELECT to_jsonb(policy) FROM workhorse.queue_health_policy AS policy),
        'retention_policy', (SELECT to_jsonb(policy) FROM workhorse.retention_policy AS policy)
      )::text
      """;
  private static final String POLICY_RESTORE =
      """
      WITH policies AS (SELECT $1::jsonb AS value),
      maintenance AS (
        INSERT INTO workhorse.maintenance_policy
        SELECT * FROM jsonb_populate_record(
          NULL::workhorse.maintenance_policy, (SELECT value -> 'maintenance_policy' FROM policies)
        )
      ),
      queue_health AS (
        INSERT INTO workhorse.queue_health_policy
        SELECT * FROM jsonb_populate_record(
          NULL::workhorse.queue_health_policy, (SELECT value -> 'queue_health_policy' FROM policies)
        )
      )
      INSERT INTO workhorse.retention_policy
      SELECT * FROM jsonb_populate_record(
        NULL::workhorse.retention_policy, (SELECT value -> 'retention_policy' FROM policies)
      )
      """;
  private static final String LOCK_HOLDERS =
      """
      SELECT pid, state, left(query, 200) AS query FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
      """;

  private static final Object LOCK = new Object();
  private static @Nullable Database database;

  private static final Object TEMPLATE_LOCK = new Object();
  private static @Nullable String template;

  // The session on `postgres` that holds the lease of each database of the process until `drop`
  // ends. The callers serialize its statements on LEASE_LOCK.
  private static final Object LEASE_LOCK = new Object();
  private static @Nullable Connection lease;

  @Override
  public void beforeAll(ExtensionContext context) throws Exception {
    synchronized (LOCK) {
      if (database == null) {
        // The root store closes its values when the whole test run ends. The drop is registered
        // first, so a schema install that fails still drops the database that `create` made.
        context
            .getRoot()
            .getStore(ExtensionContext.Namespace.create(ScratchDatabase.class))
            .put("database", (AutoCloseable) ScratchDatabase::drop);
        database = create();
      }
      Assumptions.assumeTrue(database.url != null, "DATABASE_URL_TEST is unset");
    }
  }

  @Override
  public void beforeEach(ExtensionContext context) throws Exception {
    synchronized (LOCK) {
      if (database == null || database.url == null) {
        return;
      }
    }
    try (Connection connection = connect()) {
      reset(connection);
    }
  }

  /**
   * Returns the scratch database to its install state on {@code connection}, a session of that
   * database.
   *
   * <p>The reset runs in one transaction. It empties every table apart from the version tables and
   * the routine state. It returns each maintenance_state column to its install value. Then it
   * inserts the policy rows that the extension read after the schema install.
   *
   * <p>TRUNCATE locks each table in list order, and a worker statement of an earlier test can lock
   * the same tables in another order. PostgreSQL looks for a deadlock only after {@code
   * deadlock_timeout}, and the lock wait of each attempt ends before that. The reset then rolls
   * back and tries again (SM-1436). If the locks stay held, the error names the sessions.
   */
  static void reset(Connection connection) throws SQLException, InterruptedException {
    String policies;
    synchronized (LOCK) {
      if (database == null || database.policies == null) {
        throw new IllegalStateException("Extend the test class with ScratchDatabase");
      }
      policies = database.policies;
    }
    int lockTimeoutMs;
    List<String> tables = new ArrayList<>();
    try (Statement statement = connection.createStatement()) {
      try (ResultSet result =
          statement.executeQuery(
              "SELECT setting::integer FROM pg_settings WHERE name = 'deadlock_timeout'")) {
        result.next();
        lockTimeoutMs = Math.max(1, Math.min(200, result.getInt(1) / 5));
      }
      try (ResultSet result = statement.executeQuery(RESET_TABLES)) {
        while (result.next()) {
          tables.add(result.getString(1));
        }
      }
    }
    long deadline = System.nanoTime() + RESET_LOCK_WAIT_NANOS;
    boolean autoCommit = connection.getAutoCommit();
    connection.setAutoCommit(false);
    try {
      for (; ; ) {
        try (Statement statement = connection.createStatement();
            // The text is the same in the three SDKs, and pgjdbc binds `?`, not `$1`.
            PreparedStatement restore =
                connection.prepareStatement(POLICY_RESTORE.replace("$1", "?"))) {
          statement.execute("SET LOCAL lock_timeout = " + lockTimeoutMs);
          statement.execute("TRUNCATE " + String.join(", ", tables) + " RESTART IDENTITY CASCADE");
          statement.execute(MAINTENANCE_STATE_RESET);
          restore.setString(1, policies);
          restore.execute();
          connection.commit();
          return;
        } catch (SQLException error) {
          connection.rollback();
          if (!LOCK_NOT_AVAILABLE.equals(error.getSQLState())) {
            throw error;
          }
          if (System.nanoTime() >= deadline) {
            throw new SQLException(
                "The reset could not lock the tables within 30 s. Sessions of the scratch"
                    + " database: "
                    + lockHolders(connection),
                error);
          }
        }
        Thread.sleep(20);
      }
    } finally {
      connection.setAutoCommit(autoCommit);
    }
  }

  private static String lockHolders(Connection connection) throws SQLException {
    StringBuilder holders = new StringBuilder();
    try (Statement statement = connection.createStatement();
        ResultSet result = statement.executeQuery(LOCK_HOLDERS)) {
      while (result.next()) {
        holders
            .append("\n  pid ")
            .append(result.getInt("pid"))
            .append(" ")
            .append(result.getString("state"))
            .append(": ")
            .append(result.getString("query"));
      }
    }
    return holders.toString();
  }

  /** A new connection to the scratch database. The caller closes it. */
  public static Connection connect() throws SQLException {
    synchronized (LOCK) {
      if (database == null || database.url == null) {
        throw new IllegalStateException("Extend the test class with ScratchDatabase");
      }
      return DriverManager.getConnection(database.url, database.credentials);
    }
  }

  /**
   * A second scratch database for a test that counts rows across the whole database, as the shared
   * {@code dashboard/v1} fixture does. The counterpart of Ruby's {@code ScratchDatabase.extra}.
   *
   * <p>The name is {@code <source>_jvm_<digest>} with a digest of the purpose and the process, so
   * {@code pnpm db:sweep} recognizes it if the drop never runs. The caller closes the handle, which
   * drops the database.
   *
   * <p>The database is a copy of a schema template that the first call of the process makes, so the
   * process installs the schema for its extra databases once (SM-1559).
   */
  public static Extra extra(String purpose) throws Exception {
    Database main;
    synchronized (LOCK) {
      main = database;
    }
    if (main == null || main.url == null || main.adminUrl == null) {
      throw new IllegalStateException("Extend the test class with ScratchDatabase");
    }
    String name = extraName(main, "jvm:" + purpose + ":" + ProcessHandle.current().pid());
    Extra extra = new Extra(extraUrl(main, name), main.adminUrl, main.credentials, name);
    synchronized (TEMPLATE_LOCK) {
      String source = template(main);
      hold(name);
      try (Connection admin = DriverManager.getConnection(main.adminUrl, main.credentials)) {
        dropDatabase(admin, name);
        createDatabase(admin, name, " TEMPLATE " + quoteIdentifier(source));
      } catch (SQLException error) {
        release(name);
        throw error;
      }
    }
    report("running against extra scratch database " + name);
    return extra;
  }

  /**
   * The schema template of the extra databases. The first call creates it and installs the schema.
   * No session stays connected to it, because PostgreSQL copies only a template without sessions.
   * The caller holds {@link #TEMPLATE_LOCK}.
   *
   * <p>The lease session takes the lock of the template name before the template exists, and keeps
   * it until {@link #drop}, so {@code pnpm db:sweep} does not drop the template while the process
   * runs.
   */
  private static String template(Database main) throws Exception {
    if (template != null) {
      return template;
    }
    String adminUrl = main.adminUrl;
    if (adminUrl == null) {
      throw new IllegalStateException("Extend the test class with ScratchDatabase");
    }
    String name = extraName(main, "jvm-template:" + ProcessHandle.current().pid());
    hold(name);
    try (Connection admin = DriverManager.getConnection(adminUrl, main.credentials)) {
      dropDatabase(admin, name);
      try (Statement statement = admin.createStatement()) {
        statement.execute("CREATE DATABASE " + quoteIdentifier(name));
      }
      try (Connection connection =
              DriverManager.getConnection(extraUrl(main, name), main.credentials);
          Statement statement = connection.createStatement()) {
        statement.execute(Files.readString(schema()));
      } catch (Exception error) {
        dropDatabase(admin, name);
        throw error;
      }
    } catch (Exception error) {
      release(name);
      throw error;
    }
    template = name;
    report("installed the schema into template database " + name);
    return name;
  }

  /** The name of the schema template, or {@code null} before the first {@link #extra} call. */
  static @Nullable String templateName() {
    synchronized (TEMPLATE_LOCK) {
      return template;
    }
  }

  /** A new connection to the {@code postgres} database of the server. The caller closes it. */
  static Connection connectAdmin() throws SQLException {
    synchronized (LOCK) {
      if (database == null || database.adminUrl == null) {
        throw new IllegalStateException("Extend the test class with ScratchDatabase");
      }
      return DriverManager.getConnection(database.adminUrl, database.credentials);
    }
  }

  /** {@code <source>_jvm_<digest>} for an extra database or the template, from {@code seed}. */
  private static String extraName(Database main, String seed) throws NoSuchAlgorithmException {
    String source = main.name.substring(0, main.name.lastIndexOf("_jvm_"));
    byte[] hash =
        MessageDigest.getInstance("SHA-256").digest(seed.getBytes(StandardCharsets.UTF_8));
    return source.substring(0, Math.min(source.length(), 43))
        + "_jvm_"
        + HexFormat.of().formatHex(hash).substring(0, 10);
  }

  private static String extraUrl(Database main, String name) {
    if (main.url == null) {
      throw new IllegalStateException("Extend the test class with ScratchDatabase");
    }
    return main.url.replaceFirst("/" + main.name + "(?=\\?|$)", "/" + name);
  }

  /** An extra scratch database. {@link #close} drops it. */
  public static final class Extra implements AutoCloseable {
    private final String url;
    private final String adminUrl;
    private final Properties credentials;
    private final String name;

    private Extra(String url, String adminUrl, Properties credentials, String name) {
      this.url = url;
      this.adminUrl = adminUrl;
      this.credentials = credentials;
      this.name = name;
    }

    /** The database name. */
    public String name() {
      return name;
    }

    /** A new connection to the extra database. The caller closes it. */
    public Connection connect() throws SQLException {
      return DriverManager.getConnection(url, credentials);
    }

    @Override
    public void close() throws SQLException {
      try (Connection admin = DriverManager.getConnection(adminUrl, credentials)) {
        dropDatabase(admin, name);
        report("dropped extra scratch database " + name);
      }
      // After a failed drop the lock stays until the process ends, and then the sweep can drop it.
      release(name);
    }
  }

  private static Database create() throws Exception {
    String source = System.getenv().getOrDefault("DATABASE_URL_TEST", "");
    if (source.isEmpty()) {
      if (required()) {
        throw new IllegalStateException(
            "DATABASE_URL_TEST is unset, but this run requires PostgreSQL"
                + " (CI or WORKHORSE_REQUIRE_DATABASE=1)");
      }
      report("SKIPPED database tests: DATABASE_URL_TEST is unset");
      return new Database(null, null, new Properties(), "", null);
    }

    URI uri = URI.create(source);
    String host = uri.getHost() == null ? "localhost" : uri.getHost();
    if (!LOOPBACK.contains(host)) {
      throw new IllegalStateException("JVM database tests refuse a non-loopback database: " + host);
    }
    String sourceName = uri.getPath().replaceFirst("^/", "");
    if (!sourceName.contains("test")) {
      throw new IllegalStateException("DATABASE_URL_TEST must name a test database");
    }
    Properties credentials = new Properties();
    String userInfo = uri.getRawUserInfo();
    if (userInfo != null) {
      String[] parts = userInfo.split(":", 2);
      credentials.setProperty("user", URLDecoder.decode(parts[0], StandardCharsets.UTF_8));
      if (parts.length > 1) {
        credentials.setProperty("password", URLDecoder.decode(parts[1], StandardCharsets.UTF_8));
      }
    }
    String base =
        "jdbc:postgresql://"
            + (host.contains(":") && !host.startsWith("[") ? "[" + host + "]" : host)
            + (uri.getPort() < 0 ? "" : ":" + uri.getPort())
            + "/";
    String query = uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery();
    String name = scratchName(sourceName);

    Database created =
        new Database(base + name + query, base + "postgres" + query, credentials, name, null);
    // Owned before it exists, so a failed schema install still drops the database.
    database = created;
    synchronized (LEASE_LOCK) {
      lease = DriverManager.getConnection(created.adminUrl, credentials);
    }
    hold(name);
    try (Connection admin = DriverManager.getConnection(created.adminUrl, credentials)) {
      dropDatabase(admin, name);
      createDatabase(admin, name, "");
    }
    String policies;
    try (Connection connection = DriverManager.getConnection(created.url, credentials);
        Statement statement = connection.createStatement()) {
      statement.execute(Files.readString(schema()));
      try (ResultSet result = statement.executeQuery(POLICY_SNAPSHOT)) {
        result.next();
        policies = result.getString(1);
      }
    }
    report("running against scratch database " + name);
    return new Database(created.url, created.adminUrl, credentials, name, policies);
  }

  private static void drop() throws SQLException {
    Database current;
    synchronized (LOCK) {
      current = database;
    }
    String copied;
    synchronized (TEMPLATE_LOCK) {
      copied = template;
      template = null;
    }
    Connection held;
    synchronized (LEASE_LOCK) {
      held = lease;
      lease = null;
    }
    if (current == null || current.adminUrl == null) {
      return;
    }
    // Each drop runs even if the other fails, and the first failure is thrown.
    SQLException failure = dropAndReport(current, current.name, null);
    if (copied != null) {
      failure = dropAndReport(current, copied, failure);
    }
    // The lease ends after the drops. If a drop failed, the sweep can drop that database.
    if (held != null) {
      try {
        held.close();
      } catch (SQLException error) {
        if (failure == null) {
          failure = error;
        } else {
          failure.addSuppressed(error);
        }
      }
    }
    if (failure != null) {
      throw failure;
    }
  }

  private static @Nullable SQLException dropAndReport(
      Database current, String name, @Nullable SQLException earlier) {
    String adminUrl = current.adminUrl;
    if (adminUrl == null) {
      return earlier;
    }
    try (Connection admin = DriverManager.getConnection(adminUrl, current.credentials)) {
      dropDatabase(admin, name);
      report("dropped scratch database " + name);
      return earlier;
    } catch (SQLException error) {
      report(
          "could not drop scratch database "
              + name
              + ": "
              + error.getMessage()
              + "; run pnpm db:sweep");
      if (earlier != null) {
        earlier.addSuppressed(error);
        return earlier;
      }
      return error;
    }
  }

  /** Takes the lease of {@code name} on the lease session. */
  private static void hold(String name) throws SQLException {
    onLease("SELECT pg_advisory_lock_shared(hashtextextended(?, 0))", name, true);
  }

  /** Gives back the lease of {@code name} after its drop. After {@link #drop} it does nothing. */
  private static void release(String name) throws SQLException {
    onLease("SELECT pg_advisory_unlock_shared(hashtextextended(?, 0))", name, false);
  }

  private static void onLease(String sql, String name, boolean required) throws SQLException {
    synchronized (LEASE_LOCK) {
      Connection session = lease;
      if (session == null) {
        if (required) {
          throw new IllegalStateException("Extend the test class with ScratchDatabase");
        }
        return;
      }
      try (PreparedStatement statement = session.prepareStatement(sql)) {
        statement.setString(1, name);
        statement.execute();
      }
    }
  }

  /**
   * Creates {@code name} with the clause {@code options}, for example a {@code TEMPLATE} clause.
   *
   * <p>A scratch database is for tests only, so its commits do not wait for the WAL flush. A host
   * I/O stall can make one flush take seconds, and a lease of a few seconds then lapses although
   * the worker is correct. Visibility and order do not change. Only a server crash can lose such a
   * commit, and no JVM test restarts PostgreSQL or reads the WAL. A copy of a template does not
   * take this setting from the template, so each database sets it.
   */
  private static void createDatabase(Connection admin, String name, String options)
      throws SQLException {
    try (Statement statement = admin.createStatement()) {
      statement.execute("CREATE DATABASE " + quoteIdentifier(name) + options);
      statement.execute(
          "ALTER DATABASE " + quoteIdentifier(name) + " SET synchronous_commit = off");
    }
  }

  /**
   * Drops {@code name}, and waits while short-lived sessions that the test role does not own end.
   * {@code WITH (FORCE)} signals every connected role, which the local test role cannot do.
   */
  private static void dropDatabase(Connection admin, String name) throws SQLException {
    for (int attempt = 1; ; attempt++) {
      try (PreparedStatement terminate =
              admin.prepareStatement(
                  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity"
                      + " WHERE datname = ? AND usename = current_user"
                      + " AND pid <> pg_backend_pid()");
          Statement statement = admin.createStatement()) {
        terminate.setString(1, name);
        terminate.execute();
        statement.execute("DROP DATABASE IF EXISTS " + quoteIdentifier(name));
        return;
      } catch (SQLException error) {
        if (!OBJECT_IN_USE.equals(error.getSQLState()) || attempt >= DROP_ATTEMPTS) {
          throw error;
        }
        try {
          Thread.sleep(25);
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          throw error;
        }
      }
    }
  }

  /** {@code <source>_jvm_<digest>}, the scratch shape that {@code pnpm db:sweep} recognizes. */
  private static String scratchName(String source) throws NoSuchAlgorithmException {
    byte[] hash =
        MessageDigest.getInstance("SHA-256")
            .digest(("jvm:" + ProcessHandle.current().pid()).getBytes(StandardCharsets.UTF_8));
    String digest = HexFormat.of().formatHex(hash).substring(0, 10);
    return source.substring(0, Math.min(source.length(), 43)) + "_jvm_" + digest;
  }

  private static Path schema() throws IOException {
    String schema = System.getProperty("workhorse.schema");
    if (schema == null) {
      throw new IOException("The build sets the workhorse.schema system property");
    }
    return Path.of(schema);
  }

  private static String quoteIdentifier(String name) {
    return "\"" + name.replace("\"", "\"\"") + "\"";
  }

  private static boolean required() {
    for (String key : List.of("CI", "WORKHORSE_REQUIRE_DATABASE")) {
      String value = System.getenv().getOrDefault(key, "");
      if (!List.of("", "0", "false").contains(value)) {
        return true;
      }
    }
    return false;
  }

  private static void report(String message) {
    System.err.println("[workhorse jvm db] " + message);
  }

  /** The scratch database, with the policy rows that the reset inserts again. */
  private record Database(
      @Nullable String url,
      @Nullable String adminUrl,
      Properties credentials,
      String name,
      @Nullable String policies) {}
}
