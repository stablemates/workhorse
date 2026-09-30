# frozen_string_literal: true

module Stablemates
  module Workhorse
    # Signals a worker process handles. The first stops the worker; a second exits at once.
    PROCESS_SIGNALS = %w[TERM INT].freeze
    private_constant :PROCESS_SIGNALS

    # Runs +worker+ as the whole process and exits when it returns.
    #
    # TERM or INT stops the worker, which drains its handlers within +shutdown_grace+, and the
    # process exits 0. A second signal exits at once with status 128 plus the signal number. An
    # error that ends the run exits 1 after its message is written to standard error. The method
    # never returns.
    def self.run_worker_process(worker)
      raise ArgumentError, "run_worker_process needs a Worker" unless worker.is_a?(Worker)

      version = worker.send(:stop_version)
      SignalRelay.open(PROCESS_SIGNALS) do |relay|
        relay.start do |signo, count|
          (count == 1) ? worker.stop : Kernel.exit!(128 + signo)
        end
        worker.send(:run_from, version)
      end
      Kernel.exit(0)
    rescue SystemExit
      raise
    rescue Exception => e # standard:disable Lint/RescueException
      warn("#{e.class}: #{e.message}")
      Kernel.exit(1)
    end

    # Moves signals out of trap context, which cannot take a lock, onto a thread through a pipe.
    # Internal to the SDK.
    class SignalRelay # :nodoc:
      def self.open(signals)
        relay = new(signals)
        begin
          yield relay
        ensure
          relay.close
        end
      end

      attr_reader :reader

      def initialize(signals)
        @reader, @writer = IO.pipe
        @previous = signals.to_h do |name|
          number = Signal.list.fetch(name)
          [name, Signal.trap(name) { @writer.write_nonblock(number.chr, exception: false) }]
        end
      end

      # Yields each signal number and its running count on a relay thread.
      def start(&block)
        @thread = Thread.new do
          count = 0
          while (byte = next_signal)
            count += 1
            block.call(byte.ord, count)
          end
        end
        @thread.name = "workhorse-signals"
        @thread.report_on_exception = false
      end

      # Reads one pending signal without waiting, or returns nil.
      def poll = @reader.read_nonblock(1, exception: false).then { |byte| byte.is_a?(String) ? byte.ord : nil }

      def close
        @previous&.each { |name, handler| Signal.trap(name, handler || "DEFAULT") }
        @previous = nil
        @writer.close unless @writer.closed?
        @thread&.join(1)
        @reader.close unless @reader.closed?
      end

      private

      def next_signal
        @reader.read(1)
      rescue IOError
        nil
      end
    end
  end
end
