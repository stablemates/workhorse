// A Java application that takes the core from the staging directory.
plugins { application }

val workhorseVersion: String by project
val pgjdbcVersion: String by project

dependencies {
  implementation("dev.stablemates:workhorse:$workhorseVersion")
  // The core keeps PgJDBC off the caller's compile class path, so the application names it to
  // build its own DataSource.
  implementation("org.postgresql:postgresql:$pgjdbcVersion")
}

// The consumer builds on the JDK that runs Gradle, for the Java floor of ADR 0103.
tasks.withType<JavaCompile>().configureEach { options.release = 21 }

application { mainClass = "consumer.Main" }
