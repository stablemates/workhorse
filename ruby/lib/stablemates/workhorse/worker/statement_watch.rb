# frozen_string_literal: true

module Stablemates
  module Workhorse
    class Worker
      # Calls its block once for each maintenance pass or claim that waits longer than the budget.
      # Internal to the SDK.
      #
      # One thread serves every statement of a worker. It starts with the first statement and ends
      # after it watched nothing for at least one budget, so an idle worker holds no thread and a
      # busy worker starts no thread for each claim. The warning does not end, fail, or delay the statement.
      class StatementWatch # :nodoc:
        def initialize(budget, &warn)
          @budget = budget
          @warn = warn
          @lock = Mutex.new
          @changed = ConditionVariable.new
          # Each statement in flight that has not warned yet: its kind and its start time.
          @watched = {}
          @next_token = 0
          @thread = nil
        end

        # Runs the block under the watch. +statement+ is "maintenance" or "claim". A budget of zero
        # watches nothing, because every statement would warn.
        def watch(statement)
          return yield unless @budget.positive?

          token = @lock.synchronize do
            token = @next_token
            @next_token += 1
            @watched[token] = [statement, monotonic]
            if @thread.nil?
              @thread = Thread.new { run }
              @thread.name = "workhorse-statement-watch"
            elsif @watched.size == 1
              # The thread waits without a statement. A later statement is due later than the
              # earliest one, so only this first one must wake it.
              @changed.signal
            end
            token
          end
          begin
            yield
          ensure
            @lock.synchronize { @watched.delete(token) }
          end
        end

        private

        def run
          loop do
            due = @lock.synchronize do
              now = monotonic
              late, waiting = @watched.partition { |_, (_, started_at)| now - started_at >= @budget }
              late.each { |token, _| @watched.delete(token) }
              if late.empty?
                if waiting.empty?
                  @changed.wait(@lock, @budget)
                  if @watched.empty?
                    @thread = nil
                    return
                  end
                else
                  @changed.wait(@lock, waiting.map { |_, (_, started_at)| started_at + @budget }.min - now)
                end
              end
              late.map { |_, watched| watched }
            end
            # Each record measures its own wait, so a slow log call does not age the next one.
            due.each do |statement, started_at|
              @warn.call(statement, ((monotonic - started_at) * 1000).round)
            rescue
              # A failed log record must not fail the statement or end the watch.
              nil
            end
          end
        end

        def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      end
      private_constant :StatementWatch
    end
  end
end
