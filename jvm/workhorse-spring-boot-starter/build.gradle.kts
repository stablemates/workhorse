// `workhorse-spring-boot-starter`: auto-configuration, transactions, lifecycle, and health
// (ADR 0103, "Spring Boot starter").

description = "Workhorse for Spring Boot: auto-configuration, transactions, lifecycle, and health"

dependencies {
  api(project(":workhorse"))
  api(libs.spring.boot.autoconfigure)
  api(libs.spring.boot.jdbc)
}

tasks.jar { manifest { attributes("Automatic-Module-Name" to "dev.stablemates.workhorse.spring") } }
