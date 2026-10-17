// `workhorse`: the Java core, the named module `dev.stablemates.workhorse` (ADR 0103).

description = "Workhorse for Java: the client, the worker, Admin, and the dashboard backend"

dependencies {
  // PgJDBC at its floor. A caller may resolve a newer 42.7.x, and `PgjdbcVersion` refuses an
  // older one at run time.
  implementation(libs.pgjdbc)
  api(libs.jspecify)
}
