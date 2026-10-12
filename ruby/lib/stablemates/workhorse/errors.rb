# frozen_string_literal: true

module Stablemates
  module Workhorse
    # The root of every error the SDK raises. Callers rescue a category, not one class per
    # primitive, and an invalid argument raises Ruby's own ArgumentError instead.
    class Error < StandardError; end

    # PostgreSQL and this client cannot work together. +code+ is one of :schema_not_installed,
    # :schema_too_old, :schema_too_new, :client_protocol_too_old, and :client_protocol_too_new.
    class CompatibilityError < Error
      attr_reader :code

      def initialize(code)
        @code = code
        super("workhorse compatibility check refused: #{code.to_s.tr("_", "-")}")
      end
    end

    # A durable call returned +stale+: another attempt owns the task now.
    class LeaseLostError < Error
      attr_reader :task_id, :operation

      def initialize(task_id, operation)
        @task_id = task_id
        @operation = operation
        super("#{operation} lost the lease for task #{task_id}")
      end
    end

    # The base of the named-primitive refusals, which carry an +operation+ and a +name+.
    class NamedOperationError < Error
      attr_reader :operation, :name

      def initialize(operation, name, message)
        @operation = operation
        @name = name
        super("#{operation} #{name} #{message}")
      end
    end

    # A named primitive received a different request under its retained identity.
    class ConflictError < NamedOperationError
      def initialize(operation, name, stored_name: nil)
        @stored_name = stored_name
        super(operation, name, conflict_message(name))
      end

      private

      def conflict_message(name)
        return "conflicts with a different retained request" unless @stored_name && @stored_name != name

        "conflicts: stored child #{@stored_name.inspect}, requested child #{name.inspect}"
      end
    end

    # A checkpoint call gave an input whose fingerprint differs from the stored fingerprint, or from
    # the fingerprint of an overlapping call with the same name (ADR 0098). The block does not run.
    # The worker fails the task at once, as for every ConflictError.
    class CheckpointInputConflictError < ConflictError
      attr_reader :stored_fingerprint, :requested_fingerprint

      def initialize(name, stored_fingerprint, requested_fingerprint)
        @stored_fingerprint = stored_fingerprint
        @requested_fingerprint = requested_fingerprint
        super(:checkpoint, name)
      end

      private

      def conflict_message(_name)
        "input conflicts: stored fingerprint #{@stored_fingerprint}, requested fingerprint #{@requested_fingerprint}"
      end
    end

    # A named primitive exceeded its limit.
    class LimitExceededError < NamedOperationError
      def initialize(operation, name) = super(operation, name, "exceeded its limit")
    end

    # A wait with the same name is already open.
    class AlreadyWaitingError < NamedOperationError
      def initialize(operation, name) = super(operation, name, "is already waiting")
    end

    # A child result exceeds the parent's byte limit.
    class ChildResultLimitExceededError < Error
      attr_reader :result_bytes, :limit_bytes

      def initialize(result_bytes, limit_bytes)
        @result_bytes = result_bytes
        @limit_bytes = limit_bytes
        super("child result of #{result_bytes} bytes exceeds the #{limit_bytes} byte limit")
      end
    end

    # Progress was written too often. +retry_after+ is a count of seconds.
    class ProgressRateLimitedError < Error
      attr_reader :retry_after

      def initialize(retry_after)
        @retry_after = retry_after
        super("progress is rate limited; retry after #{retry_after} seconds")
      end
    end

    # The base of PostgreSQL's diagnosed enqueue refusals. +details+ is PostgreSQL's JSON detail,
    # decoded into a Hash with String keys.
    class DiagnosedError < Error
      attr_reader :details

      def initialize(details, message)
        @details = details
        super(message)
      end
    end

    # SQLSTATE P1001: a retained idempotency key received a materially different request.
    class EnqueueIdempotencyConflictError < DiagnosedError
      def initialize(details) = super(details, "PostgreSQL rejected a materially different idempotent enqueue")
    end

    # SQLSTATE P1002: a retained redrive request ID received a different source task.
    class RedriveIdempotencyConflictError < DiagnosedError
      def initialize(details) = super(details, "PostgreSQL rejected a materially different idempotent redrive")
    end

    # SQLSTATE P1003: the dependency would close a cycle.
    class DependencyCycleError < DiagnosedError
      def initialize(details) = super(details, "PostgreSQL rejected a cyclic task dependency")
    end

    # SQLSTATE P1005: a dependency limit was reached.
    class DependencyLimitExceededError < DiagnosedError
      def initialize(details) = super(details, "PostgreSQL rejected a task dependency limit")
    end

    # SQLSTATE P1006: a retained purge request ID received a different queue.
    class PurgeIdempotencyConflictError < DiagnosedError
      def initialize(details) = super(details, "PostgreSQL rejected a materially different idempotent queue purge")
    end

    # SQLSTATE P1008: the task group does not accept tasks. +reason+ is :sealed, :finished,
    # :canceled, or :not_running_member.
    class TaskGroupClosedError < DiagnosedError
      def initialize(details)
        super(details, "Task group #{details.fetch("groupId", "unknown")} does not accept tasks " \
          "(#{details.fetch("reason", "unknown")})")
      end

      def group_id = details["groupId"]

      def state = details["state"]&.to_sym

      def reason = details["reason"]&.to_sym
    end

    # SQLSTATE P1009: an add would take the task group above its member limit.
    class TaskGroupLimitExceededError < DiagnosedError
      def initialize(details)
        super(details, "Task group #{details.fetch("groupId", "unknown")} holds #{details.fetch("total", 0)} " \
          "tasks and accepts at most #{details.fetch("limit", TaskGroups::MAX_MEMBERS)}")
      end

      def group_id = details["groupId"]

      def limit = details["limit"]

      def total = details["total"]

      def requested = details["requested"]
    end

    # SQLSTATE P1010: enqueue idempotency returned a task that is not a member of the task group.
    # +member_of+ is the group the existing task belongs to, or nil.
    class TaskGroupMembershipConflictError < DiagnosedError
      def initialize(details)
        super(details, "Enqueue idempotency returned task #{details.fetch("taskId", "unknown")}, which is not a " \
          "member of task group #{details.fetch("groupId", "unknown")}")
      end

      def group_id = details["groupId"]

      def task_id = details["taskId"]

      def ordinal = details["ordinal"]

      def member_of = details["memberOf"]
    end

    # SQLSTATE P1007: a request and a queue's tier disagree (ADR 0077). +ordinal+ is the 1-based
    # position of the rejected request in an enqueue batch, or nil.
    class FastTierUnsupportedError < Error
      attr_reader :queue, :feature, :ordinal

      def initialize(queue, feature, ordinal)
        @queue = queue
        @feature = feature
        @ordinal = ordinal
        super("Fast-tier queue #{queue} does not support #{feature}")
      end
    end

    # A payload or a result does not satisfy its task type's contract version. +part+ names which.
    class ContractValidationError < Error
      attr_reader :task_type, :version, :part

      def initialize(task_type, version, part = "payload")
        @task_type = task_type
        @version = version
        @part = part
        super("#{task_type} #{part} does not satisfy contract version #{version}")
      end
    end

    # A task value exceeds its byte limit, measured as the UTF-8 length of PostgreSQL's +jsonb+
    # text. +part+ names the value; the worker raises it for a handler's result.
    class ValueSizeLimitError < Error
      attr_reader :task_type, :part, :actual_bytes, :max_bytes

      def initialize(task_type, part, actual_bytes, max_bytes)
        @task_type = task_type
        @part = part
        @actual_bytes = actual_bytes
        @max_bytes = max_bytes
        super("#{task_type} #{part} exceeds its configured size limit")
      end
    end

    # A contract version the request names is not installed.
    class ContractUnavailableError < Error
      attr_reader :task_type, :version

      def initialize(task_type, version)
        @task_type = task_type
        @version = version
        super("#{task_type} contract version #{version} is unavailable")
      end
    end

    # Contracts changed again while the client retried an enqueue with reloaded contracts.
    class ContractPolicyChangedError < Error
      def initialize = super("contract policy changed again while retrying enqueue")
    end

    # A retained signal idempotency key received a different request.
    class SignalIdempotencyConflictError < Error
      attr_reader :task_id, :name

      def initialize(task_id, name)
        @task_id = task_id
        @name = name
        super("signal #{name} for task #{task_id} received a different request for a retained idempotency key")
      end
    end

    # A retained human wait idempotency key received a different completion.
    class HumanWaitIdempotencyConflictError < Error
      attr_reader :task_id, :name

      def initialize(task_id, name)
        @task_id = task_id
        @name = name
        super("human wait #{name} for task #{task_id} received a different completion " \
              "for a retained idempotency key")
      end
    end

    # PostgreSQL returned a status this SDK does not know. An unknown status is never a success.
    class UnexpectedStatusError < Error
      attr_reader :operation, :status

      def initialize(operation, status)
        @operation = operation
        @status = status
        super("#{operation} returned unexpected status #{status.inspect}")
      end
    end

    # A handler observed its cancellation through +check!+.
    class CancelledError < Error
      attr_reader :reason

      def initialize(reason)
        @reason = reason
        super("task cancelled: #{reason}")
      end
    end

    # The shutdown grace elapsed while handlers were still running.
    class ShutdownIncompleteError < Error
      attr_reader :abandoned

      def initialize(abandoned)
        @abandoned = abandoned
        super("shutdown grace elapsed with #{abandoned} tasks still running")
      end
    end

    # Any other PG::Error. The original is the +cause+, and +sqlstate+ is its SQLSTATE or nil.
    class DatabaseError < Error
      attr_reader :sqlstate

      def initialize(message, sqlstate)
        @sqlstate = sqlstate
        super(message)
      end
    end
  end
end
