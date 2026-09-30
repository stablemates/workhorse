# frozen_string_literal: true

module Stablemates
  module Workhorse
    # Who asked for an operator control, why, and the request ID that makes a retry idempotent.
    AdminAudit = Data.define(:actor, :reason, :request_id)

    # How a task page projects each payload. +max_bytes+ bounds the included payload.
    TaskPayloadProjection = Data.define(:include, :max_bytes, :redact_keys) do
      def initialize(include: false, max_bytes: 16_384, redact_keys: []) = super
    end

    # Resumes a task page after its last row. The fields are PostgreSQL's text, passed back as-is.
    TaskListCursor = Data.define(:created_at, :task_id, :signature)

    # The prerequisite policy shared by a task's dependency edges.
    DependencyPolicy = Data.define(:on_success, :on_failure, :on_cancellation)

    TaskListItem = Data.define(
      :id, :queue, :type, :concurrency_key, :priority, :tags, :state, :prerequisite_task_id,
      :prerequisite_task_ids, :dependency_policy, :blocked_reason, :parent_task_id, :child_task_ids,
      :current_attempt, :max_attempts, :retry_policy, :deadline_at, :execution_timeout_ms, :run_at,
      :cancel_requested_at, :cancel_requested_by, :cancel_reason, :created_at, :updated_at, :payload,
      :payload_status, :payload_bytes
    )

    TaskListPage = Data.define(:items, :next_cursor)

    # A task's latest progress value and the attempt that wrote it.
    TaskProgress = Data.define(
      :task_id, :value, :revision, :attempt, :fence_token, :worker_id, :created_at, :updated_at
    )

    TaskSnapshot = Data.define(
      :id, :queue, :type, :concurrency_key, :priority, :payload, :contract_version, :tags, :state,
      :prerequisite_task_id, :prerequisite_task_ids, :dependency_policy, :blocked_reason,
      :parent_task_id, :child_task_ids, :current_attempt, :max_attempts, :retry_policy, :deadline_at,
      :execution_timeout_ms, :fence_token, :run_at, :result, :error, :cancel_requested_at,
      :cancel_requested_by, :cancel_reason, :progress, :created_at, :updated_at
    )

    # Resumes a timeline page. +kind+ is :event or :attempt.
    TaskTimelineCursor = Data.define(:task_id, :occurred_at, :kind, :record_id)

    TaskTimelineEvent = Data.define(:record_id, :priority, :attempt, :occurred_at, :event_type, :details) do
      def kind = :event
    end

    TaskTimelineAttempt = Data.define(
      :record_id, :priority, :attempt, :occurred_at, :fence_token, :worker_id, :outcome, :started_at,
      :claimed_at, :finished_at, :error
    ) do
      def kind = :attempt
    end

    TaskTimelinePage = Data.define(:items, :next_cursor)

    # Resumes a dead-letter page or a bulk redrive after its last source task.
    DeadLetterCursor = Data.define(:finished_at, :task_id)

    DeadLetter = Data.define(
      :task_id, :queue, :type, :concurrency_key, :priority, :payload, :tags, :current_attempt,
      :max_attempts, :retry_policy, :deadline_at, :execution_timeout_ms, :error, :finished_at,
      :redrive_count
    )

    DeadLetterPage = Data.define(:items, :next_cursor)

    RedriveResult = Data.define(
      :status, :source_task_id, :target_task_id, :source_state, :target_state, :requested_at
    )

    BulkRedrivePage = Data.define(:results, :next_cursor)

    TaskCheckpoint = Data.define(:task_id, :name, :value, :attempt, :fence_token, :worker_id, :created_at)

    TaskWait = Data.define(
      :task_id, :name, :mode, :duration_ms, :requested_wake_at, :wake_at, :attempt, :fence_token,
      :worker_id, :created_at
    )

    # Resumes a signal or human wait page after its last wait.
    ExternalWaitCursor = Data.define(:created_at, :task_id, :name)

    ExternalWait = Data.define(:task_id, :queue, :task_type, :name, :attempt, :created_at, :deadline_at)

    HumanWait = Data.define(:task_id, :queue, :task_type, :name, :attempt, :created_at, :deadline_at, :context)

    ExternalWaitPage = Data.define(:items, :next_cursor)

    WorkerPauseResult = Data.define(:worker_id, :paused, :paused_by, :reason, :paused_at, :last_heartbeat_at)

    WorkerRegistryEntry = Data.define(
      :worker_id, :paused, :paused_by, :reason, :paused_at, :last_heartbeat_at, :instance_id,
      :hostname, :pid, :queues, :queue, :concurrency, :active_slots, :draining, :started_at
    )

    # Inspects and controls tasks, dead letters, workers, and queues through the executor it holds.
    #
    # Like Queue, every call runs on the connection the executor yields, so a control joins the
    # caller's transaction. Every control takes an AdminAudit that PostgreSQL records.
    class Admin
      MAX_PAGE_SIZE = 1000
      MAX_REDRIVE_BATCH_SIZE = 1000
      MAX_PAYLOAD_BYTES = 1_048_576
      MAX_REDACT_KEYS = 50
      TASK_STATES = %i[blocked scheduled ready active succeeded failed canceled].freeze
      REDRIVE_STATUSES = %i[redriven replayed eligible not_found not_failed].freeze
      private_constant :MAX_PAGE_SIZE, :MAX_REDRIVE_BATCH_SIZE, :MAX_PAYLOAD_BYTES, :MAX_REDACT_KEYS,
        :TASK_STATES, :REDRIVE_STATUSES

      def initialize(executor)
        @executor = Executor.for(executor)
        @lock = Mutex.new
        @compatibility = nil
      end

      # Runs the startup compatibility check once. A refusal is cached; a driver error is not.
      def assert_compatible
        code = @lock.synchronize do
          @compatibility = [Compatibility.evaluate(@executor)] if @compatibility.nil?
          @compatibility.first
        end
        raise CompatibilityError, code if code
      end

      # One page of tasks, newest first.
      def list_tasks(queue: nil, type: nil, states: [], created_after: nil, created_before: nil, limit: 100,
        cursor: nil, payload: TaskPayloadProjection.new)
        filter = task_filter(queue, type, states, created_after, created_before)
        limit(limit, MAX_PAGE_SIZE, "list_tasks limit")
        cursor(cursor, TaskListCursor)
        projection = projection(payload)
        assert_compatible
        rows = @executor.rows(SqlCatalogue::LIST_TASKS, [
          JSON.generate(filter), limit.to_s, cursor&.created_at, cursor&.task_id, cursor&.signature,
          JSON.generate(projection)
        ])
        last = rows.last
        next_cursor = if last && Values.parse_boolean(last.fetch("has_more"))
          TaskListCursor.new(last.fetch("cursor_created_at"), last.fetch("task_id"), last.fetch("cursor_signature"))
        end
        TaskListPage.new(rows.map { |row| task_item(row) }, next_cursor)
      end

      # The task's snapshot, or nil when no such task exists.
      def get_task(task_id)
        task_id = Values.task_id(task_id)
        assert_compatible
        row = @executor.rows(SqlCatalogue::GET_TASK, [task_id]).first
        row && task_snapshot(row)
      end

      # One page of the task's events and attempts, oldest first.
      def get_task_timeline(task_id, limit: 100, cursor: nil)
        task_id = Values.task_id(task_id)
        limit(limit, MAX_PAGE_SIZE, "get_task_timeline limit")
        cursor(cursor, TaskTimelineCursor)
        raise ArgumentError, "cursor task_id must match the requested task_id" if cursor && cursor.task_id != task_id

        assert_compatible
        rows = @executor.rows(SqlCatalogue::LIST_TASK_TIMELINE, [
          task_id, limit.to_s, cursor&.occurred_at, cursor&.kind&.to_s, cursor&.record_id
        ])
        last = rows.last
        next_cursor = if last && Values.parse_boolean(last.fetch("has_more"))
          TaskTimelineCursor.new(task_id, last.fetch("cursor_occurred_at"), last.fetch("kind").to_sym,
            last.fetch("record_id"))
        end
        TaskTimelinePage.new(rows.map { |row| timeline_entry(row) }, next_cursor)
      end

      # One page of failed tasks, most recently finished first.
      def list_dead_letters(limit: 100, cursor: nil, **filter)
        document = dead_letter_filter(**filter)
        limit(limit, MAX_REDRIVE_BATCH_SIZE, "list_dead_letters limit")
        cursor(cursor, DeadLetterCursor)
        assert_compatible
        rows = @executor.rows(SqlCatalogue::LIST_DEAD_LETTERS,
          [document, limit.to_s, cursor&.finished_at, cursor&.task_id])
        last = rows.last
        next_cursor = if last && Values.parse_boolean(last.fetch("has_more"))
          DeadLetterCursor.new(last.fetch("cursor_finished_at"), last.fetch("task_id"))
        end
        DeadLetterPage.new(rows.map { |row| dead_letter(row) }, next_cursor)
      end

      # Enqueues a fresh copy of one failed task. The audit's request ID makes a retry replay.
      def redrive(source_task_id, audit:)
        source_task_id = Values.task_id(source_task_id, "source task ID")
        audit(audit)
        assert_compatible
        rows = @executor.rows(SqlCatalogue::REDRIVE, [source_task_id, audit.actor, audit.reason, audit.request_id])
        raise ArgumentError, "workhorse.redrive_v1 returned #{rows.length} rows; expected one" unless rows.one?

        redrive_result(rows.first)
      end

      # Redrives one page of the failed tasks the filter selects. +dry_run+ reports without changing.
      def redrive_many(audit:, limit: 100, dry_run: false, cursor: nil, **filter)
        document = dead_letter_filter(**filter)
        audit(audit)
        limit(limit, MAX_REDRIVE_BATCH_SIZE, "redrive_many limit")
        raise ArgumentError, "dry_run must be true or false" unless [true, false].include?(dry_run)

        cursor(cursor, DeadLetterCursor)
        assert_compatible
        rows = @executor.rows(SqlCatalogue::REDRIVE_MANY, [
          document, limit.to_s, dry_run.to_s, audit.actor, audit.reason, audit.request_id,
          cursor&.finished_at, cursor&.task_id
        ])
        last = rows.last
        next_cursor = if last && Values.parse_boolean(last.fetch("has_more"))
          DeadLetterCursor.new(last.fetch("source_finished_at_cursor"), last.fetch("source_task_id"))
        end
        BulkRedrivePage.new(rows.map { |row| redrive_result(row) }, next_cursor)
      end

      def get_checkpoint(task_id, name)
        task_id = Values.task_id(task_id)
        name(name)
        assert_compatible
        row = @executor.rows(SqlCatalogue::GET_CHECKPOINT, [task_id, name]).first
        row && checkpoint(row)
      end

      def list_checkpoints(task_id)
        task_id = Values.task_id(task_id)
        assert_compatible
        @executor.rows(SqlCatalogue::LIST_CHECKPOINTS, [task_id]).map { |row| checkpoint(row) }
      end

      def get_progress(task_id)
        task_id = Values.task_id(task_id)
        assert_compatible
        row = @executor.rows(SqlCatalogue::GET_PROGRESS, [task_id]).first
        row && progress(row)
      end

      def get_wait(task_id, name)
        task_id = Values.task_id(task_id)
        name(name)
        assert_compatible
        row = @executor.rows(SqlCatalogue::GET_WAIT, [task_id, name]).first
        row && wait(row)
      end

      def list_waits(task_id)
        task_id = Values.task_id(task_id)
        assert_compatible
        @executor.rows(SqlCatalogue::LIST_WAITS, [task_id]).map { |row| wait(row) }
      end

      # One page of tasks waiting for a signal, oldest first.
      def list_signal_waits(limit: 100, cursor: nil)
        rows = external_wait_rows(SqlCatalogue::LIST_SIGNAL_WAITS, limit, cursor)
        ExternalWaitPage.new(rows.first(limit).map { |row| external_wait(row) }, external_wait_cursor(rows, limit))
      end

      # One page of tasks waiting for a human, oldest first.
      def list_human_waits(limit: 100, cursor: nil)
        rows = external_wait_rows(SqlCatalogue::LIST_HUMAN_WAITS, limit, cursor)
        items = rows.first(limit).map do |row|
          HumanWait.new(**external_wait(row).to_h, context: Values.parse_json(row.fetch("context")))
        end
        ExternalWaitPage.new(items, external_wait_cursor(rows, limit))
      end

      # Every registered worker, most recent heartbeat first.
      def list_workers
        assert_compatible
        @executor.rows(SqlCatalogue::LIST_WORKERS).map { |row| worker(row) }
      end

      # Pauses or resumes one worker. Returns nil when no such worker is registered.
      def set_worker_paused(worker_id, paused, audit:)
        name(worker_id, "worker ID")
        raise ArgumentError, "paused must be true or false" unless [true, false].include?(paused)

        audit(audit)
        assert_compatible
        row = @executor.rows(SqlCatalogue::SET_WORKER_PAUSED,
          [worker_id, paused.to_s, audit.actor, audit.reason, audit.request_id]).first
        row && WorkerPauseResult.new(**worker_pause(row))
      end

      def pause_queue(queue, audit:) = set_queue_paused(queue, true, audit)

      def resume_queue(queue, audit:) = set_queue_paused(queue, false, audit)

      # Deletes every pending task in the queue and returns how many PostgreSQL deleted.
      def purge_queue(queue, audit:)
        name(queue, "queue")
        audit(audit)
        assert_compatible
        rows = @executor.rows(SqlCatalogue::PURGE_QUEUE, [queue, audit.actor, audit.reason, audit.request_id])
        raise ArgumentError, "workhorse.purge_queue_v1 returned #{rows.length} rows; expected one" unless rows.one?

        Values.parse_integer(rows.first.fetch("deleted_count"))
      end

      private

      def set_queue_paused(queue, paused, audit)
        name(queue, "queue")
        audit(audit)
        assert_compatible
        @executor.rows(SqlCatalogue::SET_QUEUE_PAUSED, [queue, paused.to_s, audit.actor, audit.reason, audit.request_id])
        nil
      end

      def audit(audit)
        raise ArgumentError, "audit must be an AdminAudit" unless audit.is_a?(AdminAudit)
        raise ArgumentError, "actor must contain between 1 and 200 characters" unless
          audit.actor.is_a?(String) && audit.actor.length.between?(1, 200)
        raise ArgumentError, "reason must contain between 1 and 2000 characters" unless
          audit.reason.is_a?(String) && audit.reason.length.between?(1, 2000)
        raise ArgumentError, "request_id must contain between 1 and 512 UTF-8 bytes" unless
          audit.request_id.is_a?(String) && audit.request_id.bytesize.between?(1, 512)
      end

      def limit(value, maximum, label)
        raise ArgumentError, "#{label} must be an integer between 1 and #{maximum}" unless
          value.is_a?(Integer) && value.between?(1, maximum)
      end

      def cursor(value, type)
        raise ArgumentError, "cursor must be a #{type.name.split("::").last} or nil" unless value.nil? || value.is_a?(type)
      end

      def name(value, label = "name")
        raise ArgumentError, "#{label} must be a non-empty String" unless value.is_a?(String) && !value.empty?
      end

      def optional_string(value, label)
        raise ArgumentError, "#{label} must be a String or nil" unless value.nil? || value.is_a?(String)
      end

      def optional_time(value, label) = value.nil? ? nil : Values.timestamp(value, label)

      def task_filter(queue, type, states, created_after, created_before)
        optional_string(queue, "queue")
        optional_string(type, "type")
        raise ArgumentError, "states must be an Array" unless states.is_a?(Array)
        raise ArgumentError, "states must be unique" unless states.uniq.length == states.length
        raise ArgumentError, "states contains an invalid task state" unless states.all? { |state| TASK_STATES.include?(state) }

        after = optional_time(created_after, "created_after")
        before = optional_time(created_before, "created_before")
        raise ArgumentError, "created_after must be earlier than created_before" if
          after && before && created_after >= created_before

        filter = {}
        filter["queue"] = queue unless queue.nil?
        filter["type"] = type unless type.nil?
        filter["states"] = states.map(&:to_s) unless states.empty?
        filter["createdAfter"] = after if after
        filter["createdBefore"] = before if before
        filter
      end

      def projection(payload)
        raise ArgumentError, "payload must be a TaskPayloadProjection" unless payload.is_a?(TaskPayloadProjection)
        raise ArgumentError, "payload include must be true or false" unless [true, false].include?(payload.include)
        raise ArgumentError, "payload max_bytes is out of range" unless
          payload.max_bytes.is_a?(Integer) && payload.max_bytes.between?(1, MAX_PAYLOAD_BYTES)

        keys = payload.redact_keys
        raise ArgumentError, "payload redact_keys must be an Array" unless keys.is_a?(Array)
        raise ArgumentError, "payload redact_keys must contain at most #{MAX_REDACT_KEYS} keys" if
          keys.length > MAX_REDACT_KEYS
        raise ArgumentError, "payload redact_keys must be unique" unless keys.uniq.length == keys.length
        raise ArgumentError, "payload redact_keys must contain strings of 1 to 200 characters" unless
          keys.all? { |key| key.is_a?(String) && key.length.between?(1, 200) }

        {"include" => payload.include, "maxBytes" => payload.max_bytes, "redactKeys" => keys}
      end

      def dead_letter_filter(queue: nil, type: nil, tags: [], error_name: nil, finished_after: nil,
        finished_before: nil)
        optional_string(queue, "queue")
        optional_string(type, "type")
        optional_string(error_name, "error_name")
        raise ArgumentError, "tags must be an Array of Strings" unless tags.is_a?(Array) && tags.all?(String)

        filter = {}
        filter["queue"] = queue unless queue.nil?
        filter["type"] = type unless type.nil?
        filter["tags"] = tags unless tags.empty?
        filter["errorName"] = error_name if error_name && !error_name.empty?
        filter["finishedAfter"] = Values.timestamp(finished_after, "finished_after") if finished_after
        filter["finishedBefore"] = Values.timestamp(finished_before, "finished_before") if finished_before
        JSON.generate(filter)
      end

      def external_wait_rows(statement, limit, cursor)
        limit(limit, MAX_PAGE_SIZE, "external wait limit")
        cursor(cursor, ExternalWaitCursor)
        assert_compatible
        @executor.rows(statement, [(limit + 1).to_s, cursor&.created_at, cursor&.task_id, cursor&.name])
      end

      def external_wait_cursor(rows, limit)
        return nil if rows.length <= limit

        last = rows[limit - 1]
        ExternalWaitCursor.new(last.fetch("cursor_created_at"), last.fetch("task_id"), last.fetch("wait_name"))
      end

      def external_wait(row)
        ExternalWait.new(
          task_id: row.fetch("task_id"),
          queue: row.fetch("queue_name"),
          task_type: row.fetch("task_type"),
          name: row.fetch("wait_name"),
          attempt: Values.parse_integer(row.fetch("attempt")),
          created_at: Values.parse_time(row.fetch("created_at")),
          deadline_at: Values.parse_time(row.fetch("deadline_at"))
        )
      end

      # The fields a task list item and a task snapshot share.
      def task_fields(row)
        {
          queue: row.fetch("queue_name"),
          type: row.fetch("task_type"),
          concurrency_key: row.fetch("concurrency_key"),
          priority: Values.parse_integer(row.fetch("priority")),
          tags: Values.parse_text_array(row.fetch("tags")),
          state: state(row.fetch("state")),
          prerequisite_task_id: row.fetch("prerequisite_task_id"),
          prerequisite_task_ids: Values.parse_text_array(row.fetch("prerequisite_task_ids")),
          dependency_policy: dependency_policy(row),
          blocked_reason: row.fetch("blocked_reason")&.to_sym,
          parent_task_id: row.fetch("parent_task_id"),
          child_task_ids: Values.parse_text_array(row.fetch("child_task_ids")),
          current_attempt: Values.parse_integer(row.fetch("current_attempt")),
          max_attempts: Values.parse_integer(row.fetch("max_attempts")),
          retry_policy: Values.parse_json(row.fetch("retry_policy")),
          deadline_at: Values.parse_time(row.fetch("deadline_at")),
          execution_timeout_ms: Values.parse_integer(row.fetch("execution_timeout_ms")),
          run_at: Values.parse_time(row.fetch("run_at")),
          cancel_requested_at: Values.parse_time(row.fetch("cancel_requested_at")),
          cancel_requested_by: row.fetch("cancel_requested_by"),
          cancel_reason: row.fetch("cancel_reason"),
          created_at: Values.parse_time(row.fetch("created_at")),
          updated_at: Values.parse_time(row.fetch("updated_at"))
        }
      end

      def task_item(row)
        TaskListItem.new(
          id: row.fetch("task_id"),
          **task_fields(row),
          payload: Values.parse_json(row.fetch("payload")),
          payload_status: row.fetch("payload_status").to_sym,
          payload_bytes: Values.parse_integer(row.fetch("payload_bytes"))
        )
      end

      def task_snapshot(row)
        progress = unless row.fetch("progress_revision").nil?
          TaskProgress.new(
            task_id: row.fetch("id"),
            value: Values.parse_json(row.fetch("progress_value")),
            revision: Values.parse_integer(row.fetch("progress_revision")),
            attempt: Values.parse_integer(row.fetch("progress_attempt")),
            fence_token: Values.parse_integer(row.fetch("progress_fence_token")),
            worker_id: row.fetch("progress_worker_id"),
            created_at: Values.parse_time(row.fetch("progress_created_at")),
            updated_at: Values.parse_time(row.fetch("progress_updated_at"))
          )
        end
        TaskSnapshot.new(
          id: row.fetch("id"),
          **task_fields(row),
          payload: Values.parse_json(row.fetch("payload")),
          contract_version: row.fetch("contract_version"),
          fence_token: Values.parse_integer(row.fetch("version")),
          result: Values.parse_json(row.fetch("result")),
          error: Values.parse_json(row.fetch("error")),
          progress: progress
        )
      end

      def dependency_policy(row)
        return nil if row.fetch("dependency_on_failure").nil?

        DependencyPolicy.new(
          on_success: row.fetch("dependency_on_success").to_sym,
          on_failure: row.fetch("dependency_on_failure").to_sym,
          on_cancellation: row.fetch("dependency_on_cancellation").to_sym
        )
      end

      def timeline_entry(row)
        common = {
          record_id: row.fetch("record_id"),
          priority: Values.parse_integer(row.fetch("priority")),
          attempt: Values.parse_integer(row.fetch("attempt")),
          occurred_at: Values.parse_time(row.fetch("occurred_at"))
        }
        if row.fetch("kind") == "event"
          return TaskTimelineEvent.new(**common, event_type: row.fetch("event_type"),
            details: Values.parse_json(row.fetch("details")))
        end

        TaskTimelineAttempt.new(
          **common,
          fence_token: Values.parse_integer(row.fetch("fence_token")),
          worker_id: row.fetch("worker_id"),
          outcome: row.fetch("outcome"),
          started_at: Values.parse_time(row.fetch("started_at")),
          claimed_at: Values.parse_time(row.fetch("claimed_at")),
          finished_at: Values.parse_time(row.fetch("finished_at")),
          error: Values.parse_json(row.fetch("error"))
        )
      end

      def dead_letter(row)
        DeadLetter.new(
          task_id: row.fetch("task_id"),
          queue: row.fetch("queue_name"),
          type: row.fetch("task_type"),
          concurrency_key: row.fetch("concurrency_key"),
          priority: Values.parse_integer(row.fetch("priority")),
          payload: Values.parse_json(row.fetch("payload")),
          tags: Values.parse_text_array(row.fetch("tags")),
          current_attempt: Values.parse_integer(row.fetch("current_attempt")),
          max_attempts: Values.parse_integer(row.fetch("max_attempts")),
          retry_policy: Values.parse_json(row.fetch("retry_policy")),
          deadline_at: Values.parse_time(row.fetch("deadline_at")),
          execution_timeout_ms: Values.parse_integer(row.fetch("execution_timeout_ms")),
          error: Values.parse_json(row.fetch("error")),
          finished_at: Values.parse_time(row.fetch("finished_at")),
          redrive_count: Values.parse_integer(row.fetch("redrive_count"))
        )
      end

      def redrive_result(row)
        text = row.fetch("status")
        status = text.to_sym
        raise UnexpectedStatusError.new(:redrive, text) unless REDRIVE_STATUSES.include?(status)

        RedriveResult.new(
          status: status,
          source_task_id: row.fetch("source_task_id"),
          target_task_id: row.fetch("target_task_id"),
          source_state: row.fetch("source_state") && state(row.fetch("source_state")),
          target_state: row.fetch("target_state") && state(row.fetch("target_state")),
          requested_at: Values.parse_time(row.fetch("requested_at"))
        )
      end

      def checkpoint(row)
        TaskCheckpoint.new(
          task_id: row.fetch("task_id"),
          name: row.fetch("checkpoint_name"),
          value: Values.parse_json(row.fetch("checkpoint_value")),
          attempt: Values.parse_integer(row.fetch("attempt")),
          fence_token: Values.parse_integer(row.fetch("fence_token")),
          worker_id: row.fetch("worker_id"),
          created_at: Values.parse_time(row.fetch("created_at"))
        )
      end

      def progress(row)
        TaskProgress.new(
          task_id: row.fetch("task_id"),
          value: Values.parse_json(row.fetch("progress_value")),
          revision: Values.parse_integer(row.fetch("revision")),
          attempt: Values.parse_integer(row.fetch("attempt")),
          fence_token: Values.parse_integer(row.fetch("fence_token")),
          worker_id: row.fetch("worker_id"),
          created_at: Values.parse_time(row.fetch("created_at")),
          updated_at: Values.parse_time(row.fetch("updated_at"))
        )
      end

      def wait(row)
        TaskWait.new(
          task_id: row.fetch("task_id"),
          name: row.fetch("wait_name"),
          mode: row.fetch("mode").to_sym,
          duration_ms: Values.parse_integer(row.fetch("duration_ms")),
          requested_wake_at: Values.parse_time(row.fetch("requested_wake_at")),
          wake_at: Values.parse_time(row.fetch("wake_at")),
          attempt: Values.parse_integer(row.fetch("attempt")),
          fence_token: Values.parse_integer(row.fetch("fence_token")),
          worker_id: row.fetch("worker_id"),
          created_at: Values.parse_time(row.fetch("created_at"))
        )
      end

      def worker_pause(row)
        {
          worker_id: row.fetch("worker_id"),
          paused: Values.parse_boolean(row.fetch("paused")),
          paused_by: row.fetch("paused_by"),
          reason: row.fetch("paused_reason"),
          paused_at: Values.parse_time(row.fetch("paused_at")),
          last_heartbeat_at: Values.parse_time(row.fetch("last_heartbeat_at"))
        }
      end

      def worker(row)
        WorkerRegistryEntry.new(
          **worker_pause(row),
          instance_id: row.fetch("instance_id"),
          hostname: row.fetch("hostname"),
          pid: Values.parse_integer(row.fetch("pid")),
          queues: Values.parse_text_array(row.fetch("queue_names")),
          queue: row.fetch("queue_name"),
          concurrency: Values.parse_integer(row.fetch("concurrency")),
          active_slots: Values.parse_integer(row.fetch("active_slots")),
          draining: Values.parse_boolean(row.fetch("draining")),
          started_at: Values.parse_time(row.fetch("started_at"))
        )
      end

      def state(text)
        value = text.to_sym
        raise UnexpectedStatusError.new(:state, text) unless TASK_STATES.include?(value)

        value
      end
    end
  end
end
