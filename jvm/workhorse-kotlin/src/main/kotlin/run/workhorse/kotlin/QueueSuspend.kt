// The suspend wrappers of `Queue`. Each public Java method family has one wrapper. A `connection`
// argument runs the call inside the caller's transaction, as the Java overload that takes a
// `Connection` does; `null` lets the core take a connection from its source. Each wrapper runs in
// `client`: a call with no `connection` on a thread in a Spring transaction scope runs on that
// thread, with no interrupt, so it joins the Spring transaction. Every other call runs on a virtual
// thread in `runInterruptible`, so a cancellation interrupts that thread. An interrupt closes the
// socket of a JDBC read on a virtual thread, and the caller's connection is not usable after a
// cancelled call.
@file:JvmName("QueueSuspend")

package run.workhorse.kotlin

import java.sql.Connection
import java.util.UUID
import run.workhorse.Budget
import run.workhorse.BudgetDefinition
import run.workhorse.CancelResult
import run.workhorse.ConcurrencyPolicy
import run.workhorse.ConcurrencyPolicyDefinition
import run.workhorse.EnqueueOptions
import run.workhorse.EnqueueRequest
import run.workhorse.EnqueueResult
import run.workhorse.HumanWaitCompletionResult
import run.workhorse.Queue
import run.workhorse.QueueHealth
import run.workhorse.RateLimitPolicy
import run.workhorse.RateLimitPolicyDefinition
import run.workhorse.ScheduleDefinition
import run.workhorse.SignalDeliveryResult
import run.workhorse.TaskGroup
import run.workhorse.TaskGroupBlockResult
import run.workhorse.TaskGroupBuilder
import run.workhorse.TaskGroupCallbacks
import run.workhorse.TaskGroupLink
import run.workhorse.TaskGroupMemberPage
import run.workhorse.TaskTypeContracts

/** Checks that the database schema is compatible with this SDK. */
public suspend fun Queue.assertCompatibleSuspend(connection: Connection? = null): Unit =
  client(connection) {
    if (connection == null) assertCompatible() else assertCompatible(connection)
  }

/** Enqueues one task of [taskType] with [payload], a JSON value. */
public suspend fun Queue.enqueueSuspend(
  taskType: String,
  payload: Any?,
  options: EnqueueOptions = EnqueueOptions.defaults(),
  connection: Connection? = null,
): EnqueueResult =
  client(connection) {
    if (connection == null) enqueue(taskType, payload, options)
    else enqueue(connection, taskType, payload, options)
  }

/** Enqueues [requests] together, and returns one result for each request, in order. */
public suspend fun Queue.enqueueManySuspend(
  requests: List<EnqueueRequest>,
  connection: Connection? = null,
): List<EnqueueResult> =
  client(connection) {
    if (connection == null) enqueueMany(requests) else enqueueMany(connection, requests)
  }

/** Creates an open task group with [callbacks]. */
public suspend fun Queue.createTaskGroupSuspend(
  callbacks: TaskGroupCallbacks,
  connection: Connection? = null,
): TaskGroup =
  client(connection) {
    if (connection == null) createTaskGroup(callbacks) else createTaskGroup(connection, callbacks)
  }

/**
 * Creates a task group with [callbacks], adds the members that [block] declares, and seals it in
 * one transaction. [block] runs on the thread of the Java call.
 */
public suspend fun Queue.taskGroupSuspend(
  callbacks: TaskGroupCallbacks,
  connection: Connection? = null,
  block: TaskGroupBuilder.() -> Unit,
): TaskGroupBlockResult =
  client(connection) {
    if (connection == null) taskGroup(callbacks) { it.block() }
    else taskGroup(connection, callbacks) { it.block() }
  }

/** Adds [requests] to the open task group [groupId]. */
public suspend fun Queue.addToTaskGroupSuspend(
  groupId: UUID,
  requests: List<EnqueueRequest>,
  connection: Connection? = null,
): List<EnqueueResult> =
  client(connection) {
    if (connection == null) addToTaskGroup(groupId, requests)
    else addToTaskGroup(connection, groupId, requests)
  }

/** Seals the task group [groupId], so that it accepts no more members. */
public suspend fun Queue.sealTaskGroupSuspend(
  groupId: UUID,
  connection: Connection? = null,
): TaskGroup =
  client(connection) {
    if (connection == null) sealTaskGroup(groupId) else sealTaskGroup(connection, groupId)
  }

/** The task group [groupId], or `null` when it does not exist. */
public suspend fun Queue.getTaskGroupSuspend(
  groupId: UUID,
  connection: Connection? = null,
): TaskGroup? =
  client(connection) {
    (if (connection == null) getTaskGroup(groupId) else getTaskGroup(connection, groupId)).orElse(
      null,
    )
  }

/** One page of the members of the task group [groupId], after the member sequence [after]. */
public suspend fun Queue.listTaskGroupMembersSuspend(
  groupId: UUID,
  after: Long = 0,
  limit: Int = 100,
  connection: Connection? = null,
): TaskGroupMemberPage =
  client(connection) {
    if (connection == null) listTaskGroupMembers(groupId, after, limit)
    else listTaskGroupMembers(connection, groupId, after, limit)
  }

/** The task group link of the task [taskId], or `null` when the task is in no group. */
public suspend fun Queue.findTaskGroupSuspend(
  taskId: UUID,
  connection: Connection? = null,
): TaskGroupLink? =
  client(connection) {
    (if (connection == null) findTaskGroup(taskId) else findTaskGroup(connection, taskId)).orElse(
      null,
    )
  }

/** Requests the cancellation of the task [taskId]. */
public suspend fun Queue.cancelSuspend(
  taskId: UUID,
  requestedBy: String? = null,
  reason: String? = null,
  connection: Connection? = null,
): CancelResult =
  client(connection) {
    if (connection == null) cancel(taskId, requestedBy, reason)
    else cancel(connection, taskId, requestedBy, reason)
  }

/** Delivers the signal [name] with [payload] to the task [taskId]. */
public suspend fun Queue.sendSignalSuspend(
  taskId: UUID,
  name: String,
  payload: Any?,
  idempotencyKey: String,
  requestedBy: String,
  connection: Connection? = null,
): SignalDeliveryResult =
  client(connection) {
    if (connection == null) sendSignal(taskId, name, payload, idempotencyKey, requestedBy)
    else sendSignal(connection, taskId, name, payload, idempotencyKey, requestedBy)
  }

/** Records the decision [result] for the human wait [name] of the task [taskId]. */
public suspend fun Queue.completeHumanWaitSuspend(
  taskId: UUID,
  name: String,
  result: Any?,
  idempotencyKey: String,
  requestedBy: String,
  connection: Connection? = null,
): HumanWaitCompletionResult =
  client(connection) {
    if (connection == null) completeHumanWait(taskId, name, result, idempotencyKey, requestedBy)
    else completeHumanWait(connection, taskId, name, result, idempotencyKey, requestedBy)
  }

/** The health snapshot of the queues. */
public suspend fun Queue.healthSuspend(connection: Connection? = null): QueueHealth =
  client(connection) {
    if (connection == null) health() else health(connection)
  }

/** Syncs the [schedules] of [namespace]. With [prune], it removes the namespace's others. */
public suspend fun Queue.syncSchedulesSuspend(
  namespace: String,
  schedules: List<ScheduleDefinition>,
  prune: Boolean = true,
  connection: Connection? = null,
): Unit =
  client(connection) {
    if (connection == null) syncSchedules(namespace, schedules, prune)
    else syncSchedules(connection, namespace, schedules, prune)
  }

/** Syncs the payload contracts of each task type in [contracts]. */
public suspend fun Queue.syncContractsSuspend(
  contracts: Map<String, TaskTypeContracts>,
  connection: Connection? = null,
): Unit =
  client(connection) {
    if (connection == null) syncContracts(contracts) else syncContracts(connection, contracts)
  }

/** Syncs the concurrency policies of [namespace]. With [prune], it removes the others. */
public suspend fun Queue.syncConcurrencyPoliciesSuspend(
  namespace: String,
  definitions: List<ConcurrencyPolicyDefinition>,
  prune: Boolean = true,
  connection: Connection? = null,
): List<ConcurrencyPolicy> =
  client(connection) {
    if (connection == null) syncConcurrencyPolicies(namespace, definitions, prune)
    else syncConcurrencyPolicies(connection, namespace, definitions, prune)
  }

/** Syncs the rate limit policies of [namespace]. With [prune], it removes the others. */
public suspend fun Queue.syncRateLimitPoliciesSuspend(
  namespace: String,
  definitions: List<RateLimitPolicyDefinition>,
  prune: Boolean = true,
  connection: Connection? = null,
): List<RateLimitPolicy> =
  client(connection) {
    if (connection == null) syncRateLimitPolicies(namespace, definitions, prune)
    else syncRateLimitPolicies(connection, namespace, definitions, prune)
  }

/** Syncs the budgets of [namespace]. With [prune], it removes the others. */
public suspend fun Queue.syncBudgetsSuspend(
  namespace: String,
  definitions: List<BudgetDefinition>,
  prune: Boolean = true,
  connection: Connection? = null,
): List<Budget> =
  client(connection) {
    if (connection == null) syncBudgets(namespace, definitions, prune)
    else syncBudgets(connection, namespace, definitions, prune)
  }

/** The concurrency policies of [queues], or of every queue when [queues] is `null`. */
public suspend fun Queue.listConcurrencyPoliciesSuspend(
  queues: List<String>? = null,
  connection: Connection? = null,
): List<ConcurrencyPolicy> =
  client(connection) {
    if (connection == null) listConcurrencyPolicies(queues)
    else listConcurrencyPolicies(connection, queues)
  }

/** The rate limit policies of [queues], or of every queue when [queues] is `null`. */
public suspend fun Queue.listRateLimitPoliciesSuspend(
  queues: List<String>? = null,
  connection: Connection? = null,
): List<RateLimitPolicy> =
  client(connection) {
    if (connection == null) listRateLimitPolicies(queues)
    else listRateLimitPolicies(connection, queues)
  }

/** The budgets named in [names], or every budget when [names] is `null`. */
public suspend fun Queue.listBudgetsSuspend(
  names: List<String>? = null,
  connection: Connection? = null,
): List<Budget> =
  client(connection) {
    if (connection == null) listBudgets(names) else listBudgets(connection, names)
  }
