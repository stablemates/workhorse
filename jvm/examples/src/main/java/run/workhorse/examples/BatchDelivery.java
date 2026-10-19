package run.workhorse.examples;

import org.jspecify.annotations.Nullable;

/**
 * The answer of the email provider for one email, for the snippets of the site page about batch
 * handlers. The provider sets {@code error} when it did not accept the email.
 */
public record BatchDelivery(String id, @Nullable Exception error) {}
