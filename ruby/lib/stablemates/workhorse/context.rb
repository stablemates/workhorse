# frozen_string_literal: true

module Stablemates
  module Workhorse
    # Tells a handler that its attempt should stop. The worker cancels it; a handler observes it
    # through +cancelled?+, +check!+, or +wait+. +reason+ is one of :requested, :deadline_exceeded,
    # :execution_timeout, :lease_lost, and :shutdown.
    class CancellationToken
      def initialize
        @reason = Concurrent::AtomicReference.new
        @event = Concurrent::Event.new
      end

      def cancelled? = @event.set?

      # The reason the token was cancelled, or nil until then.
      def reason = @reason.get

      # Raises CancelledError once the token is cancelled.
      def check!
        reason = @reason.get
        raise CancelledError.new(reason) unless reason.nil?
      end

      # Blocks until the token is cancelled or +timeout+ seconds pass. Returns true once cancelled.
      def wait(timeout = nil)
        @event.wait(timeout)
        cancelled?
      end

      # Cancels the token with +reason+. Only the first reason sticks; returns whether it did.
      def cancel(reason) # :nodoc:
        return false unless @reason.compare_and_set(nil, reason)

        @event.set
        true
      end
    end

    # Decides one attempt's outcome. The first submission wins, whether it comes from the handler,
    # the heartbeat, or the worker. Internal to the SDK.
    class Arbiter # :nodoc:
      def initialize
        @outcome = Concurrent::AtomicReference.new
      end

      def outcome = @outcome.get

      def submit(outcome) = @outcome.compare_and_set(nil, outcome)
    end

    # What a handler receives beside its payload: the task and its cancellation token.
    class HandlerContext
      # The ClaimedTask this attempt runs.
      attr_reader :task
      # The attempt's CancellationToken.
      attr_reader :cancellation

      def initialize(task:, cancellation:) # :nodoc:
        @task = task
        @cancellation = cancellation
      end
    end
  end
end
