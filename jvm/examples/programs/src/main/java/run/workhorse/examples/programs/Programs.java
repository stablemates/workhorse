package run.workhorse.examples.programs;

import org.postgresql.ds.PGSimpleDataSource;

/** The database connection that each program reads from its environment. */
final class Programs {
  private Programs() {}

  /** A data source for the JDBC URL in the environment variable {@code name}. */
  static PGSimpleDataSource dataSource(String name) {
    String url = System.getenv(name);
    if (url == null || url.isEmpty()) {
      throw new IllegalStateException(name + " is required");
    }
    PGSimpleDataSource dataSource = new PGSimpleDataSource();
    dataSource.setURL(url);
    return dataSource;
  }
}
