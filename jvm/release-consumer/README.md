# JVM release consumers

`scripts/check-jvm-release.ts` copies each of these Gradle projects to a temporary directory and
builds it against the staged artifacts. With the `workhorseRepository` property, each project
resolves `run.workhorse` only from that directory, and every other module from Maven Central.
Without it, the project takes the published release from Maven Central. `pnpm release:verify maven`
builds the Java and Kotlin consumers that way, for the cold install of ADR 0056 Gate 3.

- `java/` takes `run.workhorse:workhorse`, enqueues one task, and runs it with `Worker.runOnce`.
- `kotlin/` takes `run.workhorse:workhorse-kotlin`, and runs the task with a suspend handler.
- `spring-boot/` takes `run.workhorse:workhorse-spring-boot-starter`. The starter's worker runs
  the task that the application enqueues. The application asks for no optional feature of the
  starter, and it refuses a class path that holds one of their modules.

Each consumer uses the public API as an application does. A change to that API updates these files
too.
