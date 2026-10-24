/**
 * The cross-SDK scenario programs. Each class with a {@code main} method is one program, the JVM
 * counterpart of the program of the same scenario in {@code ruby/examples}. Each program reads a
 * PostgreSQL JDBC URL, such as {@code jdbc:postgresql://localhost/app?user=app}, from {@code
 * WORKHORSE_DATABASE_URL}. The demo worker reads {@code DATABASE_URL_PRIMARY}, as a {@code
 * postgres://} URL or a JDBC URL.
 */
@NullMarked
package run.workhorse.examples.programs;

import org.jspecify.annotations.NullMarked;
