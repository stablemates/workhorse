# frozen_string_literal: true

# The Ruby snippets the site's landing page shows, kept in one file so that none of them can drift.
#
# Each `docs:start landing-<name>` region is one snippet. `site/scripts/check-language-examples.ts`
# requires every Ruby string in `site/lib/landing-snippets.ts` to equal a dedented region, and every
# region to appear there. `spec/integration/documentation_examples_spec.rb` runs each against PostgreSQL.

require "connection_pool"
require "pg"
require "stablemates/workhorse"

module LandingExamples
  module Hero
    # docs:start landing-hero
    def self.run(pool)
      Stablemates::Workhorse::Queue.new(pool).enqueue("email.welcome", {"to" => "ada@example.com"})

      worker = Stablemates::Workhorse::Worker.new(pool, concurrency: 4)
      worker.handle("email.welcome") do |payload, _context|
        {"deliveredTo" => payload["to"]}
      end
      Stablemates::Workhorse.run_worker_process(worker)
    end
    # docs:end
  end

  module Enqueue
    # docs:start landing-enqueue
    def self.create_order(pool, order_id, total)
      pool.with do |connection|
        connection.transaction do |transaction|
          transaction.exec_params("INSERT INTO orders (id, total) VALUES ($1, $2)", [order_id, total])

          # Same transaction: the task exists exactly when the order does.
          Stablemates::Workhorse::Queue.new(transaction).enqueue("order.confirm", {"orderId" => order_id})
        end
      end
    end
    # docs:end
  end

  module Checkpoints
    # docs:start landing-checkpoints
    def self.charge_card(amount) = {"id" => "ch_#{amount}"}

    def self.render_invoice(charge_id) = {"chargeId" => charge_id}

    def self.register_invoice(worker)
      worker.handle("invoice.issue") do |invoice, context|
        # Runs once. Every later activation replays the stored result.
        charge = context.checkpoint("charge") { charge_card(invoice.fetch("amount")) }

        pdf = context.checkpoint("render") { render_invoice(charge["id"]) }

        puts "email #{invoice.fetch("email")} #{pdf}"
        {"chargeId" => charge["id"]}
      end
    end
    # docs:end
  end

  module Sleep
    # docs:start landing-sleep
    def self.place_order(payload) = {"orderId" => payload["orderId"]}

    def self.register_settlement(worker)
      worker.handle("order.settle") do |payload, context|
        order = context.checkpoint("place") { place_order(payload) }

        # Slot released here. The process can restart, deploy, or die.
        context.sleep("settlement-window", 60 * 60)

        {"settled" => order["orderId"]}
      end
    end
    # docs:end
  end

  module Retries
    # docs:start landing-retries
    def self.remind(queue, match_id, kickoff)
      queue.enqueue("match.reminder", {"matchId" => match_id},
        # Pointless after kickoff, whatever else happens.
        deadline: kickoff,
        # Any single attempt is stuck after 30 seconds.
        execution_timeout: 30,
        max_attempts: 5,
        retry_policy: {
          "type" => "exponential",
          "initialDelayMs" => 1_000,
          "multiplier" => 2,
          "maxDelayMs" => 60_000
        })
    end
    # docs:end
  end

  module IdempotencyExample
    # docs:start landing-idempotency
    # A retried webhook gets the same task_id back instead of a second capture.
    def self.capture(queue)
      queue.enqueue("invoice.capture", {"invoiceId" => "inv-1"},
        queue: "billing",
        idempotency: Stablemates::Workhorse::Idempotency.new(
          key: "capture:inv-1", scope: "tenant-42", ttl: 86_400
        ))
    end
    # docs:end
  end

  module Schedules
    # docs:start landing-schedules
    def self.run(pool)
      # Run on every deployment with the complete list.
      task = Stablemates::Workhorse::ScheduledTask.new(task_type: "invoices.generate", payload: {})
      schedule = Stablemates::Workhorse::ScheduleDefinition.new(
        name: "nightly-invoice-run", schedule: "0 2 * * *", task: task
      )
      Stablemates::Workhorse::Queue.new(pool).sync_schedules("billing", [schedule], prune: true)

      # Any worker in the namespace fires due schedules itself.
      worker = Stablemates::Workhorse::Worker.new(pool, schedule_namespaces: ["billing"])
      Stablemates::Workhorse.run_worker_process(worker)
    end
    # docs:end
  end

  module FlowControl
    # docs:start landing-flow-control
    def self.configure(queue, message_id, tenant_id)
      # At most 20 mail tasks active; at most 2 per tenant.
      mail = Stablemates::Workhorse::ConcurrencyPolicyDefinition.new(
        queue: "mail", max_active: 20, max_active_per_key: 2
      )
      queue.sync_concurrency_policies("workers", [mail], prune: false)

      provider = Stablemates::Workhorse::RateLimitPolicyDefinition.new(
        queue: "provider-api",
        rate: Stablemates::Workhorse::RateLimit.new(limit: 100, interval: 1, burst: 200)
      )
      queue.sync_rate_limit_policies("workers", [provider], prune: false)

      queue.enqueue("mail.send", {"messageId" => message_id},
        queue: "mail", concurrency_key: "tenant:#{tenant_id}")
    end
    # docs:end
  end

  module DependenciesExample
    # docs:start landing-dependencies
    def self.confirm(queue, order_id)
      order = {"orderId" => order_id}
      inventory = queue.enqueue("inventory.reserve", order)

      dependencies = Stablemates::Workhorse::Dependencies.new(
        prerequisite_task_ids: [inventory.task_id],
        on_success: :release,
        on_failure: :cancel,
        on_cancellation: :cancel
      )
      queue.enqueue("order.confirm", order, dependencies: dependencies)
    end

    def self.register_fulfillment(worker)
      worker.handle("order.fulfill") do |order, context|
        receipt = context.run_child("charge", "payment.capture", {"orderId" => order["id"]}, queue: "payments")
        {"receipt" => receipt}
      end
    end
    # docs:end
  end

  module Coalescing
    # docs:start landing-coalescing
    def self.reindex(queue, document_id, quiet_period)
      debounce = Stablemates::Workhorse::Debounce.new(
        key: document_id, window: quiet_period, schedule: :reset, scope: "search-index"
      )
      first = queue.enqueue("search.reindex", {"documentId" => document_id, "revision" => 1}, debounce: debounce)
      latest = queue.enqueue("search.reindex", {"documentId" => document_id, "revision" => 2}, debounce: debounce)
      puts "#{first.outcome} #{latest.outcome}"
    end
    # docs:end
  end

  module ExternalWaits
    # docs:start landing-external-waits
    def self.register_release(worker)
      worker.handle("release.publish") do |release, context|
        scan = context.wait_for_signal("security-scan")

        request = {"releaseId" => release["id"], "scan" => scan}
        review = context.wait_for_human("release-approval", request)

        {"published" => review["approved"]}
      end
    end

    def self.deliver_scan(queue, task_id, result, delivery_id)
      queue.send_signal(task_id, "security-scan", result,
        idempotency_key: delivery_id, requested_by: "security-scanner")
    end
    # docs:end
  end

  module BatchHandlers
    # docs:start landing-batch-handlers
    def self.register_email_batch(worker, batch_size, linger)
      worker.handle_batch("email.send", max_size: batch_size, linger: linger) do |items|
        items.map { |item| {status: :succeeded, result: item.payload} }
      end
    end
    # docs:end
  end

  module Cancellation
    # docs:start landing-cancellation
    def self.configure_export(queue, worker, task_id)
      worker.handle("rows.export") do |rows, context|
        rows.each do |row|
          context.cancellation.check!
          puts "upload #{row}"
        end
        {"stopped" => false}
      end

      queue.cancel(task_id, requested_by: "operator@example.com", reason: "customer withdrew the request")
    end
    # docs:end
  end

  module DeadLetters
    # docs:start landing-dead-letters
    def self.redrive_billing(admin)
      page = admin.list_dead_letters(queue: "billing", error_name: "CardDeclined", limit: 100)

      page.items.each do |failure|
        audit = Stablemates::Workhorse::AdminAudit.new(
          actor: "operator@example.com",
          reason: "provider incident resolved",
          request_id: "incident-2026-08-03:#{failure.task_id}"
        )
        admin.redrive(failure.task_id, audit: audit)
      end
    end
    # docs:end
  end

  module OperateDashboard
    # docs:start landing-operate-dashboard
    def self.admin_session(env) = env["HTTP_X_ADMIN"]

    def self.mount(pool)
      dashboard = Stablemates::Workhorse::Dashboard.new(
        pool,
        path: "/workhorse",
        authorize: lambda do |env|
          actor = admin_session(env)
          actor ? Stablemates::Workhorse::Dashboard::Principal.new(actor: actor) : false
        end
      )
      Rack::Builder.new { map("/workhorse") { run dashboard } }
    end
    # docs:end
  end

  module OperateHealth
    # docs:start landing-operate-health
    def self.inspect(pool)
      health = Stablemates::Workhorse::Queue.new(pool).health
      puts health["status"]["reasons"] unless health["status"]["level"] == "healthy"

      # Cross-state listing on a dedicated projection: reading it never slows dispatch down.
      live = Stablemates::Workhorse::Admin.new(pool).list_tasks(states: [:active, :scheduled], limit: 100)
      puts live.items.length
    end
    # docs:end
  end

  module OperateFleet
    # docs:start landing-operate-fleet
    def self.pause_billing(pool)
      admin = Stablemates::Workhorse::Admin.new(pool)
      admin.list_workers.each do |entry|
        next unless entry.queue == "billing"

        audit = Stablemates::Workhorse::AdminAudit.new(
          actor: "operator@example.com",
          reason: "rolling deploy",
          request_id: "deploy-2026-08-23:#{entry.worker_id}"
        )
        admin.set_worker_paused(entry.worker_id, true, audit: audit)
      end
    end
    # docs:end
  end

  module Deploy
    # docs:start landing-deploy
    def self.run
      pool = ConnectionPool.new(size: 10) { PG.connect(ENV.fetch("DATABASE_URL")) }

      worker = Stablemates::Workhorse::Worker.new(pool,
        queues: ["email"],
        concurrency: 8,
        # Bounded graceful drain on SIGTERM.
        shutdown_grace: 25)
      worker.handle("email.send") { |email, _context| {"sent" => email["to"]} }
      Stablemates::Workhorse.run_worker_process(worker)
    end
    # docs:end
  end
end
