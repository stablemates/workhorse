package dev.stablemates.workhorse.kotlin

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** The class that `WorkerScope.handle` registers for each reified payload type. */
class PayloadTypeTest {
  @Test
  fun erasesEachPayloadTypeToTheClassTheCoreDecodes() {
    assertEquals(Long::class.javaObjectType, javaClassOf<Long>())
    assertEquals(Map::class.java, javaClassOf<Map<String, Any?>?>())
    assertEquals(arrayOf<List<Long>>().javaClass, javaClassOf<Array<List<Long>>>())
    assertEquals(Array<String>::class.java, javaClassOf<Array<String>>())
    assertEquals(LongArray::class.java, javaClassOf<LongArray>())
    assertEquals(Any::class.java, javaClassOf<Any?>())
  }
}
