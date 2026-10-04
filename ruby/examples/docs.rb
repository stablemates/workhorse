# frozen_string_literal: true

# The Ruby snippets the documentation shows, kept in one file so that none of them can drift.
#
# Each `docs:start <name>` region is one snippet. `site/scripts/check-language-examples.ts`
# requires every ```ruby fence in the site pages and guides to equal a dedented region, and every
# region to appear in at least one fence. `spec/integration/documentation_examples_spec.rb` runs the
# regions against PostgreSQL. Code outside the regions only supplies the names a snippet uses.
#
# A region ends before its method returns, so a snippet can show the name it assigns.
#
# Documentation: https://workhorse.run/docs
#
# rubocop:disable Style/RedundantAssignment

require "connection_pool"
require "pg"
require "stablemates/workhorse"
require "time"

module DocsExamples
  module Mailer
    module_function

    def send(payload) = {"sent" => payload}

    def welcome(to) = {"deliveredTo" => to, "kind" => "welcome"}

    def follow_up(to) = {"deliveredTo" => to, "kind" => "follow-up"}
  end

  module Payments
    module_function

    def charge(order_id, idempotency_key) = {"orderId" => order_id, "idempotencyKey" => idempotency_key}
  end

  module Logistics
    module_function

    def create_shipment(order_id, charge) = {"orderId" => order_id, "charge" => charge}
  end

  Actor = Data.define(:email)
  Recipient = Data.define(:email)

  module_function

  def publish_order = nil

  def activate_account(_account_id) = nil

  def read_batches(_source) = [[{"id" => 1}], [{"id" => 2}]]

  def import_batch(_batch) = nil

  def call_model(prompt) = {"prompt" => prompt}

  def upload_part(_part) = nil

  def application_admin_session(env) = env["HTTP_X_ADMIN"]

  def enqueue_basic(queue, invoice_id, reminder_date)
    # docs:start enqueue-basic
    queue.enqueue("email.send", {"to" => "person@example.com"})
    queue.enqueue("invoice.remind", {"invoiceId" => invoice_id}, queue: "billing", run_at: reminder_date)
    # docs:end
  end

  def enqueue_options(queue, end_of_month)
    # docs:start enqueue-options
    queue.enqueue("report.generate", {"month" => "2026-08"},
      queue: "reports",
      tags: ["tenant:acme"],
      concurrency_key: "acme",
      priority: 10,
      max_attempts: 5,
      deadline: end_of_month,
      execution_timeout: 120)
    # docs:end
  end

  def enqueue_transaction(connection, id, email)
    # docs:start enqueue-transaction
    connection.transaction do |transaction|
      transaction.exec_params("INSERT INTO account (id, email) VALUES ($1, $2)", [id, email])
      Stablemates::Workhorse::Queue.new(transaction).enqueue("account.created", {"accountId" => id})
    end
    # docs:end
  end

  def enqueue_many(queue, recipients)
    # docs:start enqueue-many
    requests = recipients.map do |recipient|
      Stablemates::Workhorse::EnqueueRequest.new(
        task_type: "email.digest", payload: {"to" => recipient.email}, queue: "mail"
      )
    end
    results = queue.enqueue_many(requests)
    # docs:end
    results
  end

  def enqueue_pause(admin, actor, reason, request_id, resume_request_id)
    # docs:start enqueue-pause
    audit = Stablemates::Workhorse::AdminAudit.new(actor: actor, reason: reason, request_id: request_id)
    admin.pause_queue("billing", audit: audit)
    admin.resume_queue("billing", audit: audit.with(request_id: resume_request_id))
    # docs:end
  end

  def priority(queue, invoice_id)
    # docs:start priority
    queue.enqueue("invoice.remind", {"invoiceId" => invoice_id}, queue: "billing", priority: 10)
    # docs:end
  end

  def retries(queue, account_id)
    # docs:start retries-attempts
    queue.enqueue("provider.sync", {"accountId" => account_id}, max_attempts: 5)
    # docs:end
    # docs:start retries-policy
    jitter = {"type" => "decorrelated-jitter", "baseDelayMs" => 1_000, "maxDelayMs" => 60_000}
    queue.enqueue("provider.sync", {"accountId" => account_id}, retry_policy: jitter, max_attempts: 5)
    # docs:end
  end

  def deadlines(queue, quote_id, quote_expires_at, report_id, attempt_timeout, attempt_budget)
    # docs:start deadlines-deadline
    queue.enqueue("price.quote", {"quoteId" => quote_id}, deadline: quote_expires_at)
    # docs:end
    # docs:start deadlines-timeout
    queue.enqueue("report.build", {"reportId" => report_id},
      execution_timeout: attempt_timeout, max_attempts: attempt_budget)
    # docs:end
  end

  def idempotency_key(queue, invoice_id)
    # docs:start idempotency-key
    result = queue.enqueue("invoice.capture", {"invoiceId" => invoice_id},
      queue: "billing",
      idempotency: Stablemates::Workhorse::Idempotency.new(key: "capture:#{invoice_id}", scope: "invoice-capture"))
    # docs:end
    result
  end

  def idempotency_result(queue, invoice_id, key)
    # docs:start idempotency-result
    result = queue.enqueue("invoice.capture", {"invoiceId" => invoice_id},
      idempotency: Stablemates::Workhorse::Idempotency.new(key: key, scope: "invoice-capture"))
    puts "#{result.outcome} #{result.task_id}"
    # docs:end
    result
  end

  def debounce(queue, document_id, revision, quiet_period)
    # docs:start debounce
    result = queue.enqueue("search.reindex", {"documentId" => document_id, "revision" => revision},
      debounce: Stablemates::Workhorse::Debounce.new(
        key: document_id, window: quiet_period, schedule: :reset, scope: "search-index"
      ))
    # docs:end
    result
  end

  def throttle(queue, account_id, digest_window)
    # docs:start throttle
    result = queue.enqueue("email.digest", {"accountId" => account_id},
      throttle: Stablemates::Workhorse::Throttle.new(key: account_id, window: digest_window, scope: "digest"))
    # docs:end
    result
  end

  def task_dependencies(queue)
    # docs:start task-dependencies
    import = queue.enqueue("contacts.import", {"source" => "upload"})
    queue.enqueue("contacts.notify", {"importId" => import.task_id},
      dependencies: Stablemates::Workhorse::Dependencies.new(
        prerequisite_task_ids: [import.task_id],
        on_success: :release,
        on_failure: :fail,
        on_cancellation: :cancel
      ))
    # docs:end
  end

  def concurrency_policies(queue, message_id, tenant_id)
    # docs:start concurrency-policy
    policies = queue.sync_concurrency_policies("workers", [
      Stablemates::Workhorse::ConcurrencyPolicyDefinition.new(queue: "mail", max_active: 20, max_active_per_key: 3)
    ], prune: false)
    # docs:end
    # docs:start concurrency-key
    queue.enqueue("mail.send", {"messageId" => message_id}, queue: "mail", concurrency_key: tenant_id)
    # docs:end
    # docs:start concurrency-budget
    budgets = queue.sync_budgets("workers", [
      Stablemates::Workhorse::BudgetDefinition.new(name: "vendor-api", max_active: 4)
    ], prune: false)
    queue.enqueue("invoice.sync", {"id" => 1}, queue: "billing", budget: "vendor-api")
    # docs:end
    [policies, budgets]
  end

  def rate_limits(queue)
    # docs:start rate-limits
    policies = queue.sync_rate_limit_policies("workers", [
      Stablemates::Workhorse::RateLimitPolicyDefinition.new(
        queue: "provider-api",
        rate: Stablemates::Workhorse::RateLimit.new(limit: 60, interval: 60, burst: 10),
        per_key: Stablemates::Workhorse::RateLimit.new(limit: 5, interval: 60, burst: 2)
      )
    ], prune: false)
    # docs:end
    policies
  end

  def multi_tenancy(queue)
    # docs:start multi-tenancy
    tenant = "acme"
    queue.sync_concurrency_policies("workers", [
      Stablemates::Workhorse::ConcurrencyPolicyDefinition.new(queue: "reports", max_active: 40, max_active_per_key: 4)
    ], prune: false)
    queue.sync_budgets("workers", [
      Stablemates::Workhorse::BudgetDefinition.new(name: tenant, max_active: 8)
    ], prune: false)
    queue.enqueue("report.generate", {"month" => "2026-08"},
      queue: "reports", concurrency_key: tenant, budget: tenant, tags: ["tenant:#{tenant}"])
    # docs:end
  end

  def contracts(queue)
    # docs:start contracts
    queue.sync_contracts(
      "mail.send" => Stablemates::Workhorse::TaskTypeContracts.new(
        current_version: "mail-current",
        versions: {
          "mail-current" => Stablemates::Workhorse::TaskContractVersion.new(
            payload_schema: {"type" => "object", "required" => ["recipient"]},
            result_schema: {"type" => "object"},
            sensitive_payload_keys: ["accessToken"]
          )
        }
      )
    )
    # docs:end
  end

  def schedules(queue, pool, nightly_cron)
    # docs:start schedules-sync
    task = Stablemates::Workhorse::ScheduledTask.new(task_type: "invoice.generate", payload: {"scope" => "due"},
      queue: "billing")
    schedule = Stablemates::Workhorse::ScheduleDefinition.new(name: "invoice-run", schedule: nightly_cron,
      task: task, timezone: "America/New_York")
    queue.sync_schedules("billing-production", [schedule], prune: true)
    # docs:end
    # docs:start schedules-worker
    worker = Stablemates::Workhorse::Worker.new(pool, schedule_namespaces: ["billing-production"])
    # docs:end
    worker
  end

  def cancellation_request(queue, task_id, actor)
    # docs:start cancellation-request
    result = queue.cancel(task_id, requested_by: actor.email, reason: "customer withdrew the order")
    # docs:end
    result
  end

  def export(payload, context)
    # docs:start cancellation-handler
    payload.fetch("parts").each do |part|
      context.cancellation.check!
      upload_part(part)
    end
    # docs:end
    {"exported" => true}
  end

  def queue_health(queue)
    # docs:start queue-health
    status = queue.health.fetch("status")
    warn status.fetch("reasons").inspect unless status.fetch("level") == "healthy"
    # docs:end
    status
  end

  def dead_letters_list(admin)
    # docs:start dead-letters-list
    page = admin.list_dead_letters(queue: "billing", error_name: "ProviderTimeout",
      finished_after: Time.utc(2026, 8, 12, 9, 0, 0))
    # docs:end
    page
  end

  def dead_letters_redrive(admin, source_task_id, actor, incident_id)
    # docs:start dead-letters-redrive
    audit = Stablemates::Workhorse::AdminAudit.new(actor: actor.email, reason: "provider incident resolved",
      request_id: incident_id)
    result = admin.redrive(source_task_id, audit: audit)
    # docs:end
    result
  end

  def dead_letters_redrive_many(admin, actor, incident_id, page_size)
    # docs:start dead-letters-redrive-many
    filter = {queue: "billing", error_name: "ProviderTimeout"}
    audit = Stablemates::Workhorse::AdminAudit.new(actor: actor.email, reason: "provider incident resolved",
      request_id: incident_id)
    preview = admin.redrive_many(audit: audit, dry_run: true, limit: page_size, **filter)
    page = admin.redrive_many(audit: audit, limit: page_size, **filter)
    # docs:end
    [preview, page]
  end

  def operations(pool, actor, incident_id)
    # docs:start operations
    admin = Stablemates::Workhorse::Admin.new(pool)
    workers = admin.list_workers
    audit = Stablemates::Workhorse::AdminAudit.new(actor: actor.email, reason: "investigating slow provider",
      request_id: incident_id)
    result = admin.set_worker_paused("billing-worker-1", true, audit: audit)
    # docs:end
    [workers, result]
  end

  def installation_compatibility
    # docs:start installation-compatibility
    queue = Stablemates::Workhorse::Queue.new(PG.connect(ENV.fetch("DATABASE_URL")))
    queue.assert_compatible
    # docs:end
    queue
  end

  def workers_run(pool, worker_concurrency)
    # docs:start workers-run
    worker = Stablemates::Workhorse::Worker.new(pool, queues: ["email", "billing"], concurrency: worker_concurrency)
    worker.handle("email.send") { |payload, _context| Mailer.send(payload) }
    worker.run
    # docs:end
  end

  def workers_options(pool, worker_concurrency, worker_lease)
    # docs:start workers-options
    worker = Stablemates::Workhorse::Worker.new(pool,
      queues: ["email", "billing"],
      concurrency: worker_concurrency,
      lease: worker_lease,
      worker_id: "email-worker-1")
    # docs:end
    worker
  end

  def workers_process(pool, worker_concurrency)
    # docs:start workers-process
    worker = Stablemates::Workhorse::Worker.new(pool, queues: ["email", "billing"], concurrency: worker_concurrency)
    worker.handle("email.send") { |payload, _context| Mailer.send(payload) }
    Stablemates::Workhorse.run_worker_process(worker)
    # docs:end
  end

  def batch_handlers(worker)
    # docs:start batch-handlers
    worker.handle_batch("email.send", max_size: 20, linger: 0.05) do |items|
      items.map { {status: :succeeded, result: {"sent" => true}} }
    end
    # docs:end
  end

  def batch_handlers_enqueue(queue)
    # docs:start batch-handlers-enqueue
    queue.enqueue("email.send", {"to" => "person@example.com"})
    # docs:end
  end

  def durable_checkpoint(context, order)
    # docs:start durable-checkpoint
    charge = context.checkpoint("charge") { Payments.charge(order.fetch("id"), "charge:#{order.fetch("id")}") }
    shipment = context.checkpoint("shipment") { Logistics.create_shipment(order.fetch("id"), charge) }
    # docs:end
    shipment
  end

  def durable_sleep(context, trial)
    # docs:start durable-sleep
    welcome = context.checkpoint("welcome") { Mailer.welcome(trial.fetch("to")) }
    context.sleep_until("follow-up-window", Time.iso8601(trial.fetch("followUpAt")))
    follow_up = context.checkpoint("follow-up") { Mailer.follow_up(trial.fetch("to")) }
    # docs:end
    [welcome, follow_up]
  end

  def durable_external(context)
    # docs:start durable-external
    event = context.wait_for_signal("provider-event")
    review = context.wait_for_human("operator-review", {"eventId" => event.fetch("id")})
    # docs:end
    review
  end

  def signals_wait(context)
    # docs:start signals-wait
    approval = context.wait_for_signal("approval")
    publish_order if approval["approved"] == true
    # docs:end
    approval
  end

  def human_waits(context, account_id)
    # docs:start human-waits
    review = context.wait_for_human("account-review",
      {"accountId" => account_id, "prompt" => "Approve this account?"})
    activate_account(account_id) if review["approved"] == true
    # docs:end
    review
  end

  def child_tasks(context, order)
    # docs:start child-tasks
    charge = context.run_child("charge", "payments.charge", {"orderId" => order.fetch("id")}, queue: "payments")
    # docs:end
    charge
  end

  def child_tasks_set(context, order)
    # docs:start child-tasks-set
    outcomes = context.run_children([
      Stablemates::Workhorse::ChildTaskRequest.new(name: "fraud", task_type: "orders.check-fraud", payload: order),
      Stablemates::Workhorse::ChildTaskRequest.new(name: "inventory", task_type: "orders.reserve", payload: order)
    ])

    fraud = outcomes.fetch("fraud")
    if fraud.status == :failed
      {"accepted" => false, "reason" => fraud.error["message"]}
    else
      {"accepted" => true}
    end
    # docs:end
  end

  def progress(context, payload)
    processed = 0
    # docs:start progress-set
    context.set_progress({"phase" => "reading", "processed" => 0})
    read_batches(payload.fetch("source")).each do |batch|
      import_batch(batch)
      processed += batch.length
      context.set_progress({"phase" => "importing", "processed" => processed})
    end
    # docs:end
    {"processed" => processed}
  end

  def agentic_flow(context, prompt, tool_requests, cooldown)
    # docs:start agentic-flow
    plan = context.checkpoint("plan") { call_model(prompt) }
    context.set_progress({"stage" => "planned"})
    tools = context.run_children_all(tool_requests)
    context.sleep("model-cooldown", cooldown)
    approval = context.wait_for_signal("approval")
    # docs:end
    {"plan" => plan, "tools" => tools, "approval" => approval}
  end

  module ExampleTrial
    # docs:start examples-trial
    require "time"

    def self.send_welcome(to) = {"deliveredTo" => to, "kind" => "welcome"}

    def self.send_follow_up(to) = {"deliveredTo" => to, "kind" => "follow-up"}

    def self.register_trial_handler(worker)
      worker.handle("trial.lifecycle") do |trial, context|
        to = trial.fetch("to")
        context.checkpoint("welcome") { send_welcome(to) }
        context.sleep_until("follow-up-window", Time.iso8601(trial.fetch("followUpAt")))
        context.checkpoint("follow-up") { send_follow_up(to) }
        {"deliveredTo" => to}
      end
    end
    # docs:end
  end

  module ExampleAgent
    # docs:start examples-agent
    # +model+ answers plan(prompt, idempotency_key) with {"tools" => [{"id" => ..., ...}]}.
    def self.register_agent(worker, model, cooldown)
      worker.handle("agent.run") do |run, context|
        key = "plan:#{context.task.id}"
        plan = context.checkpoint("plan") { model.plan(run.fetch("prompt"), key) }

        children = plan.fetch("tools").map do |tool|
          Stablemates::Workhorse::ChildTaskRequest.new(
            name: tool.fetch("id"), task_type: "agent.tool", payload: tool,
            options: {queue: "tools", concurrency_key: run.fetch("conversationId")}
          )
        end

        tools = context.run_children_all(children)
        context.sleep("model-cooldown", cooldown)
        approval = context.wait_for_signal("approval")
        {"plan" => plan, "tools" => tools, "approved" => approval["approved"] == true}
      end
    end
    # docs:end
  end

  module ExampleTransaction
    # docs:start examples-transaction
    def self.create_order(pool, order_id, items)
      pool.with do |connection|
        connection.transaction do |transaction|
          transaction.exec_params("INSERT INTO orders (id, items) VALUES ($1, $2)",
            [order_id, PG::TextEncoder::Array.new.encode(items)])
          Stablemates::Workhorse::Queue.new(transaction, default_queue: "orders")
            .enqueue("order.fulfill", {"orderId" => order_id})
        end
      end
    end
    # docs:end
  end

  module ExampleSchedule
    # docs:start examples-schedule
    def self.run_billing_worker(pool)
      queue = Stablemates::Workhorse::Queue.new(pool, default_queue: "billing")
      task = Stablemates::Workhorse::ScheduledTask.new(task_type: "invoice.generate", payload: {"scope" => "due"},
        queue: "billing")
      schedule = Stablemates::Workhorse::ScheduleDefinition.new(name: "nightly-invoice-run",
        schedule: "0 3 * * *", task: task)
      queue.sync_schedules("billing-production", [schedule], prune: false)

      worker = Stablemates::Workhorse::Worker.new(pool,
        queues: ["billing"], schedule_namespaces: ["billing-production"])
      worker.handle("invoice.generate") { |payload, _context| {"generated" => true, "payload" => payload} }
      Stablemates::Workhorse.run_worker_process(worker)
    end
    # docs:end
  end

  module ExampleWebhook
    # docs:start examples-webhook
    def self.handle_stripe_webhook(queue, event)
      result = queue.enqueue("stripe.event", {"eventId" => event.fetch("id"), "eventType" => event.fetch("type")},
        queue: "webhooks",
        idempotency: Stablemates::Workhorse::Idempotency.new(key: "stripe:#{event.fetch("id")}",
          scope: "stripe-webhooks"))
      {"accepted" => result.task_id}
    end
    # docs:end
  end

  module ExampleIncident
    # docs:start examples-incident
    def self.redrive_incident(admin)
      filter = {queue: "billing", error_name: "ProviderTimeout"}
      audit = Stablemates::Workhorse::AdminAudit.new(actor: "reviewer@example.com",
        reason: "provider incident INC-2041 resolved", request_id: "INC-2041")
      preview = admin.redrive_many(audit: audit, dry_run: true, limit: 100, **filter)
      puts "#{preview.results.length} tasks eligible"

      cursor = nil
      loop do
        page = admin.redrive_many(audit: audit, limit: 100, cursor: cursor, **filter)
        page.results.each do |result|
          puts "#{result.status} #{result.source_task_id} -> #{result.target_task_id}"
        end
        cursor = page.next_cursor
        break if cursor.nil?
      end
    end
    # docs:end
  end

  module ExampleExport
    # docs:start examples-export
    def self.upload_part(part) = puts("uploading #{part}")

    def self.configure_export(queue, worker, task_id)
      queue.cancel(task_id, requested_by: "support@example.com", reason: "customer withdrew the order")

      worker.handle("export.build") do |export, context|
        export.fetch("parts").each do |part|
          context.cancellation.check!
          upload_part(part)
        end
        {"exported" => true}
      end
    end
    # docs:end
  end

  module QuickstartOrder
    # docs:start quickstart-transaction
    def self.create_order(pool, order_id)
      pool.with do |connection|
        connection.transaction do |transaction|
          transaction.exec_params("INSERT INTO orders (id) VALUES ($1)", [order_id])
          Stablemates::Workhorse::Queue.new(transaction).enqueue("order.fulfill", {"orderId" => order_id})
        end
      end
    end
    # docs:end
  end

  def dashboard_mount(pool)
    # docs:start dashboard-mount
    dashboard = Stablemates::Workhorse::Dashboard.new(
      pool,
      authorize: lambda do |env|
        username = application_admin_session(env)
        username ? Stablemates::Workhorse::Dashboard::Principal.new(actor: username) : false
      end,
      path: "/workhorse",
      environment: "production",
      allowed_hosts: ["ops.example.com"]
    )
    app = Rack::Builder.new { map("/workhorse") { run dashboard } }
    # docs:end
    app
  end
end
# rubocop:enable Style/RedundantAssignment
