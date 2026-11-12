package run.workhorse.apisnapshot

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
    val before = lines(source).single { it.startsWith("sample: ") && "fun scope(" in it }
    val after =
      lines(source.replace("100", "200")).single { it.startsWith("sample: ") && "fun scope(" in it }

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
        .single { it.startsWith("sample: ") && "fun f(" in it }

    val one = line("\"\"\"a\n b\"\"\"")
    val two = line("\"\"\"a\n  b\"\"\"")

    assertEquals("sample: public fun f(text: String = \"\"\"a%0A b\"\"\"): Unit", one)
    assertNotEquals(one, two)
    // A literal that holds the escaped text itself must not read as the line break.
    assertNotEquals(one, line("\"\"\"a%0A b\"\"\""))
    assertNotEquals(one, line("\"\"\"a\u2424 b\"\"\""))
  }

  private fun files(vararg files: Pair<String, String>): List<String> =
    kotlinSections(files.toList()).flatten()

  private val suspendFile =
    "@file:JvmName(\"QueueSuspend\")\n\npackage sample\n\npublic fun enqueue(): Unit = Unit\n"

  private val scopeFile = "package sample\n\npublic fun worker(): Unit = Unit\n"

  @Test
  fun `names the JVM class that holds each top-level declaration`() {
    val lines = files("QueueSuspend.kt" to suspendFile, "WorkerScope.kt" to scopeFile)

    assertTrue("jvm file class sample.QueueSuspend" in lines, lines.joinToString("\n"))
    assertTrue("sample.QueueSuspend: fun enqueue()" in lines)
    assertTrue("jvm file class sample.WorkerScopeKt" in lines)
    assertTrue("sample.WorkerScopeKt: fun worker()" in lines)
  }

  @Test
  fun `loses a line when a JVM file class changes, and only gains one for a new declaration`() {
    val before = files("QueueSuspend.kt" to suspendFile, "WorkerScope.kt" to scopeFile)
    val renamedAnnotation =
      files(
        "QueueSuspend.kt" to suspendFile.replace("\"QueueSuspend\"", "\"QueueSuspendKt\""),
        "WorkerScope.kt" to scopeFile,
      )
    val renamedFile = files("QueueSuspend.kt" to suspendFile, "Workers.kt" to scopeFile)
    val added =
      files(
        "QueueSuspend.kt" to suspendFile + "\npublic val limit: Int = 1\n",
        "WorkerScope.kt" to scopeFile,
      )

    assertTrue("sample.QueueSuspend: fun enqueue()" !in renamedAnnotation)
    assertTrue("sample.WorkerScopeKt: fun worker()" !in renamedFile)
    assertTrue(added.containsAll(before))
    assertEquals(
      setOf("sample: public val limit: Int = 1", "sample.QueueSuspend: val limit"),
      added.toSet() - before.toSet(),
    )
  }

  @Test
  fun `loses a line when an overload moves to another JVM file class`() {
    val alpha = "package sample\n\npublic fun read(value: Int): Unit = Unit\n"
    val beta = "package sample\n\npublic fun read(value: String): Unit = Unit\n"
    val before = files("Alpha.kt" to alpha, "Beta.kt" to beta)
    val exchanged = files("Alpha.kt" to beta, "Beta.kt" to alpha)

    assertTrue("sample.AlphaKt: fun read(Int)" in before, before.joinToString("\n"))
    assertTrue("sample.AlphaKt: fun read(Int)" !in exchanged)
    assertTrue("sample.BetaKt: fun read(String)" !in exchanged)
  }

  @Test
  fun `loses a line when a generic overload moves to another JVM file class`() {
    val alpha = "package sample\n\npublic fun <T : Number> read(value: T): Unit = Unit\n"
    val beta = "package sample\n\npublic fun <T : CharSequence> read(value: T): Unit = Unit\n"
    val before = files("Alpha.kt" to alpha, "Beta.kt" to beta)
    val exchanged = files("Alpha.kt" to beta, "Beta.kt" to alpha)

    assertTrue("sample.AlphaKt: fun <T : Number> read(T)" in before, before.joinToString("\n"))
    assertTrue("sample.AlphaKt: fun <T : Number> read(T)" !in exchanged)
  }

  @Test
  fun `loses a line when a generic extension property moves to another JVM file class`() {
    val alpha = "package sample\n\npublic val <T : Number> T.tag: Int get() = 1\n"
    val beta = "package sample\n\npublic val <T : CharSequence> T.tag: Int get() = 1\n"
    val before = files("Alpha.kt" to alpha, "Beta.kt" to beta)
    val exchanged = files("Alpha.kt" to beta, "Beta.kt" to alpha)

    assertTrue("sample.AlphaKt: val <T : Number> T.tag" in before, before.joinToString("\n"))
    assertTrue("sample.AlphaKt: val <T : Number> T.tag" !in exchanged)
  }

  @Test
  fun `reads the JVM class name by its value`() {
    val plain =
      files(
        "Stable.kt" to
          "@file:JvmName(\"Stable\")\n\npackage sample\n\npublic fun read(): Unit = Unit\n",
      )
    val escaped =
      files(
        "Stable.kt" to
          "@file:JvmName(\"St\\u0061ble\")\n\npackage sample\n\npublic fun read(): Unit = Unit\n",
      )
    val constant =
      files(
        "Stable.kt" to
          "@file:JvmName(FACADE)\n\npackage sample\n\nprivate const val FACADE: String = \"Stable\"\n\npublic fun read(): Unit = Unit\n",
      )

    assertTrue("sample.Stable: fun read()" in plain, plain.joinToString("\n"))
    assertEquals(plain, escaped)
    assertEquals(plain, constant)
  }

  @Test
  fun `reads JvmName through an import alias`() {
    val aliased =
      files(
        "Stable.kt" to
          "@file:Facade(\"Stable\")\n\npackage sample\n\nimport kotlin.jvm.JvmName as Facade\n\npublic fun read(): Unit = Unit\n",
      )

    assertTrue("sample.Stable: fun read()" in aliased, aliased.joinToString("\n"))
  }

  @Test
  fun `says that a JvmName expression is a limit of the reader, and where to read next`() {
    // Known limit K: the reader evaluates a string literal or a const val, not an expression.
    val error =
      assertThrows<IllegalStateException> {
        files(
          "Stable.kt" to
            "@file:JvmName(\"Sta\" + \"ble\")\n\npackage sample\n\npublic fun read(): Unit = Unit\n",
        )
      }

    val message = error.message.orEmpty()
    assertTrue("cannot read" in message, message)
    assertTrue("not a judged break of the Kotlin API" in message, message)
    assertTrue("\"Known limits\" in api/README.md" in message, message)
  }
}
