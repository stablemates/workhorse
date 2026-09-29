# frozen_string_literal: true

require "json"
require "uri"
require "pg"
require "connection_pool"

require_relative "workhorse/version"
require_relative "workhorse/sql_catalogue_generated"
require_relative "workhorse/errors"
require_relative "workhorse/types"
require_relative "workhorse/executor"
require_relative "workhorse/active_record_executor"
require_relative "workhorse/compatibility"
require_relative "workhorse/ecma_pattern"
require_relative "workhorse/contracts"
require_relative "workhorse/policies"
require_relative "workhorse/queue"

module Stablemates
  # A PostgreSQL-backed durable task queue. PostgreSQL owns every state transition; this gem
  # submits and controls tasks through protocol functions.
  module Workhorse
  end
end
