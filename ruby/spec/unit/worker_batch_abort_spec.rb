# frozen_string_literal: true

require "spec_helper"

# SM-1709: a batch member whose cancellation fired while it waited stayed in the waiting list. The
# block then got a task that the worker no longer owned, and the member settled only after the
# linger ended.
RSpec.describe "a batch member whose cancellation fires while it waits" do
  pool_class = Class.new(FakeExecutor) do
    def size = 3

    def with(&) = FakeHeartbeatConnection.lend(&)
  end

  # A token that reports when the coordinator observes it, which it does after the member joins the
  # waiting list. A coordinator that never observes it fails on the outcome expectations instead.
  token_class = Class.new(W::CancellationToken) do
    def observed = (@observed ||= Concurrent::Event.new)

    def observe(&)
      super
      observed.set
    end
  end

  # A token whose observer has not run yet, as when the cancellation lands before registration.
  late_token_class = Class.new(token_class) do
    def observe(&) = observed.set
  end

  member_class = Struct.new(:token, :context, :thread, :outcome)

  let(:batches) { Concurrent::Array.new }
  let(:events) { Concurrent::Array.new }

  define_method(:coordinator) do |linger, max_size: 4|
    worker = W::Worker.new(pool_class.new, queues: ["default"], polling_only: true, poll_interval: 0.01,
      disable_registry: true, concurrency: 4)
    worker.handle_batch("batch", max_size: max_size, linger: linger) do |items|
      ids = items.map { |item| item.context.task.id }
      batches << ids
      events << :dispatch
      ids.map { |id| {status: :succeeded, result: id} }
    end
    worker.instance_variable_get(:@batch_coordinators).fetch("batch")
  end

  define_method(:start) do |coordinator, id, priority: 0, waits: true, on_leave: nil, canceled: nil, late: false|
    token = (late ? late_token_class : token_class).new
    token.cancel(canceled) unless canceled.nil?
    task = Struct.new(:id, :queue, :type, :priority, :attempt, :fence_token).new(id, "default", "batch", priority, 1, 1)
    context = Struct.new(:task, :cancellation).new(task, token)
    member = member_class.new(token, context, nil, nil)
    member.thread = Thread.new do
      member.outcome = [:ok, coordinator.run({}, context)]
    rescue => e
      member.outcome = [:error, e]
    ensure
      on_leave&.call
    end
    token.observed.wait(5) if waits
    member
  end

  it "removes the member at once, and its peers keep their order and dispatch" do
    subject = coordinator(2)
    first = start(subject, "first", priority: 3)
    canceled = start(subject, "canceled", priority: 2, on_leave: -> { events << :canceled_left })
    last = start(subject, "last", priority: 1)

    expect(canceled.token.cancel(:lease_lost)).to be(true)
    [first, canceled, last].each { |member| expect(member.thread.join(30)).not_to be_nil }

    expect(canceled.outcome.first).to eq(:error)
    expect(canceled.outcome.last).to be_a(W::CancelledError)
    expect(canceled.outcome.last.reason).to eq(:lease_lost)
    expect(events.to_a).to eq(%i[canceled_left dispatch])
    expect(batches.to_a).to eq([%w[first last]])
    expect(first.outcome).to eq([:ok, "first"])
    expect(last.outcome).to eq([:ok, "last"])
  end

  it "ends the linger when the last waiting member is canceled" do
    subject = coordinator(60)
    only = start(subject, "only")

    only.token.cancel(:requested)

    expect(only.thread.join(30)).not_to be_nil
    expect(only.outcome.last).to be_a(W::CancelledError)
    expect(only.outcome.last.reason).to eq(:requested)
    expect(batches).to be_empty
  end

  it "never admits a member whose token was canceled before it arrived" do
    subject = coordinator(0)
    late = start(subject, "late", waits: false, canceled: :requested)
    expect(late.thread.join(30)).not_to be_nil

    expect(late.outcome.last).to be_a(W::CancelledError)
    expect(batches).to be_empty
  end

  it "never selects a canceled member whose observer has not run" do
    subject = coordinator(30, max_size: 2)
    canceled = start(subject, "canceled", priority: 3, late: true)
    canceled.token.cancel(:requested)

    # Two later members fill a batch. The selection must not take the canceled member.
    first = start(subject, "first", priority: 2, waits: false)
    last = start(subject, "last", priority: 1, waits: false)
    [canceled, first, last].each { |member| expect(member.thread.join(30)).not_to be_nil }

    expect(canceled.outcome.last).to be_a(W::CancelledError)
    expect(canceled.outcome.last.reason).to eq(:requested)
    expect(batches.to_a).to eq([%w[first last]])
  end
end
