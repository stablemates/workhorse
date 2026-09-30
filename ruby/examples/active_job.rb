# frozen_string_literal: true

# The Ruby snippets the Active Job page shows, kept in one file so that none of them can drift.
#
# Each `docs:start <name>` region is one snippet. `site/scripts/check-language-examples.ts`
# requires every ```ruby fence in the site pages to equal a dedented region, and every region to
# appear in at least one fence. `spec/integration/active_job_documentation_spec.rb` runs the regions
# against PostgreSQL. Code outside the regions only supplies the names a snippet uses.

require "active_job"
require "active_record"
require "active_support/core_ext/integer/time"
require "connection_pool"
require "pg"
require "stablemates/workhorse/active_job"

module ActiveJobExamples
  # What the jobs below did, so a spec can tell that each one ran.
  def self.performed = @performed ||= []

  # How many inventory syncs time out before one succeeds.
  class << self
    attr_writer :timeouts

    def timeouts = @timeouts ||= 0
  end

  module Classifier
    module_function

    def run(blob_id, model:) = ActiveJobExamples.performed << ["classify", blob_id, model]

    def extract(blob_id) = {"blob_id" => blob_id}

    def label(features, model:)
      ActiveJobExamples.performed << ["label", features.fetch("blob_id"), model]
      {"label" => "cat"}
    end
  end

  module Inventory
    module_function

    def sync(sku)
      ActiveJobExamples.performed << ["sync", sku]
      return if ActiveJobExamples.timeouts.zero?

      ActiveJobExamples.timeouts -= 1
      raise Timeout::Error, "inventory service timed out"
    end
  end

  module Billing
    module_function

    def charge(invoice_id) = ActiveJobExamples.performed << ["charge", invoice_id]
  end

  module Mailer
    module_function

    def receipt(order_id) = ActiveJobExamples.performed << ["receipt", order_id]
  end

  class Order < ActiveRecord::Base
    self.table_name = "orders"
  end

  def self.configure(config)
    # docs:start active-job-adapter
    config.active_job.queue_adapter = :stablemates_workhorse
    # docs:end
  end

  # docs:start active-job-application-job
  class ApplicationJob < ActiveJob::Base
    include Stablemates::Workhorse::ActiveJob::Options
  end
  # docs:end

  # docs:start active-job-typed-job
  class ClassifyImageJob < ApplicationJob
    queue_as :ml
    workhorse_options task_type: "images.classify", max_attempts: 5

    def perform(payload)
      Classifier.run(payload["blob_id"], model: payload["model"])
    end
  end
  # docs:end

  # docs:start active-job-retries
  class SyncInventoryJob < ApplicationJob
    workhorse_options max_attempts: 1
    retry_on Timeout::Error, wait: 5.seconds, attempts: 3

    def perform(sku)
      Inventory.sync(sku)
    end
  end
  # docs:end

  # docs:start active-job-transaction
  class ReceiptJob < ApplicationJob
    self.enqueue_after_transaction_commit = false

    def perform(order_id)
      Mailer.receipt(order_id)
    end
  end
  # docs:end

  def self.enqueue
    # docs:start active-job-enqueue
    ClassifyImageJob.perform_later({"blob_id" => 42, "model" => "v3"})
    ClassifyImageJob.set(wait: 10.minutes).perform_later({"blob_id" => 43, "model" => "v3"})
    ClassifyImageJob.set(priority: 90).perform_later({"blob_id" => 44, "model" => "v3"})
    SyncInventoryJob.perform_later("sku-1")
    # docs:end
  end

  def self.pay(order_id)
    # docs:start active-job-transaction-enqueue
    ActiveRecord::Base.transaction do
      Order.find(order_id).update!(status: "paid")
      ReceiptJob.perform_later(order_id)
    end
    # docs:end
  end

  def self.boot_worker
    # docs:start active-job-worker
    pool = ConnectionPool.new(size: 6) { PG.connect(ENV.fetch("DATABASE_URL")) }
    worker = Stablemates::Workhorse::Worker.new(pool, queues: %w[default ml], concurrency: 5)
    Stablemates::Workhorse::ActiveJob.handle(worker, jobs: [ClassifyImageJob])
    worker.handle("invoice.charge") { |payload, _context| Billing.charge(payload["invoice_id"]) }
    Stablemates::Workhorse.run_worker_process(worker)
    # docs:end
    worker
  end

  def self.native_worker(worker)
    # docs:start active-job-native
    worker.handle("images.classify") do |payload, context|
      features = context.checkpoint("features") { Classifier.extract(payload["blob_id"]) }
      context.checkpoint("label") { Classifier.label(features, model: payload["model"]) }
    end
    # docs:end
    worker
  end
end
