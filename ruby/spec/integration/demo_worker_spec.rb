# frozen_string_literal: true

require "connection_pool"
require_relative "../../examples/demo_worker"

# The Ruby worker the demo runs beside its TypeScript, Python, Go, and Rust workers.
#
# The worker names the fixed queues `demo-ruby`, `demo-ruby-fast`, and `demo-shared`, and one example
# drops the schema, so each example runs in a database of its own rather than in the scratch
# database other specs share.
RSpec.describe "Ruby demo worker" do
  demo = WorkhorseDemoWorker
  wait = 15

  def context_for(attempt) = Struct.new(:task).new(Struct.new(:attempt).new(attempt))

  it "serves its own queue, the shared queue, and its fast-tier queue" do
    expect([demo::RUBY_QUEUE, demo::SHARED_QUEUE, demo::RUBY_FAST_QUEUE])
      .to eq(%w[demo-ruby demo-shared demo-ruby-fast])
  end

  it "reads the development primary database" do
    environment = {"DATABASE_URL_PRIMARY" => "postgresql:///dev_primary", "DATABASE_URL" => "postgresql:///ambient"}
    expect(demo.database_url(environment)).to eq("postgresql:///dev_primary")
    expect { demo.database_url({}) }.to raise_error(ArgumentError, /DATABASE_URL_PRIMARY/)
  end

  it "reads the poll interval in milliseconds and keeps the SDK default for zero" do
    expect(demo.poll_interval({})).to eq(15.0)
    expect(demo.poll_interval({"WORKHORSE_WORKER_POLL_MS" => "50"})).to eq(0.05)
    expect(demo.poll_interval({"WORKHORSE_WORKER_POLL_MS" => "0"})).to be_nil
    expect { demo.poll_interval({"WORKHORSE_WORKER_POLL_MS" => "-1"}) }.to raise_error(ArgumentError)
    expect { demo.poll_interval({"WORKHORSE_WORKER_POLL_MS" => "soon"}) }.to raise_error(ArgumentError)
  end

  it "waits for the schema only in the development demo" do
    expect(demo.waits_for_schema?({"WORKHORSE_DEMO_MODE" => "development"})).to be(true)
    expect(demo.waits_for_schema?({"WORKHORSE_DEMO_MODE" => "production"})).to be(false)
    expect(demo.waits_for_schema?({})).to be(false)
    expect { demo.waits_for_schema?({"WORKHORSE_DEMO_MODE" => "staging"}) }
      .to raise_error(ArgumentError, /WORKHORSE_DEMO_MODE/)
  end

  it "identifies the Ruby runtime in its results and refuses another language" do
    expect(demo.language_task({"language" => "ruby"}, context_for(2)))
      .to eq({"language" => "ruby", "runtime" => "ruby", "attempt" => 2})
    expect { demo.language_task({"language" => "go"}, context_for(1)) }
      .to raise_error(ArgumentError, /another language/)
    expect(demo.shared_task({"source" => "schedule"}, context_for(3)))
      .to eq({"source" => "schedule", "runtime" => "ruby", "attempt" => 3})
    expect { demo.shared_task({"source" => 123}, context_for(1)) }
      .to raise_error(ArgumentError, /requires a source/)
  end

  it "names each worker after its runtime and keeps the name process-unique" do
    first = demo.worker_id
    second = demo.worker_id
    expect([first, second]).to all(start_with("demo-ruby-"))
    expect(first).not_to eq(second)
  end

  context "against PostgreSQL" do
    around do |example|
      @url = ScratchDatabase.extra("demo-worker")
      skip(ScratchDatabase.skip_reason || "no scratch database") if @url.nil?
      @connection = PG.connect(@url)
      example.run
    ensure
      @pool&.shutdown(&:close)
      @connection&.close
      ScratchDatabase.drop_extra("demo-worker")
    end

    def eventually(seconds)
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + seconds
      loop do
        value = yield
        return value if value
        raise "condition not met within #{seconds}s" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

        sleep(0.02)
      end
    end

    it "completes tasks on its full-tier and fast-tier queues and fails another language's task" do
      @connection.exec_params(W::SqlCatalogue::SET_QUEUE_TIER_V1,
        [demo::RUBY_FAST_QUEUE, "fast", "workhorse-demo-seed", "test"])
      queue = W::Queue.new(@connection)
      language = queue.enqueue(demo::LANGUAGE_TASK_TYPE, {"language" => "ruby"}, queue: demo::RUBY_QUEUE).task_id
      shared = queue.enqueue(demo::SHARED_TASK_TYPE, {"source" => "test"}, queue: demo::SHARED_QUEUE).task_id
      fast = queue.enqueue(demo::LANGUAGE_TASK_TYPE, {"language" => "ruby"}, queue: demo::RUBY_FAST_QUEUE).task_id
      foreign = queue.enqueue(demo::LANGUAGE_TASK_TYPE, {"language" => "go"}, queue: demo::RUBY_QUEUE,
        max_attempts: 1).task_id

      @pool = demo.connection_pool(@url)
      worker = demo.build_worker(@pool, poll_interval: 0.02, worker_id: "demo-ruby-test-#{SecureRandom.hex(4)}")
      running = Thread.new { worker.run }
      admin = W::Admin.new(@connection)
      settled = ->(task_id, state) { (task = admin.get_task(task_id)) && task.state.to_s == state && task }
      begin
        expect(eventually(wait) { settled.call(language, "succeeded") }.result)
          .to eq({"language" => "ruby", "runtime" => "ruby", "attempt" => 1})
        expect(eventually(wait) { settled.call(shared, "succeeded") }.result)
          .to eq({"source" => "test", "runtime" => "ruby", "attempt" => 1})
        outcome = eventually(wait) do
          @connection.exec_params("SELECT state, result FROM workhorse.fast_task_outcome WHERE task_id = $1",
            [fast]).values.first
        end
        expect([outcome[0], JSON.parse(outcome[1])])
          .to eq(["succeeded", {"language" => "ruby", "runtime" => "ruby", "attempt" => 1}])
        expect(eventually(wait) { settled.call(foreign, "failed") }).to be_truthy
      ensure
        worker.stop
        expect(running.join(wait)).not_to be_nil
      end
    end

    it "waits for a missing schema until it is installed" do
      @pool = ConnectionPool.new(size: 2, timeout: 5) { PG.connect(@url) }
      demo.wait_for_schema(@pool, retry_seconds: 0.05)

      @connection.exec("SET client_min_messages TO warning; DROP SCHEMA workhorse CASCADE")
      waiting = Thread.new { demo.wait_for_schema(@pool, retry_seconds: 0.05) }
      sleep(0.5)
      expect(waiting).to be_alive

      @connection.exec(File.read(ScratchDatabase::SCHEMA))
      expect(waiting.join(wait)).not_to be_nil
    end
  end
end
