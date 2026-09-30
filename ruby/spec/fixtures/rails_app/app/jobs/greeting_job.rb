# frozen_string_literal: true

# A default job, which runs under the active_job task type.
class GreetingJob < ApplicationJob
  def perform(name) = record("default #{name}")
end
