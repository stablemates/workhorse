package dev.stablemates.workhorse.apisnapshot

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class KotlinApiTest {
  private fun lines(source: String): List<String> =
    kotlinSections(listOf("Sample.kt" to source)).flatten()

  private val source =
    """
    package sample

    import java.time.Duration
    import java.util.UUID as Id

    public annotation class Marker

    @Marker
    public class Scope internal constructor(private val name: String) {
      public var lease: Duration? = null
      public var count: Int = 1
        private set

      public suspend inline fun <reified T> wait(name: String, timeout: Duration? = null): T = TODO()

      @PublishedApi internal fun <T> resolve(id: Id): T = TODO()

      internal fun hidden(): Unit = Unit

      private fun secret(): Unit = Unit
    }

    public fun interface Handler<P> {
      public suspend fun handle(scope: Scope, payload: P): Any?
    }

    public fun scope(configure: Scope.() -> Unit, limit: Int =
        100): Scope = TODO()

    internal fun internalOnly(): Unit = Unit
    """
      .trimIndent()

  @Test
  fun `prints suspend, reified, default arguments, and qualified types`() {
    val lines = lines(source)

    assertTrue(
      "sample.Scope: public suspend inline fun <reified T> wait(name: String, timeout: java.time.Duration? = null): T" in
        lines,
      lines.joinToString("\n"),
    )
    assertTrue(
      "sample: public fun scope(configure: sample.Scope.() -> Unit, limit: Int = 100): sample.Scope" in
        lines,
    )
    assertTrue(
      "sample.Handler: public abstract suspend fun handle(scope: sample.Scope, payload: P): Any?" in
        lines,
    )
    assertTrue("public fun interface sample.Handler<P>" in lines)
    assertTrue("@Marker public final class sample.Scope" in lines)
  }

  @Test
  fun `prints properties with their initializers and setter visibility`() {
    val lines = lines(source)

    assertTrue("sample.Scope: public var lease: java.time.Duration? = null" in lines)
    assertTrue("sample.Scope: public var count: Int = 1 (private set)" in lines)
  }

  @Test
  fun `keeps a published internal declaration and leaves out the rest`() {
    val text = lines(source).joinToString("\n")

    assertTrue(
      "sample.Scope: @PublishedApi internal fun <T> resolve(id: java.util.UUID): T" in text,
    )
    assertTrue(
      "hidden" !in text && "secret" !in text && "internalOnly" !in text && "constructor" !in text,
    )
  }

  @Test
  fun `changes the line when a default argument changes`() {
    val before = lines(source).single { "fun scope(" in it }
    val after = lines(source.replace("100", "200")).single { "fun scope(" in it }

    assertNotEquals(before, after)
  }

  @Test
  fun `refuses a star import, whose names it cannot qualify`() {
    val error =
      assertThrows<IllegalStateException> {
        lines("package sample\n\nimport java.time.*\n\npublic fun f(): Duration = TODO()\n")
      }

    assertEquals(
      "Sample.kt imports java.time.*; the snapshot reader needs every imported name",
      error.message,
    )
  }

  @Test
  fun `prints the implicit constructor, so making it private changes the file`() {
    val open = lines("package sample\n\npublic class Example\n")
    val closed = lines("package sample\n\npublic class Example private constructor()\n")
    val sealed = lines("package sample\n\npublic sealed class Shape\n")

    assertTrue("sample.Example: public constructor()" in open)
    assertTrue(closed.none { "constructor" in it })
    assertTrue("sample.Shape: protected constructor()" in sealed)
    assertTrue(lines("package sample\n\npublic object Single\n").none { "constructor" in it })
  }

  @Test
  fun `marks an interface property without a getter body abstract`() {
    val withDefault =
      lines("package sample\n\npublic interface Counter {\n  public val count: Int get() = 1\n}\n")
    val abstract =
      lines("package sample\n\npublic interface Counter {\n  public val count: Int\n}\n")

    assertTrue("sample.Counter: public val count: Int" in withDefault)
    assertTrue("sample.Counter: public abstract val count: Int" in abstract)
  }

  @Test
  fun `keeps every character of a string default and drops comments around it`() {
    fun line(literal: String): String =
      lines(
          "package sample\n\npublic fun f(text: String =\n    /* note */ $literal): Unit = Unit\n",
        )
        .single { "fun f(" in it }

    val one = line("\"\"\"a\n b\"\"\"")
    val two = line("\"\"\"a\n  b\"\"\"")

    assertEquals("sample: public fun f(text: String = \"\"\"a%0A b\"\"\"): Unit", one)
    assertNotEquals(one, two)
    // A literal that holds the escaped text itself must not read as the line break.
    assertNotEquals(one, line("\"\"\"a%0A b\"\"\""))
    assertNotEquals(one, line("\"\"\"a\u2424 b\"\"\""))
  }
}
