// The suspend wrappers of `Admin`. Each public Java method family has one wrapper, with a
// `connection` argument as in `QueueSuspend.kt`. Each wrapper runs the Java call on a virtual
// thread in `runInterruptible`, so a cancellation interrupts that thread. An interrupt closes the
// socket of a JDBC read on a virtual thread, and the caller's connection is not usable after a
// cancelled call.
@file:JvmName("AdminSuspend")

package run.workhorse.kotlin

import java.sql.Connection
import java.util.UUID
import run.workhorse.Admin
import run.workhorse.AdminAudit
import run.workhorse.BulkRedrivePage
import run.workhorse.DeadLetterPage
import run.workhorse.DeadLetterQuery
import run.workhorse.HumanWaitPage
import run.workhorse.HumanWaitQuery
import run.workhorse.RedriveFilter
import run.workhorse.RedriveResult
import run.workhorse.SignalWaitPage
import run.workhorse.SignalWaitQuery
import run.workhorse.TaskCheckpoint
import run.workhorse.TaskDetail
import run.workhorse.TaskGroup
import run.workhorse.TaskGroupDrift
import run.workhorse.TaskGroupEvent
import run.workhorse.TaskGroupMemberPage
import run.workhorse.TaskGroupRepair
import run.workhorse.TaskPage
import run.workhorse.TaskProgress
import run.workhorse.TaskQuery
import run.workhorse.TaskWait
import run.workhorse.TimelinePage
import run.workhorse.TimelineQuery
import run.workhorse.WorkerInfo
import run.workhorse.WorkerPauseResult

/** Checks that the database schema is compatible with this SDK. */
public suspend fun Admin.assertCompatibleSuspend(connection: Connection? = null): Unit = blocking {
  if (connection == null) assertCompatible() else assertCompatible(connection)
}

/** One page of the tasks that [query] selects. */
public suspend fun Admin.listTasksSuspend(
  query: TaskQuery = TaskQuery.defaults(),
  connection: Connection? = null,
): TaskPage = blocking {
  if (connection == null) listTasks(query) else listTasks(connection, query)
}

/** The task [taskId], or `null` when it does not exist. */
public suspend fun Admin.getTaskSuspend(taskId: UUID, connection: Connection? = null): TaskDetail? =
  blocking {
    (if (connection == null) getTask(taskId) else getTask(connection, taskId)).orElse(null)
  }

/** One page of the timeline of the task [taskId]. */
public suspend fun Admin.getTaskTimelineSuspend(
  taskId: UUID,
  query: TimelineQuery = TimelineQuery.defaults(),
  connection: Connection? = null,
): TimelinePage = blocking {
  if (connection == null) getTaskTimeline(taskId, query)
  else getTaskTimeline(connection, taskId, query)
}

/** One page of the dead letters that [query] selects. */
public suspend fun Admin.listDeadLettersSuspend(
  query: DeadLetterQuery = DeadLetterQuery.defaults(),
  connection: Connection? = null,
): DeadLetterPage = blocking {
  if (connection == null) listDeadLetters(query) else listDeadLetters(connection, query)
}

/** Redrives the dead letter [sourceTaskId] as a new task. */
public suspend fun Admin.redriveSuspend(
  sourceTaskId: UUID,
  audit: AdminAudit,
  connection: Connection? = null,
): RedriveResult = blocking {
  if (connection == null) redrive(sourceTaskId, audit) else redrive(connection, sourceTaskId, audit)
}

/** Redrives one batch of the dead letters that [filter] selects. */
public suspend fun Admin.redriveManySuspend(
  filter: RedriveFilter,
  audit: AdminAudit,
  connection: Connection? = null,
): BulkRedrivePage = blocking {
  if (connection == null) redriveMany(filter, audit) else redriveMany(connection, filter, audit)
}

/** The checkpoint [name] of the task [taskId], or `null` when it does not exist. */
public suspend fun Admin.getCheckpointSuspend(
  taskId: UUID,
  name: String,
  connection: Connection? = null,
): TaskCheckpoint? = blocking {
  (if (connection == null) getCheckpoint(taskId, name) else getCheckpoint(connection, taskId, name))
    .orElse(null)
}

/** The checkpoints of the task [taskId]. */
public suspend fun Admin.listCheckpointsSuspend(
  taskId: UUID,
  connection: Connection? = null,
): List<TaskCheckpoint> = blocking {
  if (connection == null) listCheckpoints(taskId) else listCheckpoints(connection, taskId)
}

/** The progress of the task [taskId], or `null` when it reported none. */
public suspend fun Admin.getProgressSuspend(
  taskId: UUID,
  connection: Connection? = null,
): TaskProgress? = blocking {
  (if (connection == null) getProgress(taskId) else getProgress(connection, taskId)).orElse(null)
}

/** The wait [name] of the task [taskId], or `null` when it does not exist. */
public suspend fun Admin.getWaitSuspend(
  taskId: UUID,
  name: String,
  connection: Connection? = null,
): TaskWait? = blocking {
  (if (connection == null) getWait(taskId, name) else getWait(connection, taskId, name)).orElse(
    null,
  )
}

/** The waits of the task [taskId]. */
public suspend fun Admin.listWaitsSuspend(
  taskId: UUID,
  connection: Connection? = null,
): List<TaskWait> = blocking {
  if (connection == null) listWaits(taskId) else listWaits(connection, taskId)
}

/** One page of the signal waits that [query] selects. */
public suspend fun Admin.listSignalWaitsSuspend(
  query: SignalWaitQuery = SignalWaitQuery.defaults(),
  connection: Connection? = null,
): SignalWaitPage = blocking {
  if (connection == null) listSignalWaits(query) else listSignalWaits(connection, query)
}

/** One page of the human waits that [query] selects. */
public suspend fun Admin.listHumanWaitsSuspend(
  query: HumanWaitQuery = HumanWaitQuery.defaults(),
  connection: Connection? = null,
): HumanWaitPage = blocking {
  if (connection == null) listHumanWaits(query) else listHumanWaits(connection, query)
}

/** The workers in the registry. */
public suspend fun Admin.listWorkersSuspend(connection: Connection? = null): List<WorkerInfo> =
  blocking {
    if (connection == null) listWorkers() else listWorkers(connection)
  }

/** Pauses or resumes the worker [workerId], or returns `null` when it is not in the registry. */
public suspend fun Admin.setWorkerPausedSuspend(
  workerId: String,
  paused: Boolean,
  audit: AdminAudit,
  connection: Connection? = null,
): WorkerPauseResult? = blocking {
  (if (connection == null) setWorkerPaused(workerId, paused, audit)
    else setWorkerPaused(connection, workerId, paused, audit))
    .orElse(null)
}

/** Pauses the queue [queue]. */
public suspend fun Admin.pauseQueueSuspend(
  queue: String,
  audit: AdminAudit,
  connection: Connection? = null,
): Unit = blocking {
  if (connection == null) pauseQueue(queue, audit) else pauseQueue(connection, queue, audit)
}

/** Resumes the queue [queue]. */
public suspend fun Admin.resumeQueueSuspend(
  queue: String,
  audit: AdminAudit,
  connection: Connection? = null,
): Unit = blocking {
  if (connection == null) resumeQueue(queue, audit) else resumeQueue(connection, queue, audit)
}

/** Purges the queue [queue], and returns how many tasks the purge deleted or canceled. */
public suspend fun Admin.purgeQueueSuspend(
  queue: String,
  audit: AdminAudit,
  connection: Connection? = null,
): Long = blocking {
  if (connection == null) purgeQueue(queue, audit) else purgeQueue(connection, queue, audit)
}

/** The task group [groupId], or `null` when it does not exist. */
public suspend fun Admin.getTaskGroupSuspend(
  groupId: UUID,
  connection: Connection? = null,
): TaskGroup? = blocking {
  (if (connection == null) getTaskGroup(groupId) else getTaskGroup(connection, groupId)).orElse(
    null,
  )
}

/** One page of the members of the task group [groupId], after the member sequence [after]. */
public suspend fun Admin.listTaskGroupMembersSuspend(
  groupId: UUID,
  after: Long = 0,
  limit: Int = 100,
  connection: Connection? = null,
): TaskGroupMemberPage = blocking {
  if (connection == null) listTaskGroupMembers(groupId, after, limit)
  else listTaskGroupMembers(connection, groupId, after, limit)
}

/** At most [limit] events of the task group [groupId]. */
public suspend fun Admin.listTaskGroupEventsSuspend(
  groupId: UUID,
  limit: Int = 1000,
  connection: Connection? = null,
): List<TaskGroupEvent> = blocking {
  if (connection == null) listTaskGroupEvents(groupId, limit)
  else listTaskGroupEvents(connection, groupId, limit)
}

/** Cancels the task group [groupId], or returns `null` when it does not exist. */
public suspend fun Admin.cancelTaskGroupSuspend(
  groupId: UUID,
  audit: AdminAudit,
  connection: Connection? = null,
): TaskGroup? = blocking {
  (if (connection == null) cancelTaskGroup(groupId, audit)
    else cancelTaskGroup(connection, groupId, audit))
    .orElse(null)
}

/** At most [limit] task groups whose counters drifted from their members. */
public suspend fun Admin.listTaskGroupDriftSuspend(
  limit: Int = 1000,
  connection: Connection? = null,
): List<TaskGroupDrift> = blocking {
  if (connection == null) listTaskGroupDrift(limit) else listTaskGroupDrift(connection, limit)
}

/** Repairs at most [limit] task groups whose counters drifted from their members. */
public suspend fun Admin.repairTaskGroupDriftSuspend(
  audit: AdminAudit,
  limit: Int = 1000,
  connection: Connection? = null,
): List<TaskGroupRepair> = blocking {
  if (connection == null) repairTaskGroupDrift(audit, limit)
  else repairTaskGroupDrift(connection, audit, limit)
}
