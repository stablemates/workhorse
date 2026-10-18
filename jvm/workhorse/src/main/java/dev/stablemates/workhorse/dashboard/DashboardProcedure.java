package dev.stablemates.workhorse.dashboard;

import org.jspecify.annotations.Nullable;

/**
 * One {@code dashboard/v1} procedure that the host application supplies, such as {@code
 * enqueueTest}. The counterpart of the procedure callables of Ruby's {@code Dashboard}.
 *
 * <p>The input is the request's {@code json} value after schema validation, in the core's JSON
 * tree: a {@code Map<String, @Nullable Object>}, a {@code List<@Nullable Object>}, a {@code Long},
 * a {@code BigInteger}, a {@code Double}, a {@code String}, a {@code Boolean}, or {@code null}. An
 * {@code audit} object carries the authenticated actor. The dashboard encodes the result with its
 * {@link dev.stablemates.workhorse.JsonCodec}. A {@code null} result answers {@code {}}.
 */
@FunctionalInterface
public interface DashboardProcedure {
  /**
   * Answers one call.
   *
   * @param input the validated input
   * @param actor the authenticated actor, a {@code String}
   * @return the result, which the codec can encode
   * @throws DashboardRpcException to refuse the call with an RPC status and code
   * @throws Exception for any other failure; the dashboard answers 500 without detail
   */
  @Nullable Object call(@Nullable Object input, @Nullable Object actor) throws Exception;
}
