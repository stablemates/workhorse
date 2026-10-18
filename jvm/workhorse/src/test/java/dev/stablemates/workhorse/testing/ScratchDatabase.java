package dev.stablemates.workhorse.testing;

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
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HexFormat;
import java.util.List;
import java.util.Properties;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.extension.BeforeAllCallback;
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
 * <p>Without {@code DATABASE_URL_TEST} a local run skips with a visible reason. {@code CI} or
 * {@code WORKHORSE_REQUIRE_DATABASE=1} turns that skip into a failure.
 */
public final class ScratchDatabase implements BeforeAllCallback {
  private static final List<String> LOOPBACK = List.of("localhost", "127.0.0.1", "::1", "[::1]");
  private static final int DROP_ATTEMPTS = 40;
  private static final String OBJECT_IN_USE = "55006";

  private static final Object LOCK = new Object();
  private static @Nullable Database database;

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
   */
  public static Extra extra(String purpose) throws Exception {
    Database main;
    synchronized (LOCK) {
      main = database;
    }
    if (main == null || main.url == null || main.adminUrl == null) {
      throw new IllegalStateException("Extend the test class with ScratchDatabase");
    }
    String source = main.name.substring(0, main.name.lastIndexOf("_jvm_"));
    byte[] hash =
        MessageDigest.getInstance("SHA-256")
            .digest(
                ("jvm:" + purpose + ":" + ProcessHandle.current().pid())
                    .getBytes(StandardCharsets.UTF_8));
    String name =
        source.substring(0, Math.min(source.length(), 43))
            + "_jvm_"
            + HexFormat.of().formatHex(hash).substring(0, 10);
    String url = main.url.replaceFirst("/" + main.name + "(?=\\?|$)", "/" + name);
    Extra extra = new Extra(url, main.adminUrl, main.credentials, name);
    try (Connection admin = DriverManager.getConnection(main.adminUrl, main.credentials)) {
      dropDatabase(admin, name);
      try (Statement statement = admin.createStatement()) {
        statement.execute("CREATE DATABASE " + quoteIdentifier(name));
      }
    }
    try (Connection connection = extra.connect();
        Statement statement = connection.createStatement()) {
      statement.execute(Files.readString(schema()));
    } catch (Exception error) {
      extra.close();
      throw error;
    }
    report("running against extra scratch database " + name);
    return extra;
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
      return new Database(null, null, new Properties(), "");
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
        new Database(base + name + query, base + "postgres" + query, credentials, name);
    // Owned before it exists, so a failed schema install still drops the database.
    database = created;
    try (Connection admin = DriverManager.getConnection(created.adminUrl, credentials)) {
      dropDatabase(admin, name);
      try (Statement statement = admin.createStatement()) {
        statement.execute("CREATE DATABASE " + quoteIdentifier(name));
      }
    }
    try (Connection connection = DriverManager.getConnection(created.url, credentials);
        Statement statement = connection.createStatement()) {
      statement.execute(Files.readString(schema()));
    }
    report("running against scratch database " + name);
    return created;
  }

  private static void drop() throws SQLException {
    Database current;
    synchronized (LOCK) {
      current = database;
    }
    if (current == null || current.adminUrl == null) {
      return;
    }
    try (Connection admin = DriverManager.getConnection(current.adminUrl, current.credentials)) {
      dropDatabase(admin, current.name);
      report("dropped scratch database " + current.name);
    } catch (SQLException error) {
      report(
          "could not drop scratch database "
              + current.name
              + ": "
              + error.getMessage()
              + "; run pnpm db:sweep");
      throw error;
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

  private record Database(
      @Nullable String url, @Nullable String adminUrl, Properties credentials, String name) {}
}
