# frozen_string_literal: true

module Stablemates
  module Workhorse
    # What a batch handler receives beside the payloads: the member tasks and one cancellation
    # token. It offers no API that suspends a task, because one invocation runs every member.
    class BatchHandlerContext
      # The ClaimedTask of each member, in the order of the payloads.
      attr_reader :tasks
      # A CancellationToken that the first member cancellation cancels, with that member's reason.
      attr_reader :cancellation

      def initialize(tasks:, cancellation:) # :nodoc:
        @tasks = tasks
        @cancellation = cancellation
      end
    end
  end
end
