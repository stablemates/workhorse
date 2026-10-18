/**
 * Spans, metrics, and W3C trace context (ADR 0103, "Telemetry"). The module does not export this
 * package.
 *
 * <p>Only {@link run.workhorse.internal.telemetry.OpenTelemetryTelemetry} names an OpenTelemetry
 * type. The other types load without the optional API on the class path.
 */
@NullMarked
package run.workhorse.internal.telemetry;

import org.jspecify.annotations.NullMarked;
