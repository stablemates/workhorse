// A Kotlin application that takes the Kotlin module from the staging directory.
plugins {
  id("org.jetbrains.kotlin.jvm")
  application
}

val workhorseVersion: String by project
val pgjdbcVersion: String by project

dependencies {
  implementation("dev.stablemates:workhorse-kotlin:$workhorseVersion")
  implementation("org.postgresql:postgresql:$pgjdbcVersion")
}

// The consumer builds on the JDK that runs Gradle, for the Java floor of ADR 0103.
kotlin { compilerOptions { jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21 } }

tasks.withType<JavaCompile>().configureEach { options.release = 21 }

application { mainClass = "consumer.MainKt" }
