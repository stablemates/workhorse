package run.workhorse.examples;

import java.util.List;

/** The email provider of the snippets of the site page about batch handlers. */
public interface BatchEmailProvider {
  /** Sends the emails in one request, and returns one delivery for each email, in order. */
  List<BatchDelivery> sendMany(List<?> emails);
}
