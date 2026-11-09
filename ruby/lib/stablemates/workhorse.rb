# frozen_string_literal: true

require "digest"
require "json"
require "logger"
require "monitor"
require "securerandom"
require "socket"
require "uri"
require "pg"
require "connection_pool"
require "concurrent"

require_relative "workhorse/version"
require_relative "workhorse/sql_catalogue_generated"
require_relative "workhorse/errors"
require_relative "workhorse/types"
require_relative "workhorse/checkpoint_fingerprint"
require_relative "workhorse/task_group"
require_relative "workhorse/executor"
require_relative "workhorse/active_record_executor"
require_relative "workhorse/compatibility"
require_relative "workhorse/ecma_pattern"
require_relative "workhorse/contracts"
require_relative "workhorse/policies"
require_relative "workhorse/telemetry"
require_relative "workhorse/queue"
require_relative "workhorse/admin"
require_relative "workhorse/dashboard"
require_relative "workhorse/context"
require_relative "workhorse/batch_context"
require_relative "workhorse/worker"
require_relative "workhorse/worker/batch"
require_relative "workhorse/worker/heartbeat"
require_relative "workhorse/worker/listener"
require_relative "workhorse/worker/process"
require_relative "workhorse/worker/statement_watch"
require_relative "workhorse/worker/supervisor"

module Stablemates
  # A PostgreSQL-backed durable task queue. PostgreSQL owns every state transition; this gem
  # submits and controls tasks through protocol functions.
  module Workhorse
    # Naming the Active Job module loads it, and Active Job with it, as a worker script does.
    autoload :ActiveJob, "stablemates/workhorse/active_job"
  end
end

# Rails loads the Active Job adapter when Active Job loads, so the adapter name resolves.
# Without Rails, require "stablemates/workhorse/active_job" after Active Job.
# Below the adapter floor, the hook does not load the adapter, so an application that uses only the
# native API still boots. The hook registers a placeholder instead. Rails instantiates the adapter
# it selects by name, and the placeholder then loads the adapter, which raises LoadError.
if defined?(ActiveSupport.on_load)
  ActiveSupport.on_load(:active_job) do
    if ::ActiveJob.gem_version >= Gem::Version.new("8.1")
      require "stablemates/workhorse/active_job"
    else
      ::ActiveJob::QueueAdapters.const_set(:StablematesWorkhorseAdapter, Class.new do
        def initialize(*) = require("stablemates/workhorse/active_job")
      end)
    end
  end
end
