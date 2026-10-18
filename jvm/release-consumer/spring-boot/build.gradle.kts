// A Spring Boot application that takes the starter from the staging directory.
plugins { application }

val workhorseVersion: String by project
val springBootVersion: String by project

dependencies {
  implementation(platform("org.springframework.boot:spring-boot-dependencies:$springBootVersion"))
  implementation("dev.stablemates:workhorse-spring-boot-starter:$workhorseVersion")
  // The application's DataSource. The starter builds its Queue and its worker on it.
  implementation("org.springframework.boot:spring-boot-starter-jdbc")
  runtimeOnly("org.postgresql:postgresql")
}

// The consumer builds on the JDK that runs Gradle, for the Java floor of ADR 0103.
tasks.withType<JavaCompile>().configureEach { options.release = 21 }

application { mainClass = "consumer.Main" }
