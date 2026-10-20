/**
 * The embedded dashboard backend: a Jakarta Servlet filter that serves the Workhorse dashboard and
 * its {@code dashboard/v1} procedures from the host application's own server (ADR 0103, "Embedded
 * dashboard backend").
 *
 * <p>The package needs the Jakarta Servlet API 6.0 or later on the class path. The servlet
 * container supplies it, so the core declares it as optional.
 *
 * <p>A public record of this package can gain a component in a minor release (ADR 0103). The new
 * component goes only at the end of the component list, and it is nullable or has a default that
 * keeps the earlier behavior. The record keeps each earlier canonical constructor, so {@code new}
 * and every accessor keep working. The output of {@code equals}, {@code hashCode}, and {@code
 * toString} can change. A record pattern that names all components of a public Workhorse record is
 * outside the compatibility promise, because it stops compiling when the record gains a component.
 */
@NullMarked
package run.workhorse.dashboard;

import org.jspecify.annotations.NullMarked;
