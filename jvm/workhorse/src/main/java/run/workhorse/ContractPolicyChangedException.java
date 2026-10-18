package run.workhorse;

/** Contracts changed again while the client retried an enqueue with reloaded contracts. */
public final class ContractPolicyChangedException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  /** The exception. */
  public ContractPolicyChangedException() {
    super("contract policy changed again while retrying enqueue");
  }
}
