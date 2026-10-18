package run.workhorse;

/** How one child of {@link HandlerContext#runChildren} ended. */
public enum ChildStatus {
  /** The child completed. */
  SUCCEEDED,
  /** The child failed. */
  FAILED,
  /** The child was canceled. */
  CANCELED
}
