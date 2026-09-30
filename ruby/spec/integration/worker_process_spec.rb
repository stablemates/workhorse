# frozen_string_literal: true

require "connection_pool"

RSpec.describe "Worker processes against PostgreSQL" do
  include_context "with a scratch database"

  before do
    @url = ScratchDatabase.url
    @reader, @writer = IO.pipe
    @forked = []
  end

  after do
    @forked.each do |pid|
      Process.kill("KILL", pid)
    rescue Errno::ESRCH
      nil
    end
    @forked.each do |pid|
      Process.wait(pid)
    rescue Errno::ECHILD
      nil
    end
    @reader.close
    @writer.close unless @writer.closed?
  end

  # Builds a worker in a forked process. Each handler run and each worker start reports a line.
  def build_worker(**options)
    pool = ConnectionPool.new(size: 4, timeout: 5) { PG.connect(@url) }
    writer = @writer
    W::Worker.new(pool, queues: [@queue_name], polling_only: true, poll_interval: 0.01, disable_registry: true,
      **options).tap do |worker|
      worker.handle("slow") do |payload, _context|
        report(writer, "running #{Process.pid}")
        sleep(payload.fetch("seconds"))
        {"pid" => Process.pid}
      end
      report(writer, "started #{Process.pid}")
    end
  end

  # Builds a worker whose child side reports the stop a signal requested and a drain that returned.
  def build_reporting_worker(**options)
    writer = @writer
    build_worker(**options).tap do |worker|
      worker.define_singleton_method(:stop) do
        writer.puts("stop #{Process.pid}")
        writer.flush
        super()
      end
      worker.define_singleton_method(:run_from) do |version|
        super(version).tap do
          writer.puts("drained #{Process.pid}")
          writer.flush
        end
      end
    end
  end

  # Waits until +pid+ has exited but is not yet reaped.
  def wait_zombie(pid, timeout = 5)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    until File.read("/proc/#{pid}/stat").split[2] == "Z"
      raise "process #{pid} did not exit within #{timeout}s" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

      sleep(0.01)
    end
  end

  def report(writer, line)
    writer.puts(line)
    writer.flush
  end

  def fork_process(&block)
    pid = Process.fork do
      @reader.close
      block.call
      Kernel.exit!(0)
    rescue SystemExit => e
      Kernel.exit!(e.status)
    rescue Exception => e # standard:disable Lint/RescueException
      warn("#{e.class}: #{e.message}")
      Kernel.exit!(99)
    end
    @forked << pid
    pid
  end

  def next_line(timeout = 10)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    loop do
      line = @reader.read_nonblock(4096, exception: false)
      return consume(line) if line.is_a?(String)

      remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
      raise "no line from the worker processes within #{timeout}s" if remaining <= 0

      IO.select([@reader], nil, nil, remaining)
    end
  end

  # Keeps whole lines in order even when one read returns several.
  def consume(chunk)
    (@lines ||= []).concat(chunk.lines(chomp: true))
    @lines.shift
  end

  def read_line(timeout = 10) = @lines&.any? ? @lines.shift : next_line(timeout)

  def wait_status(pid, timeout = 15)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    loop do
      waited, status = Process.wait2(pid, Process::WNOHANG)
      if waited
        @forked.delete(pid)
        return status
      end
      raise "process #{pid} did not exit within #{timeout}s" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

      sleep(0.02)
    end
  end

  def alive?(pid)
    Process.kill(0, pid)
    true
  rescue Errno::ESRCH
    false
  end

  def state(task_id)
    @connection.exec_params("SELECT COALESCE(outcome.state, runtime.state) AS state
      FROM workhorse.task task
      LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
      LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
     WHERE task.id = $1", [task_id]).getvalue(0, 0)
  end

  describe "run_worker_process" do
    it "drains the running handler on TERM and exits 0" do
      task_id = queue.enqueue("slow", {"seconds" => 0.5}).task_id
      pid = fork_process { W.run_worker_process(build_worker) }
      expect(read_line).to start_with("started")
      expect(read_line).to eq("running #{pid}")
      Process.kill("TERM", pid)
      status = wait_status(pid)
      expect(status.exitstatus).to eq(0)
      expect(state(task_id)).to eq("succeeded")
    end

    it "exits at once with 128 plus the signal number on a second signal" do
      queue.enqueue("slow", {"seconds" => 30})
      pid = fork_process { W.run_worker_process(build_worker(shutdown_grace: 60)) }
      read_line
      expect(read_line).to eq("running #{pid}")
      Process.kill("INT", pid)
      sleep(0.2)
      expect(alive?(pid)).to be(true)
      Process.kill("INT", pid)
      expect(wait_status(pid, 5).exitstatus).to eq(128 + Signal.list.fetch("INT"))
    end

    it "exits 1 and names the error when the run fails" do
      pid = fork_process do
        worker = build_worker
        worker.define_singleton_method(:run_from) { |_version| raise "boom" }
        W.run_worker_process(worker)
      end
      read_line
      expect(wait_status(pid).exitstatus).to eq(1)
    end
  end

  describe "run_worker_processes" do
    it "rejects a process count outside 1 to 64 and a missing block" do
      expect { W.run_worker_processes(processes: 0) { nil } }.to raise_error(ArgumentError, /1 to 64/)
      expect { W.run_worker_processes(processes: 65) { nil } }.to raise_error(ArgumentError, /1 to 64/)
      expect { W.run_worker_processes(processes: 2) }.to raise_error(ArgumentError, /block/)
    end

    it "raises NotImplementedError where fork is unavailable" do
      allow(W::Supervisor).to receive(:fork_supported?).and_return(false)
      expect { W.run_worker_processes(processes: 1) { nil } }.to raise_error(NotImplementedError)
    end

    it "runs every child, restarts one killed externally, and exits after TERM" do
      supervisor = fork_process { W.run_worker_processes(processes: 3, shutdown_grace: 10) { build_worker } }
      children = Array.new(3) { read_line.split.last.to_i }
      expect(children.uniq.size).to eq(3)

      Process.kill("KILL", children.first)
      replacement = read_line(15).split.last.to_i
      expect(children).not_to include(replacement)
      expect(alive?(replacement)).to be(true)

      task_id = queue.enqueue("slow", {"seconds" => 0.5}).task_id
      runner = read_line.split.last.to_i
      Process.kill("TERM", supervisor)
      expect(wait_status(supervisor).exitstatus).to eq(0)
      expect(state(task_id)).to eq("succeeded")
      expect([*children.drop(1), replacement, runner].none? { |pid| alive?(pid) }).to be(true)
    end

    %w[TERM INT].each do |name|
      it "forwards #{name} so each child stops, drains, and exits before the deadline" do
        task_id = queue.enqueue("slow", {"seconds" => 0.5}).task_id
        supervisor = fork_process do
          W.run_worker_processes(processes: 1, shutdown_grace: 10) { build_reporting_worker(shutdown_grace: 60) }
        end
        child = read_line.split.last.to_i
        expect(read_line).to eq("running #{child}")
        started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        Process.kill(name, supervisor)

        expect([read_line, read_line]).to eq(["stop #{child}", "drained #{child}"])
        expect(wait_status(supervisor).exitstatus).to eq(0)
        expect(Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).to be < 5
        expect(state(task_id)).to eq("succeeded")
        expect(alive?(child)).to be(false)
      end
    end

    it "kills a child that outlasts shutdown_grace" do
      queue.enqueue("slow", {"seconds" => 30})
      supervisor = fork_process do
        W.run_worker_processes(processes: 1, shutdown_grace: 0.3) { build_reporting_worker(shutdown_grace: 60) }
      end
      child = read_line.split.last.to_i
      expect(read_line).to eq("running #{child}")
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      Process.kill("INT", supervisor)

      expect(read_line).to eq("stop #{child}")
      expect(wait_status(supervisor).exitstatus).to eq(0)
      expect(Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).to be < 5
      expect(alive?(child)).to be(false)
      expect(@lines.to_a + [@reader.read_nonblock(4096, exception: false)].grep(String)).to be_empty
    end

    it "reaps only its own children, so another child of the application keeps its status" do
      unrelated = Process.fork { Kernel.exit!(7) }
      tracked = Process.fork { Kernel.exit!(0) }
      [unrelated, tracked].each { |pid| wait_zombie(pid) }
      supervisor = W::Supervisor.new(1, 1.0, -> {})
      supervisor.instance_variable_set(:@children, {tracked => 0.0})
      supervisor.instance_variable_set(:@deadline, 0.0)

      supervisor.send(:reap)

      expect(supervisor.instance_variable_get(:@children)).to be_empty
      expect(Process.wait2(unrelated).last.exitstatus).to eq(7)
    ensure
      [unrelated, tracked].compact.each do |pid|
        Process.wait(pid, Process::WNOHANG)
      rescue Errno::ECHILD
        nil
      end
    end
  end
end
