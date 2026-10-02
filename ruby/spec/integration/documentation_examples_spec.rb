# frozen_string_literal: true

require "connection_pool"
require "open3"
require "rack"
require "rack/mock"
require_relative "../../examples/docs"
require_relative "../../examples/landing"

# Runs every Ruby snippet the documentation and the landing page show against PostgreSQL.
#
# `site/scripts/check-language-examples.ts` holds each ```ruby fence equal to a region of
# `examples/docs.rb` or `examples/landing.rb`. This spec calls those regions, so a snippet that
# stops matching the gem fails here. The standalone programs under `examples/` run as subprocesses
# against a database of their own, because they use the default queue.
RSpec.describe "Documentation examples against PostgreSQL" do
  include_context "with a scratch database"

  actor = DocsExamples::Actor.new(email: "operator@example.com")

  status_sql = <<~SQL
    SELECT COALESCE(outcome.state, runtime.state) AS state, outcome.result,
           COALESCE(outcome.error, runtime.error) AS error
      FROM workhorse.task task
      LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
      LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
     WHERE task.id = $1
  SQL

  application_tables = <<~SQL
    SET client_min_messages TO warning;
    CREATE TABLE IF NOT EXISTS public.orders (id text PRIMARY KEY, status text, total numeric, items text[]);
    CREATE TABLE IF NOT EXISTS public.account (id text PRIMARY KEY, email text);
  SQL

  define_method(:status) { |task_id| @connection.exec_params(status_sql, [task_id]).first }
  define_method(:result) { |task_id| JSON.parse(status(task_id).fetch("result")) }

  before do
    @connection.exec(application_tables)
    @pool = ConnectionPool.new(size: 4, timeout: 5) { ScratchDatabase.connect }
    @admin = W::Admin.new(@pool)
    allow(W).to receive(:run_worker_process)
  end

  after { @pool&.shutdown(&:close) }

  def worker(**options)
    W::Worker.new(@pool, queues: [@queue_name], polling_only: true, poll_interval: 0.01, disable_registry: true,
      **options)
  end

  def id(prefix) = "#{prefix}-#{SecureRandom.hex(4)}"

  # Runs +subject+ until no task in +task_ids+ is ready, active, or waiting for a child it can run.
  def drain(subject, *task_ids, waiting: %w[ready active])
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 10
    until task_ids.none? { |task_id| waiting.include?(status(task_id)["state"]) } ||
        Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      subject.run_once
    end
  end

  # A task that exhausted its attempts, for the dead-letter snippets.
  def failed_task
    task_id = queue.enqueue("provider.call", {}, max_attempts: 1).task_id
    worker.handle("provider.call") { raise "provider timed out" }.run_once
    expect(status(task_id)["state"]).to eq("failed")
    task_id
  end

  def with_database_url(url)
    previous = ENV["DATABASE_URL"]
    ENV["DATABASE_URL"] = url
    yield
  ensure
    ENV["DATABASE_URL"] = previous
  end

  describe "the client snippets" do
    it "enqueues with each documented option" do
      later = Time.now + 3600
      expect(DocsExamples.enqueue_basic(queue, id("inv"), later).outcome).to eq(:accepted)
      expect(DocsExamples.enqueue_options(queue, later).outcome).to eq(:accepted)
      expect(DocsExamples.priority(queue, id("inv")).outcome).to eq(:accepted)
      expect(DocsExamples.retries(queue, id("acct")).outcome).to eq(:accepted)
      expect(DocsExamples.deadlines(queue, id("quote"), later, id("report"), 30, 3).outcome).to eq(:accepted)
      expect(DocsExamples.task_dependencies(queue).outcome).to eq(:accepted)
      expect(DocsExamples.multi_tenancy(queue).outcome).to eq(:accepted)

      recipients = [actor, DocsExamples::Recipient.new(email: "reader@example.com")]
      expect(DocsExamples.enqueue_many(queue, recipients).map(&:outcome)).to eq([:accepted, :accepted])
    end

    it "enqueues inside the caller's transaction" do
      account_id = id("acct")
      DocsExamples.enqueue_transaction(@connection, account_id, "ada@example.com")
      landing = LandingExamples::Enqueue.create_order(@pool, id("order"), 42)
      order = DocsExamples::ExampleTransaction.create_order(@pool, id("order"), ["book", "pen"])
      quickstart = DocsExamples::QuickstartOrder.create_order(@pool, id("order"))

      expect(@connection.exec_params("SELECT email FROM account WHERE id = $1", [account_id]).getvalue(0, 0))
        .to eq("ada@example.com")
      expect([landing, order, quickstart].map(&:outcome)).to eq([:accepted] * 3)
    end

    it "replays an idempotent enqueue and coalesces a debounced or throttled one" do
      invoice_id = id("inv")
      first = DocsExamples.idempotency_key(queue, invoice_id)
      expect(DocsExamples.idempotency_key(queue, invoice_id)).to eq(first.with(outcome: :replayed))

      key = id("key")
      expect { DocsExamples.idempotency_result(queue, invoice_id, key) }.to output(/\Aaccepted /).to_stdout
      expect { DocsExamples.idempotency_result(queue, invoice_id, key) }.to output(/\Areplayed /).to_stdout

      document_id = id("doc")
      first = DocsExamples.debounce(queue, document_id, 1, 60)
      expect(DocsExamples.debounce(queue, document_id, 2, 60)).to eq(first.with(outcome: :replaced))

      account_id = id("acct")
      first = DocsExamples.throttle(queue, account_id, 60)
      expect(DocsExamples.throttle(queue, account_id, 60)).to eq(first.with(outcome: :coalesced))

      event = {"id" => id("evt"), "type" => "invoice.paid"}
      first = DocsExamples::ExampleWebhook.handle_stripe_webhook(queue, event)
      expect(DocsExamples::ExampleWebhook.handle_stripe_webhook(queue, event)).to eq(first)

      expect(LandingExamples::IdempotencyExample.capture(queue).outcome).to be_a(Symbol)
      expect { LandingExamples::Coalescing.reindex(queue, id("doc"), 60) }
        .to output("accepted replaced\n").to_stdout
    end

    it "syncs policies, budgets, and schedules" do
      policies, budgets = DocsExamples.concurrency_policies(queue, id("msg"), id("tenant"))
      expect(policies.map(&:queue)).to include("mail")
      expect(budgets.map(&:name)).to include("vendor-api")
      expect(DocsExamples.rate_limits(queue).map(&:queue)).to include("provider-api")
      expect(DocsExamples.schedules(queue, @pool, "0 2 * * *")).to be_a(W::Worker)
      DocsExamples::ExampleSchedule.run_billing_worker(@pool)
      LandingExamples::Schedules.run(@pool)
      expect(LandingExamples::FlowControl.configure(queue, id("msg"), id("tenant")).outcome).to eq(:accepted)
      expect(LandingExamples::Retries.remind(queue, id("match"), Time.now + 3600).outcome).to eq(:accepted)
      expect(LandingExamples::DependenciesExample.confirm(queue, id("order")).outcome).to eq(:accepted)

      schedules = @connection.exec("SELECT namespace, schedule_name FROM workhorse.schedule_definition").values
      expect(schedules).to include(["billing-production", "invoice-run"], ["billing", "nightly-invoice-run"])
      expect(W).to have_received(:run_worker_process).twice
    end

    it "registers a task type contract" do
      # A contract binds a task type across the database, so it gets a database of its own.
      url = ScratchDatabase.extra("docs-contracts")
      connection = PG.connect(url)
      DocsExamples.contracts(W::Queue.new(connection))
      expect { W::Queue.new(connection).enqueue("mail.send", {"messageId" => "m-1"}) }
        .to raise_error(W::ContractValidationError)
      expect(W::Queue.new(connection).enqueue("mail.send", {"recipient" => "ada@example.com"}).outcome)
        .to eq(:accepted)
    ensure
      connection&.close
      ScratchDatabase.drop_extra("docs-contracts")
    end

    it "cancels a task" do
      result = DocsExamples.cancellation_request(queue, queue.enqueue("order.ship", {}).task_id, actor)
      expect(result.status).to eq(:canceled)

      task_id = queue.enqueue("rows.export", [1]).task_id
      expect(LandingExamples::Cancellation.configure_export(queue, worker, task_id).status).to eq(:canceled)
    end

    it "reads health, workers, and the dashboard" do
      expect(DocsExamples.queue_health(queue)).to include("level")
      expect { LandingExamples::OperateHealth.inspect(@pool) }.to output(/\d+\n\z/).to_stdout
      workers, pause = DocsExamples.operations(@pool, actor, id("incident"))
      expect([workers, pause]).to match([be_an(Array), be_nil.or(be_a(W::WorkerPauseResult))])
      LandingExamples::OperateFleet.pause_billing(@pool)
      DocsExamples.enqueue_pause(@admin, actor.email, "maintenance", id("pause"), id("resume"))
      control = @connection.exec("SELECT paused FROM workhorse.queue_control WHERE queue_name = 'billing'")
      expect(control.values).to eq([["f"]])

      with_database_url(ScratchDatabase.url) do
        expect(DocsExamples.installation_compatibility).to be_a(W::Queue)
      end

      app = Rack::MockRequest.new(DocsExamples.dashboard_mount(@pool).to_app)
      response = app.get("/workhorse", "HTTP_HOST" => "ops.example.com", "HTTP_X_ADMIN" => "ada")
      expect([response.status, response.location]).to eq([302, "/workhorse/tasks"])
      expect(app.get("/workhorse", "HTTP_HOST" => "ops.example.com").status).to be >= 400

      landing = Rack::MockRequest.new(LandingExamples::OperateDashboard.mount(@pool).to_app)
      expect(landing.get("/workhorse", "HTTP_X_ADMIN" => "ada").status).to eq(302)
    end

    it "lists and redrives dead letters" do
      source = failed_task
      expect(DocsExamples.dead_letters_list(@admin).items).to eq([])
      expect(DocsExamples.dead_letters_redrive(@admin, source, actor, id("incident")).status).to eq(:redriven)

      preview, page = DocsExamples.dead_letters_redrive_many(@admin, actor, id("incident"), 50)
      expect([preview.results, page.results]).to eq([[], []])
      expect { DocsExamples::ExampleIncident.redrive_incident(@admin) }.to output("0 tasks eligible\n").to_stdout
      LandingExamples::DeadLetters.redrive_billing(@admin)
    end
  end

  describe "the worker snippets" do
    it "builds the documented workers" do
      allow_any_instance_of(W::Worker).to receive(:run)
      DocsExamples.workers_run(@pool, 4)
      expect(DocsExamples.workers_options(@pool, 4, 30)).to be_a(W::Worker)
      DocsExamples.workers_process(@pool, 4)
      LandingExamples::Hero.run(@pool)
      with_database_url(ScratchDatabase.url) { LandingExamples::Deploy.run }
      expect(W).to have_received(:run_worker_process).exactly(3).times
    end

    it "completes the handlers that run straight through" do
      # A batch may not hold more tasks than the worker has slots.
      subject = worker(concurrency: 20)
      # A real import outlasts the cadence at which one attempt may change its progress.
      allow(DocsExamples).to receive(:import_batch) { sleep 0.15 }
      subject.handle("doc.checkpoint") { |order, context| DocsExamples.durable_checkpoint(context, order) }
      subject.handle("doc.sleep") { |trial, context| DocsExamples.durable_sleep(context, trial) }
      subject.handle("doc.progress") { |payload, context| DocsExamples.progress(context, payload) }
      subject.handle("doc.export") { |payload, context| DocsExamples.export(payload, context) }
      DocsExamples::ExampleTrial.register_trial_handler(subject)
      DocsExamples::ExampleExport.configure_export(queue, subject, queue.enqueue("export.stale", {}).task_id)
      LandingExamples::Checkpoints.register_invoice(subject)
      DocsExamples.batch_handlers(subject)

      past = (Time.now - 60).utc.iso8601
      tasks = {
        "doc.checkpoint" => {"id" => "order-1"},
        "doc.sleep" => {"to" => "ada@example.com", "followUpAt" => past},
        "doc.progress" => {"source" => "upload"},
        "doc.export" => {"parts" => ["a"]},
        "trial.lifecycle" => {"to" => "ada@example.com", "followUpAt" => past},
        "export.build" => {"parts" => ["a", "b"]},
        "invoice.issue" => {"amount" => 5, "email" => "ada@example.com"},
        "email.send" => {"to" => "ada@example.com"}
      }.to_h { |type, payload| [type, queue.enqueue(type, payload).task_id] }
      expect { drain(subject, *tasks.values) }.to output(/uploading a\nuploading b\n/).to_stdout

      expect(tasks.transform_values { |task_id| status(task_id)["state"] }).to eq(tasks.transform_values { "succeeded" })
      expect(result(tasks["doc.checkpoint"])).to eq({"orderId" => "order-1",
        "charge" => {"orderId" => "order-1", "idempotencyKey" => "charge:order-1"}})
      expect(result(tasks["doc.progress"])).to eq({"processed" => 2})
      expect(result(tasks["email.send"])).to eq({"sent" => true})
    end

    it "completes each task of the landing batch handler with its payload" do
      subject = worker(concurrency: 3)
      LandingExamples::BatchHandlers.register_email_batch(subject, 3, 0.05)
      payloads = %w[ada grace edsger].map { |name| {"to" => "#{name}@example.com"} }
      task_ids = payloads.map { |payload| queue.enqueue("email.send", payload).task_id }
      drain(subject, *task_ids)

      expect(task_ids.map { |task_id| status(task_id)["state"] }).to eq(%w[succeeded] * 3)
      expect(task_ids.map { |task_id| result(task_id) }).to eq(payloads)
    end

    it "suspends on a durable sleep" do
      subject = worker
      LandingExamples::Sleep.register_settlement(subject)
      task_id = queue.enqueue("order.settle", {"orderId" => "order-1"}).task_id
      subject.run_once

      expect(status(task_id)["state"]).to eq("scheduled")
    end

    it "resumes the signal and human waits with what was delivered" do
      subject = worker
      subject.handle("doc.external") { |_payload, context| DocsExamples.durable_external(context) }
      subject.handle("doc.signal") { |_payload, context| DocsExamples.signals_wait(context) }
      subject.handle("doc.human") { |payload, context| DocsExamples.human_waits(context, payload.fetch("accountId")) }
      LandingExamples::ExternalWaits.register_release(subject)

      external = queue.enqueue("doc.external", {}).task_id
      signal = queue.enqueue("doc.signal", {}).task_id
      human = queue.enqueue("doc.human", {"accountId" => "acct-1"}).task_id
      release = queue.enqueue("release.publish", {"id" => "v1"}).task_id
      drain(subject, external, signal, human, release)
      expect([external, signal, human, release].map { |task_id| status(task_id)["state"] }).to eq(["scheduled"] * 4)

      queue.send_signal(external, "provider-event", {"id" => "evt-1"}, idempotency_key: "e-1", requested_by: "spec")
      queue.send_signal(signal, "approval", {"approved" => true}, idempotency_key: "s-1", requested_by: "spec")
      queue.complete_human_wait(human, "account-review", {"approved" => true}, idempotency_key: "h-1",
        requested_by: "spec")
      expect(LandingExamples::ExternalWaits.deliver_scan(queue, release, {"clean" => true}, "scan-1").status)
        .to eq(:delivered)
      drain(subject, external, signal, human, release)

      queue.complete_human_wait(external, "operator-review", {"approved" => true}, idempotency_key: "e-2",
        requested_by: "spec")
      queue.complete_human_wait(release, "release-approval", {"approved" => true}, idempotency_key: "r-1",
        requested_by: "spec")
      drain(subject, external, release)

      expect([external, signal, human, release].map { |task_id| result(task_id) }).to eq([
        {"approved" => true}, {"approved" => true}, {"approved" => true}, {"published" => true}
      ])
    end

    it "joins child tasks" do
      subject = worker
      subject.handle("doc.children") { |order, context| DocsExamples.child_tasks_set(context, order) }
      subject.handle("orders.check-fraud") { raise "card flagged" }
      subject.handle("orders.reserve") { |order| {"reserved" => order["id"]} }
      subject.handle("doc.child") { |order, context| DocsExamples.child_tasks(context, order) }
      LandingExamples::DependenciesExample.register_fulfillment(subject)

      children = queue.enqueue("doc.children", {"id" => "order-1"}).task_id
      single = queue.enqueue("doc.child", {"id" => "order-2"}).task_id
      fulfill = queue.enqueue("order.fulfill", {"id" => "order-3"}).task_id
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 10
      until status(children)["state"] == "succeeded" || Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
        subject.run_once
        # The failed fraud check retries after a backoff; skip the wait so it exhausts its attempts.
        @connection.exec(<<~SQL)
          UPDATE workhorse.task_runtime runtime SET run_at = clock_timestamp(), state = 'ready',
                 ready_at = clock_timestamp(), sequence = nextval('workhorse.ready_sequence_seq')
            FROM workhorse.task task
           WHERE task.id = runtime.task_id AND task.task_type = 'orders.check-fraud' AND runtime.state = 'scheduled'
        SQL
      end

      expect(status(children)["state"]).to eq("succeeded")
      expect(result(children)).to eq({"accepted" => false, "reason" => "card flagged"})
      # The charge children run on the payments queue, so each parent waits for them.
      expect([single, fulfill].map { |task_id| status(task_id)["state"] }).to eq(%w[blocked blocked])
    end

    it "fans out the agent's tools and waits for approval" do
      model = Object.new
      def model.plan(prompt, key) = {"tools" => [{"id" => "search", "prompt" => prompt, "key" => key}]}

      subject = worker
      DocsExamples::ExampleAgent.register_agent(subject, model, 0.01)
      subject.handle("doc.agent") do |payload, context|
        tools = [W::ChildTaskRequest.new(name: "lookup", task_type: "agent.lookup", payload: payload)]
        DocsExamples.agentic_flow(context, "summarize", tools, 0.01)
      end
      subject.handle("agent.lookup") { |payload| {"found" => payload["q"]} }

      agent = queue.enqueue("agent.run", {"prompt" => "plan a trip", "conversationId" => "c-1"}).task_id
      flow = queue.enqueue("doc.agent", {"q" => "weather"}).task_id
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 10
      until @connection.exec_params("SELECT 1 FROM workhorse.task_signal_wait WHERE task_id = $1", [flow]).ntuples == 1 ||
          Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
        subject.run_once
      end
      queue.send_signal(flow, "approval", {"approved" => true}, idempotency_key: "a-1", requested_by: "spec")
      drain(subject, flow)

      expect(status(flow)["state"]).to eq("succeeded")
      expect(result(flow)).to eq({"plan" => {"prompt" => "summarize"},
        "tools" => {"lookup" => {"found" => "weather"}}, "approval" => {"approved" => true}})
      # The agent's tools run on the tools queue, so it waits for them.
      expect(status(agent)["state"]).to eq("blocked")
    end
  end

  describe "the standalone programs" do
    around do |example|
      url = ScratchDatabase.extra("docs-programs")
      if url
        connection = PG.connect(url)
        connection.exec(application_tables)
        connection.close
      end
      @programs_url = url
      example.run
    ensure
      ScratchDatabase.drop_extra("docs-programs")
    end

    let(:examples) { File.expand_path("../../examples", __dir__) }
    let(:library) { File.expand_path("../../lib", __dir__) }

    def run_program(name)
      stdout, stderr, status = Open3.capture3({"DATABASE_URL" => @programs_url, "WORKHORSE_DATABASE_URL" => @programs_url},
        RbConfig.ruby, "-I", library, File.join(examples, name))
      [stdout, own_output(stderr), status]
    end

    # A Bundler older than the running RubyGems redefines RubyGems constants and warns about its
    # own files. Those lines say nothing about the program, so only they are dropped.
    def own_output(text)
      text.lines.grep_v(%r{/(?:bundler-[^/]+/lib/bundler|rubygems)/[^:]*\.rb:\d+: warning: }).join
    end

    it "runs the quick start" do
      stdout, stderr, status = run_program("quickstart.rb")
      expect([status.exitstatus, stderr]).to eq([0, ""])
      expect(stdout).to eq(%(succeeded {"deliveredTo" => "ada@example.com"}\n))
    end

    it "runs the agent playbook integration" do
      stdout, stderr, status = run_program("agent_playbook.rb")
      expect([status.exitstatus, stderr]).to eq([0, ""])
      expect(stdout).to eq(%(succeeded {"receipt" => "receipt-for-order-42", "processedOrderId" => "order-42"}\n))
    end

    it "enqueues inside a transaction" do
      stdout, stderr, status = run_program("transaction.rb")
      expect([status.exitstatus, stderr]).to eq([0, ""])
      expect(stdout).to match(/\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\n\z/)
    end

    ["dedicated_worker.rb", "orchestration.rb"].each do |name|
      it "drains #{name} on SIGTERM" do
        reader, writer = IO.pipe
        pid = Process.spawn({"WORKHORSE_DATABASE_URL" => @programs_url}, RbConfig.ruby, "-I", library,
          File.join(examples, name), out: writer, err: writer)
        writer.close
        worker_id = nil
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 15
        connection = PG.connect(@programs_url)
        until worker_id || Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
          worker_id = connection.exec("SELECT worker_id FROM workhorse.worker_registry").values.flatten.first
          sleep 0.05
        end
        connection.close
        Process.kill("TERM", pid)
        _, status = Process.wait2(pid)

        expect([worker_id.nil?, status.exitstatus, own_output(reader.read)]).to eq([false, 0, ""])
      ensure
        reader&.close
      end
    end
  end
end
