package dev.stablemates.workhorse.kotlin

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Test

/**
 * The language floor of ADR 0103: the module compiles with language and API version 2.2, so a
 * Kotlin 2.2 compiler reads its classes. `verifyKotlinFloor` checks the standard library that the
 * module's dependencies resolve.
 */
class LanguageFloorTest {
  @Test
  fun writesKotlin22MetadataInEveryPublicClass() {
    for (type in
      listOf(
        SuspendHandler::class.java,
        SuspendHandlerContext::class.java,
        SuspendTaskGroupContext::class.java,
        WorkerScope::class.java,
        Class.forName("dev.stablemates.workhorse.kotlin.QueueSuspend"),
        Class.forName("dev.stablemates.workhorse.kotlin.AdminSuspend"),
      )) {
      val metadata = type.getAnnotation(Metadata::class.java)
      assertArrayEquals(intArrayOf(2, 2, 0), metadata.metadataVersion, type.name)
    }
  }
}
