# frozen_string_literal: true

require "rails"
require "active_record/railtie"
require "active_job/railtie"
require "stablemates/workhorse"

# The smallest Rails application that runs Active Job on Workhorse. Active Record reads
# DATABASE_URL, and the jobs write what they ran to FIXTURE_OUTPUT.
module FixtureApp
  class Application < Rails::Application
    config.load_defaults "8.0"
    config.root = File.expand_path("..", __dir__)
    config.eager_load = false
    config.logger = Logger.new(nil)
    config.secret_key_base = "fixture"
    config.active_job.queue_adapter = :stablemates_workhorse
  end
end
