/**
 * The embedded dashboard backend: a Jakarta Servlet filter that serves the Workhorse dashboard and
 * its {@code dashboard/v1} procedures from the host application's own server (ADR 0103, "Embedded
 * dashboard backend").
 *
 * <p>The package needs the Jakarta Servlet API 6.0 or later on the class path. The servlet
 * container supplies it, so the core declares it as optional.
 */
@NullMarked
package dev.stablemates.workhorse.dashboard;

import org.jspecify.annotations.NullMarked;
