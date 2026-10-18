package dev.stablemates.workhorse.apisnapshot

import java.io.File
import java.nio.file.Files
import java.nio.file.Path

/**
 * Writes one API snapshot.
 *
 * - `java <output> <artifact>=<jar>... --classpath=<path>` writes `api/java.txt`.
 * - `kotlin <output> <source directory>` writes `api/kotlin.txt`.
 *
 * `scripts/generate-java-api.ts` and `scripts/generate-kotlin-api.ts` run the Gradle tasks that
 * call this, then compare the output with the committed file.
 */
fun main(args: Array<String>) {
  require(args.size >= 3) { "usage: java|kotlin <output> <inputs>..." }
  val output = Path.of(args[1])
  val text =
    when (args[0]) {
      "java" -> {
        val classpath =
          args
            .single { it.startsWith(CLASSPATH) }
            .removePrefix(CLASSPATH)
            .split(File.pathSeparator)
            .filter { it.isNotEmpty() }
            .map(Path::of)
        val artifacts =
          args
            .drop(2)
            .filterNot { it.startsWith(CLASSPATH) }
            .map { it.substringBefore('=') to Path.of(it.substringAfter('=')) }
        javaSnapshot(artifacts, classpath)
      }
      "kotlin" -> kotlinSnapshot(Path.of(args[2]))
      else -> throw IllegalArgumentException("unknown snapshot ${args[0]}")
    }
  Files.createDirectories(output.parent)
  Files.writeString(output, text)
}

private const val CLASSPATH = "--classpath="

/**
 * Joins sections of lines into one file. Each section starts with its header line and continues
 * with its other lines in sorted order, so the file does not depend on reflection or source order.
 */
internal fun render(header: String, sections: List<List<String>>): String = buildString {
  append(header)
  for (section in sections) {
    append('\n')
    append(section.first()).append('\n')
    for (line in section.drop(1).sorted()) append(line).append('\n')
  }
}
