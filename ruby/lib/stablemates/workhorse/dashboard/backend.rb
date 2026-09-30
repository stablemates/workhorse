# frozen_string_literal: true

module Stablemates
  module Workhorse
    class Dashboard
      # Answers each dashboard/v1 procedure with the PostgreSQL function that owns it. Internal to
      # the SDK.
      class Backend
        # How long one health document serves nearby reads, in seconds. It matches the other hosts'
        # queue health readers, so every backend agrees on staleness.
        QUEUE_HEALTH_TTL = 3.0
        PREVIEW_CAP = 10_000
        RETENTION_SETTINGS = %w[
          taskIdentityRetentionDays terminalOutcomeRetentionDays taskEventRetentionDays
          attemptHistoryRetentionDays scheduleOccurrenceRetentionDays statisticsRetentionDays
        ].freeze
        PREVIEW_COUNTS = {
          "terminalTasks" => "terminal_tasks", "taskEvents" => "task_events",
          "attemptHistory" => "attempt_history", "scheduleOccurrences" => "schedule_occurrences",
          "statistics" => "statistics"
        }.freeze
        MAINTENANCE_SETTINGS = %w[
          timezone partitionPreparationIntervalMs terminalCleanupIntervalMs historyRetentionLocalTime
          statisticsRollupIntervalMs statisticsGroupLimit statisticsRecomputeBuckets
        ].freeze
        private_constant :QUEUE_HEALTH_TTL, :PREVIEW_CAP, :RETENTION_SETTINGS, :PREVIEW_COUNTS,
          :MAINTENANCE_SETTINGS

        def initialize(executor, environment:, configured_workers:, maintenance_loops:, read_only:)
          @executor = executor
          @admin = Admin.new(executor)
          @environment = environment
          @configured_workers = configured_workers.dup.freeze
          @maintenance_loops = maintenance_loops.dup.freeze
          @read_only = read_only
          @health_lock = Mutex.new
          @health = nil
        end

        # Procedure name to a callable that takes (input, actor).
        def procedures
          {
            "meta" => method(:meta), "taskCounts" => method(:task_counts), "tasks" => method(:tasks),
            "tasksCursor" => method(:tasks_cursor), "activity" => method(:activity),
            "taskFacets" => method(:task_facets), "queues" => method(:queues), "cron" => method(:cron),
            "workers" => method(:workers), "humanWaits" => method(:human_waits), "events" => method(:events),
            "eventDetail" => method(:event_detail), "taskDetail" => method(:task_detail),
            "checkpointValue" => method(:checkpoint_value), "taskValue" => method(:task_value),
            "settings" => method(:settings), "system" => method(:system),
            "previewRetentionPolicy" => method(:preview_retention_policy),
            "setQueuePaused" => method(:set_queue_paused), "purgeQueue" => method(:purge_queue),
            "setWorkerPaused" => method(:set_worker_paused),
            "overrideMaintenancePolicy" => method(:override_maintenance_policy),
            "revertMaintenancePolicy" => method(:revert_maintenance_policy),
            "overrideRetentionPolicy" => method(:override_retention_policy),
            "revertRetentionPolicy" => method(:revert_retention_policy),
            "runTaskNow" => method(:run_task_now), "cancelTask" => method(:cancel_task),
            "signalTask" => method(:signal_task), "completeHumanWait" => method(:complete_human_wait),
            "redriveTask" => method(:redrive_task), "redriveDeadLetters" => method(:redrive_dead_letters)
          }
        end

        def meta(_input, _actor) = {"environment" => @environment}

        def task_counts(_input, _actor) = result(SqlCatalogue::DASHBOARD_TASK_COUNTS_V1)

        def tasks(input, _actor)
          query = {
            "filter" => "all", "queue" => nil, "page" => 1, "worker" => nil, "taskType" => nil,
            "priority" => nil, "sort" => "updated", "tags" => [], "search" => nil, "pageSize" => 50,
            "count" => "none"
          }.merge(input, "canCompleteHumanWait" => !@read_only)
          result(SqlCatalogue::DASHBOARD_TASKS_V1, query)
        end

        def tasks_cursor(input, _actor)
          result(SqlCatalogue::DASHBOARD_TASKS_CURSOR_V1, input.merge("canCompleteHumanWait" => !@read_only))
        end

        def activity(input, _actor) = result(SqlCatalogue::DASHBOARD_ACTIVITY_V1, input)

        def task_facets(_input, _actor)
          result(SqlCatalogue::DASHBOARD_TASK_FACETS_V1, {"configuredWorkers" => @configured_workers})
        end

        def queues(_input, _actor) = result(SqlCatalogue::DASHBOARD_QUEUES_V1)

        def workers(_input, _actor)
          result(SqlCatalogue::DASHBOARD_WORKERS_V1,
            {"configuredWorkers" => @configured_workers, "canManageWorkers" => !@read_only})
        end

        def human_waits(_input, _actor)
          result(SqlCatalogue::DASHBOARD_HUMAN_WAITS_V1,
            {"canComplete" => !@read_only, "canSignal" => !@read_only, "health" => queue_health})
        end

        def events(input, _actor) = result(SqlCatalogue::DASHBOARD_EVENTS_V1, input)

        def event_detail(input, _actor)
          found(result(SqlCatalogue::DASHBOARD_EVENT_DETAIL_V1, input), "Event not found")
        end

        def task_detail(input, _actor)
          query = input.merge("canSignal" => !@read_only, "canCompleteHumanWait" => !@read_only,
            "health" => queue_health)
          found(result(SqlCatalogue::DASHBOARD_TASK_DETAIL_V1, query), "Task not found")
        end

        # Task detail withholds a large checkpoint value and reports its size, so an operator opens
        # that one value here.
        def checkpoint_value(input, _actor)
          found(result(SqlCatalogue::DASHBOARD_CHECKPOINT_VALUE_V1, input), "Checkpoint not found")
        end

        # Task detail withholds a large payload or result and reports its size, so an operator
        # opens that one value here.
        def task_value(input, _actor)
          found(result(SqlCatalogue::DASHBOARD_TASK_VALUE_V1, input), "Task not found")
        end

        def settings(_input, _actor)
          result(SqlCatalogue::DASHBOARD_SETTINGS_V1, {"writable" => !@read_only, "settingsController" => true})
        end

        def system(input, _actor) = result(SqlCatalogue::DASHBOARD_SYSTEM_V1, input)

        def cron(_input, _actor)
          result(SqlCatalogue::DASHBOARD_CRON_V1, {"maintenanceLoops" => @maintenance_loops})
        end

        def preview_retention_policy(input, _actor)
          definition = input.fetch("definition")
          current = one(@executor.rows(SqlCatalogue::GET_RETENTION_POLICY_V1), "get_retention_policy_v1")
          days = RETENTION_SETTINGS.map do |name|
            value = definition.fetch(name) { current.fetch(snake(name)) }
            value&.to_s
          end
          counts = one(@executor.rows(SqlCatalogue::RETENTION_POLICY_PREVIEW, days), "retention_policy_preview")
          sampled = PREVIEW_COUNTS.transform_values { |column| Values.parse_integer(counts.fetch(column)) }
          {
            "eligible" => sampled.transform_values { |count| [count, PREVIEW_CAP].min },
            "capped" => sampled.transform_values { |count| count > PREVIEW_CAP }
          }
        end

        def set_queue_paused(input, actor)
          paused = input.fetch("paused")
          audit = audit(input, actor)
          if paused
            @admin.pause_queue(input.fetch("queue"), audit: audit)
          else
            @admin.resume_queue(input.fetch("queue"), audit: audit)
          end
          {"paused" => paused}
        end

        def purge_queue(input, actor)
          {"deletedCount" => @admin.purge_queue(input.fetch("queue"), audit: audit(input, actor))}
        end

        def set_worker_paused(input, actor)
          result = @admin.set_worker_paused(input.fetch("workerId"), input.fetch("paused"),
            audit: audit(input, actor))
          raise RpcError.not_found("Worker not found") if result.nil?

          {"paused" => result.paused}
        end

        def override_maintenance_policy(input, _actor)
          definition = input.fetch("definition")
          @executor.rows(SqlCatalogue::OVERRIDE_MAINTENANCE_POLICY_V1,
            MAINTENANCE_SETTINGS.map { |name| definition[name]&.to_s })
          nil
        end

        def revert_maintenance_policy(input, _actor)
          revert(SqlCatalogue::REVERT_MAINTENANCE_POLICY_V1, input)
        end

        def override_retention_policy(input, _actor)
          overrides = input.fetch("definition").transform_keys { |name| snake(name) }
          @executor.rows(SqlCatalogue::OVERRIDE_RETENTION_POLICY_V1, [Values.json(overrides, "definition")])
          nil
        end

        def revert_retention_policy(input, _actor)
          revert(SqlCatalogue::REVERT_RETENTION_POLICY_V1, input)
        end

        def run_task_now(input, actor)
          audit = input.fetch("audit")
          row = operation(SqlCatalogue::RUN_TASK_NOW_V1,
            [input.fetch("id"), actor, audit["reason"], audit["requestId"]])
          {"status" => row.fetch("status"), "id" => input.fetch("id"), "state" => row.fetch("state"),
           "runAt" => iso(row.fetch("run_at"))}
        end

        def cancel_task(input, actor)
          row = operation(SqlCatalogue::CANCEL_V1, [input.fetch("id"), actor, input.fetch("audit")["reason"]])
          {
            "status" => row.fetch("status"), "taskId" => input.fetch("id"), "state" => row.fetch("state"),
            "currentAttempt" => Values.parse_integer(row.fetch("current_attempt")),
            "requestedAt" => iso(row.fetch("requested_at")), "requestedBy" => row.fetch("requested_by"),
            "reason" => row.fetch("reason"), "finishedAt" => iso(row.fetch("finished_at"))
          }
        end

        def signal_task(input, actor)
          row = operation(SqlCatalogue::SEND_SIGNAL_V1, [
            input.fetch("id"), input.fetch("name"), Values.json(input.fetch("payload"), "payload"),
            input.fetch("idempotencyKey"), actor
          ])
          {
            "status" => row.fetch("status"), "taskId" => input.fetch("id"), "name" => input.fetch("name"),
            "payload" => Values.parse_json(row.fetch("payload")), "deliveredAt" => iso(row.fetch("delivered_at")),
            "deliveredBy" => row.fetch("delivered_by")
          }
        end

        def complete_human_wait(input, actor)
          row = operation(SqlCatalogue::COMPLETE_HUMAN_WAIT_V1, [
            input.fetch("id"), input.fetch("name"), Values.json(input.fetch("result"), "result"),
            input.fetch("idempotencyKey"), actor
          ])
          {
            "status" => row.fetch("status"), "taskId" => input.fetch("id"), "name" => input.fetch("name"),
            "result" => Values.parse_json(row.fetch("result")), "completedAt" => iso(row.fetch("completed_at")),
            "completedBy" => row.fetch("completed_by")
          }
        end

        def redrive_task(input, actor)
          result = @admin.redrive(input.fetch("id"), audit: audit(input, actor))
          raise RpcError.not_found("Task not found") if result.status == :not_found

          redrive_result(result)
        end

        def redrive_dead_letters(input, actor)
          cursor = input["cursor"]
          page = @admin.redrive_many(
            audit: audit(input, actor),
            limit: input.fetch("limit", 100),
            cursor: cursor && DeadLetterCursor.new(cursor.fetch("finishedAt"), cursor.fetch("taskId")),
            queue: input["queue"], type: input["taskType"], tags: input["tags"] || []
          )
          next_cursor = page.next_cursor
          {
            "results" => page.results.map { |result| redrive_result(result) },
            "nextCursor" => next_cursor && {"finishedAt" => next_cursor.finished_at, "taskId" => next_cursor.task_id}
          }
        end

        private

        # The parsed +result+ column of a dashboard function, or nil when PostgreSQL returned null.
        def result(sql, document = nil)
          params = document.nil? ? [] : [Values.json(document, "dashboard input")]
          Values.parse_json(one(@executor.rows(sql, params), sql[/workhorse\.(\w+)/, 1]).fetch("result"))
        end

        # The raw queue_health_v1() document, shared for QUEUE_HEALTH_TTL.
        #
        # One dashboard page reads it from several procedures, and each accepts it as its +health+
        # input, so the page pays for one pass over live queue state. The lock serialises concurrent
        # misses, and a failed read is never cached.
        def queue_health
          @health_lock.synchronize do
            now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
            return @health.last if @health && @health.first > now

            document = Values.parse_json(one(@executor.rows("SELECT workhorse.queue_health_v1() AS result"),
              "queue_health_v1").fetch("result"))
            @health = [Process.clock_gettime(Process::CLOCK_MONOTONIC) + QUEUE_HEALTH_TTL, document]
            document
          end
        end

        def operation(sql, params)
          row = one(@executor.rows(sql, params), sql[/workhorse\.(\w+)/, 1])
          raise RpcError.not_found("Task not found") if row.fetch("status") == "not_found"

          row
        end

        def revert(sql, input)
          settings = input.fetch("settings").map { |name| snake(name) }
          @executor.rows(sql, [Values.text_array(settings, "settings")])
          nil
        end

        def one(rows, label)
          raise DatabaseError.new("#{label} returned #{rows.length} rows; expected one", nil) unless rows.one?

          rows.first
        end

        def found(value, message)
          raise RpcError.not_found(message) if value.nil?

          value
        end

        def audit(input, actor)
          audit = input.fetch("audit")
          AdminAudit.new(actor, audit.fetch("reason"), audit.fetch("requestId"))
        end

        def redrive_result(result)
          {
            "status" => result.status.to_s, "sourceTaskId" => result.source_task_id,
            "targetTaskId" => result.target_task_id, "sourceState" => result.source_state&.to_s,
            "targetState" => result.target_state&.to_s, "requestedAt" => iso(result.requested_at)
          }
        end

        def iso(value)
          value = Values.parse_time(value) if value.is_a?(String)
          value&.getutc&.strftime("%Y-%m-%dT%H:%M:%S.%LZ")
        end

        def snake(name) = name.gsub(/[A-Z]/) { |letter| "_#{letter.downcase}" }
      end
      private_constant :Backend
    end
  end
end
