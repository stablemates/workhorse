# frozen_string_literal: true

module Stablemates
  module Workhorse
    # The counts of a task group. +pending+ is the number of member tasks that are not finished.
    TaskGroupCounts = Data.define(:total, :succeeded, :failed, :canceled, :pending)

    # A requested callback of a task group. +kind+ is :on_finish, :on_success, or :on_failure.
    # +task_id+ is nil until the group finishes, and stays nil for the callback that the result
    # does not select.
    TaskGroupCallback = Data.define(:kind, :task_id)

    # A set of full-tier tasks that Workhorse tracks as one unit (ADR 0095). +state+ is :open,
    # :sealed, or :finished. +result+ is :succeeded or :failed when the group is finished, and nil
    # before. +callbacks+ is an Array of TaskGroupCallback.
    TaskGroup = Data.define(
      :id, :state, :result, :counts, :created_at, :sealed_at, :finished_at, :canceled_at, :canceled_by,
      :cancel_reason, :callbacks
    )

    # One member task. +position+ is the one-based order in which the task joined its group.
    # +queue+, +type+, and +state+ are nil after a purge or retention deletes the task. +outcome+ is
    # the outcome the group counted, :succeeded, :failed, or :canceled, or nil while the member is
    # pending.
    TaskGroupMember = Data.define(:position, :task_id, :queue, :type, :state, :outcome, :added_at, :counted_at)

    # One page of member tasks. Pass +next_after+ as +after:+ to read the next page. It is nil on
    # the last page.
    TaskGroupMemberPage = Data.define(:members, :next_after)

    # The group of a running task. +role+ is :member or :callback. +callback+ is the kind of
    # callback for a callback task, and nil for a member task.
    TaskGroupLink = Data.define(:role, :callback, :group)

    # One history event of a task group. +type+ is :created, :sealed, :canceled, :finished,
    # :callback_enqueued, :callback_failed, or :counter_repaired.
    TaskGroupEvent = Data.define(:id, :type, :details, :occurred_at)

    # What the block form of Queue#task_group returns: the sealed group and one EnqueueResult for
    # each added request, in order.
    TaskGroupBlockResult = Data.define(:group, :tasks)

    # A group that is not finished and whose counters disagree with its member outcomes, or a
    # sealed group with no pending member. +recorded+ holds the counters of the group row, with a
    # nil +pending+. +counted+ holds the counts the member outcomes give. +action+ is :recounted or
    # :finished.
    TaskGroupDrift = Data.define(:group_id, :state, :recorded, :counted, :action)

    # What a repair did to one group. +action+ is :recounted or :finished.
    TaskGroupRepair = Data.define(:group_id, :recorded_pending, :pending, :action)

    # Collects the member tasks of the block form of Queue#task_group. Nothing is enqueued until the
    # block returns: the queue then creates, adds, and seals the group in one statement. An Active
    # Job enqueued through the Workhorse adapter inside the block joins the group.
    class TaskGroupBuilder
      KEY = :stablemates_workhorse_task_group_builder
      private_constant :KEY

      # The builder of the innermost block form that runs in this fiber, or nil.
      def self.current = Thread.current[KEY] # :nodoc:

      def initialize # :nodoc:
        @requests = []
        @hooks = []
      end

      # Adds +requests+, an Array of at most 1,000 EnqueueRequest, to the group. A request cannot
      # use debounce or throttle.
      def add(requests)
        TaskGroups.validate_add(requests)
        if @requests.length + requests.length > TaskGroups::MAX_MEMBERS
          raise ArgumentError, "a task group holds at most #{TaskGroups::MAX_MEMBERS} tasks"
        end

        @requests.concat(requests)
        @hooks.concat(Array.new(requests.length))
        nil
      end

      # Adds one task. It takes the arguments Queue#enqueue takes.
      def enqueue(task_type, payload, **)
        add([EnqueueRequest.new(task_type: task_type, payload: payload, **)])
      end

      # Adds +request+ and calls +hook+ with its EnqueueResult after the group is created.
      def add_request(request, &hook) # :nodoc:
        add([request])
        @hooks[-1] = hook
        nil
      end

      def requests = @requests.dup # :nodoc:

      # Makes this builder the current one while the block runs.
      def collect # :nodoc:
        previous = Thread.current[KEY]
        Thread.current[KEY] = self
        yield self
      ensure
        Thread.current[KEY] = previous
      end

      def created(results) # :nodoc:
        @hooks.zip(results) { |hook, result| hook&.call(result) }
      end
    end

    # Decodes the rows of the task group statements. Internal to the SDK.
    module TaskGroups # :nodoc:
      MAX_MEMBERS = 100_000
      MAX_PAGE_SIZE = 1000
      MAX_DRIFT_LIMIT = 10_000
      STATES = %i[open sealed finished].freeze
      RESULTS = %i[succeeded failed].freeze
      OUTCOMES = %i[succeeded failed canceled].freeze
      TASK_STATES = %i[blocked scheduled ready active succeeded failed canceled].freeze
      ROLES = %i[member callback].freeze
      ACTIONS = %i[recounted finished].freeze
      EVENT_TYPES = %i[created sealed canceled finished callback_enqueued callback_failed counter_repaired].freeze
      # The callback kinds in the order a group enqueues them, by their wire names.
      CALLBACK_KINDS = {"on_finish" => :on_finish, "on_success" => :on_success, "on_failure" => :on_failure}.freeze
      # The keys create_task_group_v1 takes for the callback requests.
      CALLBACK_KEYS = {on_finish: "onFinish", on_success: "onSuccess", on_failure: "onFailure"}.freeze

      module_function

      # Raises ArgumentError for an add that PostgreSQL would refuse.
      def validate_add(requests)
        raise ArgumentError, "requests must be an Array of EnqueueRequest" unless
          requests.is_a?(Array) && requests.all?(EnqueueRequest)
        raise ArgumentError, "a task group add accepts at most #{SqlCatalogue::MAX_ENQUEUE_BATCH_SIZE} tasks" if
          requests.length > SqlCatalogue::MAX_ENQUEUE_BATCH_SIZE
        raise ArgumentError, "a task group add cannot use debounce or throttle" if
          requests.any? { |request| request.debounce || request.throttle }
      end

      def group_id(value) = Values.task_id(value, "task group ID")

      def limit(value, maximum, label)
        raise ArgumentError, "#{label} must be an Integer between 1 and #{maximum}" unless
          value.is_a?(Integer) && value.between?(1, maximum)

        value
      end

      def group(row)
        callbacks = Values.parse_json(row.fetch("callbacks")) || {}
        TaskGroup.new(
          id: row.fetch("group_id"),
          state: symbol(:task_group_state, row.fetch("state"), STATES),
          result: row.fetch("result") && symbol(:task_group_result, row.fetch("result"), RESULTS),
          counts: TaskGroupCounts.new(**counts(row, %w[total succeeded failed canceled pending])),
          created_at: Values.parse_time(row.fetch("created_at")),
          sealed_at: Values.parse_time(row.fetch("sealed_at")),
          finished_at: Values.parse_time(row.fetch("finished_at")),
          canceled_at: Values.parse_time(row.fetch("canceled_at")),
          canceled_by: row.fetch("canceled_by"),
          cancel_reason: row.fetch("cancel_reason"),
          callbacks: CALLBACK_KINDS.filter_map do |name, kind|
            callbacks.key?(name) && TaskGroupCallback.new(kind: kind, task_id: callbacks.fetch(name)&.fetch("taskId"))
          end
        )
      end

      def link(row)
        kind = row.fetch("callback_kind")
        TaskGroupLink.new(
          role: symbol(:task_group_role, row.fetch("role"), ROLES),
          callback: kind && CALLBACK_KINDS.fetch(kind) { raise UnexpectedStatusError.new(:task_group_callback, kind) },
          group: group(row)
        )
      end

      def member_page(rows, limit)
        members = rows.map do |row|
          state = row.fetch("state")
          outcome = row.fetch("outcome")
          TaskGroupMember.new(
            position: Values.parse_integer(row.fetch("position")),
            task_id: row.fetch("task_id"),
            queue: row.fetch("queue_name"),
            type: row.fetch("task_type"),
            state: state && symbol(:task_group_member_state, state, TASK_STATES),
            outcome: outcome && symbol(:task_group_member_outcome, outcome, OUTCOMES),
            added_at: Values.parse_time(row.fetch("added_at")),
            counted_at: Values.parse_time(row.fetch("counted_at"))
          )
        end
        TaskGroupMemberPage.new(members: members, next_after: (members.length == limit) ? members.last.position : nil)
      end

      def event(row)
        TaskGroupEvent.new(
          id: row.fetch("event_id"),
          type: symbol(:task_group_event, row.fetch("event_type"), EVENT_TYPES),
          details: Values.parse_json(row.fetch("details")),
          occurred_at: Values.parse_time(row.fetch("occurred_at"))
        )
      end

      def drift(row)
        recorded = counts(row, %w[recorded_total recorded_succeeded recorded_failed recorded_canceled])
        TaskGroupDrift.new(
          group_id: row.fetch("group_id"),
          state: symbol(:task_group_state, row.fetch("state"), STATES),
          recorded: TaskGroupCounts.new(**recorded.transform_keys { |key| key.to_s.delete_prefix("recorded_").to_sym },
            pending: nil),
          counted: TaskGroupCounts.new(**counts(row, %w[total succeeded failed canceled pending])),
          action: symbol(:task_group_repair, row.fetch("action"), ACTIONS)
        )
      end

      def repair(row)
        TaskGroupRepair.new(
          group_id: row.fetch("group_id"),
          recorded_pending: Values.parse_integer(row.fetch("recorded_pending")),
          pending: Values.parse_integer(row.fetch("pending")),
          action: symbol(:task_group_repair, row.fetch("action"), ACTIONS)
        )
      end

      def counts(row, columns) = columns.to_h { |column| [column.to_sym, Values.parse_integer(row.fetch(column))] }

      def symbol(operation, text, known)
        value = text.to_sym
        raise UnexpectedStatusError.new(operation, text) unless known.include?(value)

        value
      end
    end
  end
end
