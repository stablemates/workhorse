# frozen_string_literal: true

class ApplicationJob < ActiveJob::Base
  include Stablemates::Workhorse::ActiveJob::Options

  queue_as { ENV.fetch("WORKHORSE_QUEUE") }

  private

  def record(line) = File.open(ENV.fetch("FIXTURE_OUTPUT"), "a") { |file| file.puts(line) }
end
