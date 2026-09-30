# frozen_string_literal: true

# A typed job, which declares its own task type.
class TypedGreetingJob < ApplicationJob
  workhorse_options task_type: "fixture.greeting"

  def perform(payload) = record("typed #{payload.fetch("name")}")
end
