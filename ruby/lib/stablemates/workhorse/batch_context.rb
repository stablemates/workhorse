# frozen_string_literal: true

module Stablemates
  module Workhorse
    # One member of a batch: its payload and its own BatchHandlerContext.
    BatchHandlerItem = Data.define(:payload, :context)

    # What a batch handler receives for one member. Each call reads or writes only that member's
    # durable state, fenced on its own lease, so a retry replays its checkpoints whatever batch it
    # lands in. It offers no API that suspends a task, because one invocation runs every member.
    class BatchHandlerContext
      def initialize(context) # :nodoc:
        @context = context
      end

      # The member's ClaimedTask.
      def task = @context.task

      # The member's CancellationToken.
      def cancellation = @context.cancellation

      # The TaskCheckpoint named +name+ the member saved, or nil when it saved none.
      def get_checkpoint(name) = @context.get_checkpoint(name)

      # Returns the value the member's checkpoint named +name+ saved, running the block to produce
      # and save it only when no such checkpoint exists.
      def checkpoint(name, &) = @context.checkpoint(name, &)

      # The progress the member reported last, as TaskProgress, or nil.
      def get_progress = @context.get_progress

      # Persists the member's +progress+, a JSON value, and returns the stored TaskProgress.
      def set_progress(progress) = @context.set_progress(progress)
    end
  end
end
