# frozen_string_literal: true

module Stablemates
  module Workhorse
    # Runs +processes+ worker processes and returns after every one has exited.
    #
    # Call it after the application is loaded. Each child is forked from the caller, runs the block
    # to build its own Worker and connection pool, and runs that worker with +run_worker_process+.
    # A child that exits while the supervisor is not stopping is restarted.
    #
    # TERM or INT is forwarded to every child. Children that have not exited +shutdown_grace+
    # seconds later are killed. A second signal is forwarded again, so the children exit at once.
    def self.run_worker_processes(processes:, shutdown_grace: 25, &build_worker)
      raise ArgumentError, "processes must be an Integer from 1 to 64" unless
        processes.is_a?(Integer) && (1..64).cover?(processes)
      raise ArgumentError, "run_worker_processes needs a block that builds a Worker" if build_worker.nil?
      raise NotImplementedError, "run_worker_processes needs Process.fork" unless Supervisor.fork_supported?

      grace = Values.milliseconds(shutdown_grace, "shutdown_grace", 0..86_400_000) / 1000.0
      Supervisor.new(processes, grace, build_worker).run
    end

    # Forks, watches, and restarts worker processes. Internal to the SDK.
    class Supervisor # :nodoc:
      TICK = 0.1
      # A child that lived shorter than this is restarted after the same delay, so a worker that
      # fails at boot does not fork in a tight loop.
      RESTART_DELAY = 1.0
      private_constant :TICK, :RESTART_DELAY

      def self.fork_supported? = Process.respond_to?(:fork)

      def initialize(processes, grace, build_worker)
        @processes = processes
        @grace = grace
        @build_worker = build_worker
        @children = {}
        @restarts = []
        @deadline = nil
      end

      def run
        SignalRelay.open(PROCESS_SIGNALS) do |relay|
          @relay = relay
          @processes.times { spawn }
          until @deadline && @children.empty?
            IO.select([relay.reader], nil, nil, TICK)
            while (signo = relay.poll)
              forward(signo)
            end
            reap
            restart_due unless @deadline
            kill_overdue if @deadline
          end
        end
        nil
      ensure
        @children.each_key { |pid| signal("KILL", pid) }
        @children.each_key { |pid| wait(pid) }
      end

      private

      def spawn
        pid = Process.fork { child }
        @children[pid] = monotonic
      end

      # Never returns. +exit!+ skips the at_exit handlers and finalizers the child inherited, so
      # the child cannot close connections that belong to the parent.
      def child
        @relay.close
        status = 1
        begin
          worker = @build_worker.call
          raise TypeError, "run_worker_processes block must return a Worker" unless worker.is_a?(Worker)

          Workhorse.run_worker_process(worker)
        rescue SystemExit => e
          status = e.status
        rescue Exception => e # standard:disable Lint/RescueException
          warn("#{e.class}: #{e.message}")
        end
        $stdout.flush
        $stderr.flush
        Kernel.exit!(status)
      end

      def forward(signo)
        @deadline ||= monotonic + @grace
        @restarts.clear
        @children.each_key { |pid| signal(signo, pid) }
      end

      # Waits only for supervised PIDs, so another child of the application keeps its exit status.
      def reap
        @children.keys.each do |pid|
          reaped = begin
            Process.wait(pid, Process::WNOHANG)
          rescue Errno::ECHILD
            pid
          end
          next if reaped.nil?

          started = @children.delete(pid)
          next if @deadline

          delay = (monotonic - started < RESTART_DELAY) ? RESTART_DELAY : 0
          @restarts << monotonic + delay
        end
      end

      def restart_due
        now = monotonic
        due, @restarts = @restarts.partition { |at| at <= now }
        due.each { spawn }
      end

      def kill_overdue
        return if monotonic < @deadline

        @children.each_key { |pid| signal("KILL", pid) }
      end

      def signal(signal, pid)
        Process.kill(signal, pid)
      rescue Errno::ESRCH
        nil
      end

      def wait(pid)
        Process.wait(pid)
      rescue Errno::ECHILD
        nil
      end

      def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end
  end
end
