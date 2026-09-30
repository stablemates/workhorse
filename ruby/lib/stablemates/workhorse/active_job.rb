# frozen_string_literal: true

require "active_job"
require "stablemates/workhorse" unless defined?(::Stablemates::Workhorse::Worker)

unless ::ActiveJob.gem_version >= Gem::Version.new("8.0")
  raise LoadError, "the Workhorse Active Job adapter requires Active Job 8.0 or later " \
    "(found #{::ActiveJob.gem_version})"
end

module Stablemates
  module Workhorse
    # Runs Active Job jobs on Workhorse. A job class is a default job, which runs under the
    # +active_job+ task type with Active Job's serialization as its payload, or a typed job, which
    # declares its own task type and takes one JSON Hash as its payload. Write +::ActiveJob+ for
    # Rails' module inside this namespace.
    module ActiveJob
      # The task type every default job runs under.
      TASK_TYPE = "active_job"
      JOB_ID_TAG = "active_job_id:"
      CLASS_TAG = "active_job:"
      MAX_OPTION_TAGS = 18
      MAX_TAG_LENGTH = 100
      MAX_TASK_TYPE_BYTES = 256
      OPTION_KEYS = %i[task_type max_attempts tags concurrency_key].freeze
      WORKER_KEY = :stablemates_workhorse_active_job_worker
      private_constant :JOB_ID_TAG, :CLASS_TAG, :MAX_OPTION_TAGS, :MAX_TAG_LENGTH, :MAX_TASK_TYPE_BYTES,
        :OPTION_KEYS, :WORKER_KEY

      # Declares Workhorse options on a job class. Include it and call +workhorse_options+.
      module Options
        def self.included(base)
          base.class_attribute :workhorse_settings, instance_accessor: false, default: {}.freeze
          base.extend(ClassMethods)
        end

        module ClassMethods
          # Sets +task_type+, +max_attempts+, +tags+, or +concurrency_key+. Any other key, or an
          # invalid value, raises ArgumentError. A subclass inherits the options and may extend them.
          def workhorse_options(**options)
            self.workhorse_settings = workhorse_settings.merge(ActiveJob.validate_options(name, options)).freeze
          end
        end

        # A typed job leaves every retry to the Workhorse retry policy, so a second task is refused.
        def retry_job(options = {})
          task_type = self.class.workhorse_settings[:task_type]
          return super if task_type.nil?

          raise ArgumentError, "#{self.class.name} is a typed job for #{task_type}; " \
            "retry_job would enqueue a second task, so its retries belong to the Workhorse retry policy"
        end
      end

      class << self
        # Registers the +active_job+ task type and the task type of each typed class in +jobs+ on
        # +worker+. Raises ArgumentError for a class without a task type and for two classes that
        # declare the same one. Returns +worker+.
        def handle(worker, jobs: [])
          raise ArgumentError, "handle needs a Worker" unless worker.is_a?(Worker)
          raise ArgumentError, "jobs must be an Array of Active Job classes" unless
            jobs.is_a?(Array) && jobs.all? { |job| job.is_a?(Class) && job < ::ActiveJob::Base }

          typed = {}
          jobs.each do |job_class|
            task_type = task_type_of(job_class)
            if task_type.nil?
              raise ArgumentError, "#{job_class.name} declares no task type; a default job runs under " \
                "#{TASK_TYPE} without being listed"
            end
            if typed.key?(task_type)
              raise ArgumentError, "#{typed[task_type].name} and #{job_class.name} both declare task type #{task_type}"
            end

            typed[task_type] = job_class
          end
          admin = Admin.new(worker.executor)
          worker.handle(TASK_TYPE) { |payload, context| running(worker) { run_default(payload, context.task) } }
          typed.each do |task_type, job_class|
            worker.handle(task_type) { |payload, context| running(worker) { run_typed(job_class, payload, context.task, admin) } }
          end
          worker
        end

        # The request that enqueues +job+, or ArgumentError before any statement runs. An invalid
        # priority raises ActiveJob::EnqueueError, which Active Job records on the job.
        def request(job, run_at) # :nodoc:
          settings = settings_of(job.class)
          task_type = settings[:task_type]
          EnqueueRequest.new(
            task_type: task_type || TASK_TYPE,
            payload: task_type.nil? ? job.serialize : typed_payload(job),
            queue: job.queue_name,
            priority: priority(job),
            concurrency_key: concurrency_key(job, settings[:concurrency_key]),
            run_at: run_at,
            max_attempts: settings[:max_attempts],
            tags: tags(job, settings[:tags])
          )
        end

        # The worker running the current job, or nil outside a worker.
        def current_worker = Thread.current[WORKER_KEY] # :nodoc:

        def validate_options(class_name, options) # :nodoc:
          unknown = options.keys - OPTION_KEYS
          raise ArgumentError, "workhorse_options does not accept #{unknown.map(&:inspect).join(", ")}" unless
            unknown.empty?

          options.each { |key, value| validate_option(class_name, key, value) }
          options.dup
        end

        private

        def validate_option(class_name, key, value)
          valid = case key
          when :task_type
            value.is_a?(String) && !value.empty? && value.bytesize <= MAX_TASK_TYPE_BYTES && value != TASK_TYPE
          when :max_attempts then value.is_a?(Integer) && value.between?(1, 100)
          when :tags
            value.is_a?(Array) && value.length <= MAX_OPTION_TAGS &&
              value.all? { |tag| tag.is_a?(String) && tag.length.between?(1, MAX_TAG_LENGTH) }
          when :concurrency_key then (value.is_a?(String) && !value.empty?) || value.respond_to?(:call)
          end
          return if valid

          raise ArgumentError, "#{class_name} workhorse_options #{key}: #{OPTION_RULES.fetch(key)}"
        end

        def settings_of(job_class)
          job_class.respond_to?(:workhorse_settings) ? job_class.workhorse_settings : {}
        end

        def task_type_of(job_class) = settings_of(job_class)[:task_type]

        def typed_payload(job)
          arguments = job.arguments
          unless arguments.length == 1 && arguments.first.is_a?(Hash)
            raise ArgumentError, "#{job.class.name} is a typed job, so it takes exactly one Hash argument"
          end

          Values.check_json(arguments.first, "#{job.class.name} payload")
          arguments.first
        end

        def priority(job)
          priority = job.priority
          return priority if priority.nil? || (priority.is_a?(Integer) && priority.between?(0, 100))

          raise ::ActiveJob::EnqueueError, "#{job.class.name} priority must be nil or an Integer from 0 through 100 " \
            "(found #{priority.inspect}); Workhorse runs higher priorities first"
        end

        def concurrency_key(job, option)
          option.respond_to?(:call) ? option.call(job) : option
        end

        def tags(job, option)
          class_tag = "#{CLASS_TAG}#{job.class.name}"
          adapter_tags = ["#{JOB_ID_TAG}#{job.job_id}"]
          adapter_tags.unshift(class_tag) if class_tag.length <= MAX_TAG_LENGTH
          adapter_tags + (option || [])
        end

        def running(worker)
          previous = Thread.current[WORKER_KEY]
          Thread.current[WORKER_KEY] = worker
          yield
          nil
        ensure
          Thread.current[WORKER_KEY] = previous
        end

        def run_default(payload, task)
          ::ActiveJob::Base.execute(payload.merge("provider_job_id" => task.id))
        end

        # Builds the job from the payload directly, so Active Job's argument decoder never reads a
        # payload another SDK wrote. +perform_now+ counts this execution.
        def run_typed(job_class, payload, task, admin)
          job = job_class.new(payload)
          job.job_id = job_id(task, admin)
          job.provider_job_id = task.id
          job.queue_name = task.queue
          job.priority = task.priority
          job.executions = task.attempt - 1
          ::ActiveJob::Callbacks.run_callbacks(:execute) { job.perform_now }
        end

        # The +active_job_id:+ tag the adapter wrote, or the task ID for a task another SDK enqueued.
        def job_id(task, admin)
          tag = admin.get_task(task.id)&.tags&.find { |candidate| candidate.start_with?(JOB_ID_TAG) }
          tag.nil? ? task.id : tag.delete_prefix(JOB_ID_TAG)
        end
      end

      OPTION_RULES = {
        task_type: "must be a non-empty String of at most #{MAX_TASK_TYPE_BYTES} bytes other than #{TASK_TYPE}",
        max_attempts: "must be an Integer from 1 through 100",
        tags: "must be an Array of at most #{MAX_OPTION_TAGS} Strings of 1 to #{MAX_TAG_LENGTH} characters",
        concurrency_key: "must be a non-empty String or respond to call"
      }.freeze
      private_constant :OPTION_RULES
    end
  end
end

module ActiveJob
  module QueueAdapters
    # Enqueues Active Job jobs as Workhorse tasks. Select it with +:stablemates_workhorse+, or pass
    # an instance built over an executor. Without one, it enqueues through Active Record, so an
    # enqueue commits and rolls back with the caller's transaction.
    class StablematesWorkhorseAdapter < ::ActiveJob::QueueAdapters::AbstractAdapter
      def initialize(executor = nil)
        super()
        @executor = executor
        @lock = Mutex.new
      end

      def enqueue(job) = enqueue_one(job, nil)

      def enqueue_at(job, timestamp) = enqueue_one(job, Time.at(timestamp))

      # Enqueues +jobs+ in atomic chunks of the shared batch limit and returns how many it enqueued.
      # A job with an invalid priority records the error and is skipped.
      def enqueue_all(jobs)
        pending = jobs.filter_map do |job|
          [job, workhorse.request(job, job.scheduled_at && Time.at(job.scheduled_at.to_f))]
        rescue ::ActiveJob::EnqueueError => e
          job.enqueue_error = e
          job.successfully_enqueued = false
          nil
        end
        pending.each_slice(::Stablemates::Workhorse::SqlCatalogue::MAX_ENQUEUE_BATCH_SIZE) do |chunk|
          results = queue.enqueue_many(chunk.map(&:last))
          chunk.zip(results) do |(job, _request), result|
            job.provider_job_id = result.task_id
            job.successfully_enqueued = true
          end
        end
        pending.length
      end

      # Whether the worker running the current job has begun to stop. Continuations check it.
      def stopping?(_job = nil)
        worker = workhorse.current_worker
        !worker.nil? && worker.stopping?
      end

      private

      def workhorse = ::Stablemates::Workhorse::ActiveJob

      def enqueue_one(job, run_at)
        job.provider_job_id = queue.enqueue_many([workhorse.request(job, run_at)]).first.task_id
      end

      def queue
        @queue || @lock.synchronize do
          @queue ||= ::Stablemates::Workhorse::Queue.new(
            @executor || ::Stablemates::Workhorse::ActiveRecordExecutor.new(::ActiveRecord::Base)
          )
        end
      end
    end
  end
end
