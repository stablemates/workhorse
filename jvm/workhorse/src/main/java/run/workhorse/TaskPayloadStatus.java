package run.workhorse;

/** What a task page did with the payload of a task. */
public enum TaskPayloadStatus {
  /** The projection omits payloads. */
  OMITTED,
  /** The page includes the payload. */
  INCLUDED,
  /** The payload is larger than the projection's maximum, so the page omits it. */
  TOO_LARGE
}
