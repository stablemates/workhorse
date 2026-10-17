package dev.stablemates.workhorse;

/** How a task belongs to a task group. */
public enum TaskGroupRole {
  /** The task is a member task. */
  MEMBER,
  /** The task is a callback of the group. */
  CALLBACK
}
