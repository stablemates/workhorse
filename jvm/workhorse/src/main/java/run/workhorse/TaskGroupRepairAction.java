package run.workhorse;

/** What a drift repair does, or did, to one task group. */
public enum TaskGroupRepairAction {
  /** The repair recounts the counters from the member outcomes. */
  RECOUNTED,
  /** The repair finishes a sealed group with no pending member. */
  FINISHED
}
