package run.workhorse.apisnapshot

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import run.workhorse.apisnapshot.fixture.Sample
import tools.jackson.databind.json.JsonMapper

class JavaApiTest {
  private val owner = "run.workhorse.apisnapshot.fixture.Sample"

  private fun lines(type: Class<*>): List<String> = JavaClass(type).lines()

  @Test
  fun `prints the header with type parameters and nullness`() {
    assertEquals(
      "@NullMarked public class $owner<T extends @Nullable java.lang.Object>",
      lines(Sample::class.java).first(),
    )
  }

  @Test
  fun `prints each public and protected member with its signature and nullness`() {
    val members = lines(Sample::class.java).drop(1).sorted()

    assertEquals(
      listOf(
        "$owner: @Deprecated public void old()",
        "$owner: @NullUnmarked public void loose(java.lang.String)",
        "$owner: protected Sample(java.lang.String)",
        "$owner: public @Nullable java.lang.String find(java.util.List<? extends T>, java.lang.String @Nullable [])",
        "$owner: public @Nullable $owner<java.lang.String>.Inner<java.lang.Integer> inner()",
        "$owner: public Sample()",
        "$owner: public final int count",
        "$owner: public java.util.Map<java.lang.String, @Nullable java.lang.Object> map(java.lang.Object...)",
        "$owner: public static <R extends java.lang.Comparable<? super R>> R max(R, R) throws java.io.IOException",
        "$owner: public static final java.lang.String NAME = \"sample \\\"one\\\"\"",
        "$owner: public static final long LIMIT = 10L",
      ),
      members,
    )
  }

  @Test
  fun `prints records, sealed types, and enums`() {
    assertEquals(
      "@NullMarked public record $owner.Entry(java.lang.String key, @Nullable java.lang.Integer value)",
      lines(Sample.Entry::class.java).first(),
    )
    assertEquals(
      listOf(
        "@NullMarked public sealed interface $owner.Shape permits $owner.Circle, $owner.Square",
        "$owner.Shape: public abstract double area()",
        "$owner.Shape: public default java.lang.String label()",
      ),
      lines(Sample.Shape::class.java),
    )
    assertEquals(
      "@NullMarked public static non-sealed class $owner.Square implements $owner.Shape",
      lines(Sample.Square::class.java).first(),
    )
    val mode = lines(Sample.Mode::class.java)
    assertEquals("@NullMarked public enum $owner.Mode", mode.first())
    assertEquals(
      listOf("$owner.Mode: enum constant OFF", "$owner.Mode: enum constant ON"),
      mode.filter { "enum constant" in it }.sorted(),
    )
  }

  @Test
  fun `prints a primitive array default element by element`() {
    assertEquals(
      listOf(
        "@NullMarked public @interface $owner.Tag",
        "$owner.Tag: public abstract int[] value() default {1, 2}",
      ),
      lines(Sample.Tag::class.java),
    )
  }

  @Test
  fun `writes modifier keywords in the order of the language specification`() {
    // The reader writes these words itself, because Java 27 deprecates Modifier.toString.
    val all =
      java.lang.reflect.Modifier.PUBLIC or
        java.lang.reflect.Modifier.STATIC or
        java.lang.reflect.Modifier.FINAL or
        java.lang.reflect.Modifier.TRANSIENT or
        java.lang.reflect.Modifier.VOLATILE

    assertEquals(listOf("public", "static", "final", "transient", "volatile"), modifierWords(all))
    assertEquals(
      listOf("protected", "abstract"),
      modifierWords(java.lang.reflect.Modifier.ABSTRACT or java.lang.reflect.Modifier.PROTECTED),
    )
    assertEquals(emptyList<String>(), modifierWords(0))
  }

  @Test
  fun `leaves out what a caller cannot name`() {
    val text = lines(Sample::class.java).joinToString("\n")

    assertFalse("packagePrivate" in text)
    assertFalse("secret" in text)
    assertFalse("Sample(int)" in text)
  }

  @Test
  fun `records a JSpecify scope change, which changes what an unannotated type means`() {
    // Inside @NullUnmarked, `String` means "nullness unknown", not "not null".
    assertEquals(
      listOf(
        "@NullUnmarked public static class $owner.Legacy",
        "$owner.Legacy: public Legacy()",
        "$owner.Legacy: public void run(java.lang.String)",
      ),
      lines(Sample.Legacy::class.java),
    )
  }

  @Test
  fun `reads each property default from the built class, not from the metadata`() {
    // The metadata states no default and one stale default, as the processor and a hand-kept
    // file can. The lines must follow the class.
    val metadata =
      JsonMapper.builder()
        .build()
        .readTree(
          """
          {"groups": [
            {"name": "sample", "type": "run.workhorse.apisnapshot.fixture.SampleProperties"},
            {"name": "sample.group", "sourceMethod": "getGroup()"}],
           "properties": [
            {"name": "sample.group.enabled", "type": "java.lang.Boolean"},
            {"name": "sample.group.names", "type": "java.util.List<java.lang.String>", "defaultValue": ["stale"]},
            {"name": "sample.group.extras", "type": "java.util.List<java.lang.String>"},
            {"name": "sample.group.lease", "type": "java.time.Duration"},
            {"name": "sample.group.id", "type": "java.lang.String"}]}
          """,
        )

    assertEquals(
      listOf(
        "property sample.group.enabled: java.lang.Boolean = false",
        "property sample.group.names: java.util.List<java.lang.String> = [\"default\"]",
        "property sample.group.extras: java.util.List<java.lang.String> = []",
        "property sample.group.lease: java.time.Duration = \"PT30S\"",
        "property sample.group.id: java.lang.String",
      ),
      propertyLines(metadata, javaClass.classLoader),
    )
  }

  @Test
  fun `stops on a property that no getter reads`() {
    val metadata =
      JsonMapper.builder()
        .build()
        .readTree(
          """
          {"groups": [{"name": "sample", "type": "run.workhorse.apisnapshot.fixture.SampleProperties"}],
           "properties": [{"name": "sample.group.missing", "type": "java.lang.String"}]}
          """,
        )

    val error = runCatching { propertyLines(metadata, javaClass.classLoader) }.exceptionOrNull()

    assertTrue(
      error is IllegalStateException &&
        "no getter for sample.group.missing" in error.message.orEmpty(),
    )
  }
}
