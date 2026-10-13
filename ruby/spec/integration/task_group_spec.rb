# frozen_string_literal: true

require "connection_pool"

RSpec.describe "Task groups against PostgreSQL" do
  include_context "with a scratch database"

  before { @pool = ConnectionPool.new(size: 4, timeout: 5) { ScratchDatabase.connect } }

  after { @pool&.shutdown(&:close) }

  let(:admin) { W::Admin.new(@connection) }
  let(:audit) { W::AdminAudit.new(actor: "rspec", reason: "exercise task groups", request_id: SecureRandom.uuid) }

  def request(type, payload = {}, **options) = W::EnqueueRequest.new(task_type: type, payload: payload, **options)

  def worker
    W::Worker.new(@pool, queues: [@queue_name], polling_only: true, poll_interval: 0.01, disable_registry: true)
  end

  def state(task_id)
    @connection.exec_params(<<~SQL, [task_id]).getvalue(0, 0)
      SELECT COALESCE(outcome.state, runtime.state)
        FROM workhorse.task task
        LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
        LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
       WHERE task.id = $1
    SQL
  end

  # Runs the worker until no task is left to claim.
  def drain(subject)
    20.times { return unless subject.run_once }
    raise "the queue did not drain"
  end

  it "creates, adds, and seals in one statement and enqueues the callbacks the result selects" do
    callback = request("group.report", {"report" => true})
    result = queue.task_group(on_finish: callback, on_success: request("group.succeeded"),
      on_failure: request("group.failed")) do |group|
      group.add([request("group.member", {"index" => 1}), request("group.member", {"index" => 2})])
      group.enqueue("group.member", {"index" => 3}, priority: 5)
    end

    expect(result.group.state).to eq(:sealed)
    expect(result.group.counts).to eq(W::TaskGroupCounts.new(total: 3, succeeded: 0, failed: 0, canceled: 0, pending: 3))
    expect(result.tasks.map(&:outcome)).to eq(%i[accepted accepted accepted])
    expect(result.group.callbacks.map(&:kind)).to eq(%i[on_finish on_success on_failure])
    expect(result.group.callbacks.map(&:task_id)).to all(be_nil)

    links = []
    subject = worker
    subject.handle("group.member") { |payload| {"index" => payload["index"]} }
    %w[group.report group.succeeded group.failed].each do |type|
      subject.handle(type) do |_payload, context|
        links << [type, context.task_group.get]
        {}
      end
    end
    drain(subject)

    group = queue.get_task_group(result.group.id)
    expect([group.state, group.result, group.counts.succeeded, group.counts.pending]).to eq([:finished, :succeeded, 3, 0])
    # PostgreSQL stores the callbacks as jsonb, which orders keys by length. The SDK keeps the
    # documented order.
    expect(group.callbacks.map { |item| [item.kind, !item.task_id.nil?] })
      .to eq([[:on_finish, true], [:on_success, true], [:on_failure, false]])
    expect(links.map(&:first)).to contain_exactly("group.report", "group.succeeded")
    report = links.to_h.fetch("group.report")
    expect([report.role, report.callback, report.group.id, report.group.counts.total])
      .to eq([:callback, :on_finish, result.group.id, 3])
    expect(links.to_h.fetch("group.succeeded").callback).to eq(:on_success)
  end

  it "enqueues nothing when the block raises" do
    expect {
      queue.task_group do |group|
        group.enqueue("group.member", {})
        raise "stop"
      end
    }.to raise_error(RuntimeError, "stop")
    expect(task_count).to eq(0)
    expect { queue.task_group }.to raise_error(ArgumentError, "task_group needs a block")
  end

  it "finishes an empty group at the seal" do
    result = queue.task_group(on_finish: request("group.report")) { nil }

    expect([result.group.state, result.group.result, result.tasks]).to eq([:finished, :succeeded, []])
    expect(state(result.group.callbacks.first.task_id)).to eq("ready")
  end

  it "adds to an open group, seals it, and pages its members" do
    group = queue.create_task_group(on_failure: request("group.failed"))
    expect([group.state, group.counts.total]).to eq([:open, 0])

    first = queue.add_to_task_group(group.id, [request("group.member", {"n" => 1}), request("group.member", {"n" => 2})])
    second = queue.add_to_task_group(group.id, [request("group.member", {"n" => 3})])
    expect(queue.add_to_task_group(group.id, [])).to eq([])
    sealed = queue.seal_task_group(group.id)
    expect([sealed.state, sealed.counts.total, queue.seal_task_group(group.id).state]).to eq([:sealed, 3, :sealed])

    page = queue.list_task_group_members(group.id, limit: 2)
    expect(page.members.map(&:task_id)).to eq(first.map(&:task_id))
    expect(page.members.map(&:position)).to eq([1, 2])
    expect(page.members.map { |member| [member.queue, member.type, member.state, member.outcome] })
      .to all(eq([@queue_name, "group.member", :ready, nil]))
    rest = queue.list_task_group_members(group.id, after: page.next_after, limit: 2)
    expect([rest.members.map(&:task_id), rest.next_after]).to eq([second.map(&:task_id), nil])
    # When the member count is a multiple of the limit, the last full page has no next position.
    exact = queue.list_task_group_members(group.id, limit: 3)
    expect([exact.members.map(&:position), exact.next_after]).to eq([[1, 2, 3], nil])
    last = admin.list_task_group_members(group.id, after: 2, limit: 1)
    expect([last.members.map(&:position), last.next_after]).to eq([[3], nil])
    expect(admin.list_task_group_members(group.id).members.length).to eq(3)
    expect(admin.get_task_group(group.id)).to eq(queue.get_task_group(group.id))

    link = queue.find_task_group(first.first.task_id)
    expect([link.role, link.callback, link.group.id]).to eq([:member, nil, group.id])
    expect(queue.find_task_group(SecureRandom.uuid)).to be_nil
    expect(queue.get_task_group(SecureRandom.uuid)).to be_nil
  end

  it "refuses an add after the seal and reports the reason" do
    group = queue.task_group { |builder| builder.enqueue("group.member", {}) }.group

    expect { queue.add_to_task_group(group.id, [request("group.member")]) }
      .to raise_error(W::TaskGroupClosedError) { |error|
        expect([error.group_id, error.state, error.reason]).to eq([group.id, :sealed, :sealed])
      }
  end

  it "rejects options and queues a group cannot take" do
    group = queue.create_task_group
    debounced = request("group.member", debounce: W::Debounce.new(key: "k", window: 1))
    expect { queue.add_to_task_group(group.id, [debounced]) }
      .to raise_error(ArgumentError, "a task group add cannot use debounce or throttle")
    expect { queue.create_task_group(on_finish: request("x", idempotency: W::Idempotency.new(key: "k"))) }
      .to raise_error(ArgumentError, /callbacks cannot use enqueue idempotency/)
    expect { queue.create_task_group(on_finish: "report") }
      .to raise_error(ArgumentError, "on_finish must be an EnqueueRequest or nil")
    expect { queue.add_to_task_group(group.id, Array.new(1001) { request("group.member") }) }
      .to raise_error(ArgumentError, /at most 1000 tasks/)

    fast = "#{@queue_name}-fast"
    @connection.exec_params(W::SqlCatalogue::SET_QUEUE_TIER_V1, [fast, "fast", "rspec", "exercise the fast tier"])
    expect { queue.add_to_task_group(group.id, [request("group.member", queue: fast)]) }
      .to raise_error(W::FastTierUnsupportedError) { |error| expect(error.feature).to eq("task groups") }
  end

  it "replays an idempotent add and refuses a task that is not a member" do
    group = queue.create_task_group
    keyed = request("group.member", idempotency: W::Idempotency.new(key: "member-1"))
    first = queue.add_to_task_group(group.id, [keyed]).first
    replay = queue.add_to_task_group(group.id, [keyed]).first
    expect([replay.outcome, replay.task_id]).to eq([:replayed, first.task_id])

    other = queue.create_task_group
    expect { queue.add_to_task_group(other.id, [keyed]) }
      .to raise_error(W::TaskGroupMembershipConflictError) { |error|
        expect([error.group_id, error.task_id, error.member_of]).to eq([other.id, first.task_id, group.id])
      }
  end

  it "lets a running member task add tasks after the seal" do
    result = queue.task_group(on_finish: request("group.report")) { |group| group.enqueue("group.parent", {}) }
    added = nil
    other = "#{@queue_name}-other"
    # The first queue of this worker is not the queue of the member task.
    subject = W::Worker.new(@pool, queues: ["#{@queue_name}-first", @queue_name], polling_only: true,
      poll_interval: 0.01, disable_registry: true)
    subject.handle("group.parent") do |_payload, context|
      before = context.task_group.get
      added = context.task_group.add([request("group.member", {"from" => "parent"}),
        request("group.member", {"from" => "parent"}, queue: other)])
      raise "the activation must keep its first read" unless context.task_group.get.equal?(before)

      {}
    end
    subject.handle("group.member") { {} }
    subject.handle("group.report") { {} }
    drain(subject)

    # The request with no queue goes to the queue of the member task. The worker does not serve +other+.
    group = queue.get_task_group(result.group.id)
    expect([group.state, group.counts.total, group.counts.succeeded]).to eq([:sealed, 3, 2])
    expect(queue.find_task_group(added.first.task_id).group.id).to eq(result.group.id)
    queues = queue.list_task_group_members(result.group.id).members.to_h { |member| [member.task_id, member.queue] }
    expect(added.map { |item| queues.fetch(item.task_id) }).to eq([@queue_name, other])
    expect(added.map { |item| state(item.task_id) }).to eq(%w[succeeded ready])
  end

  it "refuses an add from a task that is not a member" do
    task_id = queue.enqueue("group.loner", {}).task_id
    error = nil
    subject = worker
    subject.handle("group.loner") do |_payload, context|
      expect(context.task_group.get).to be_nil
      context.task_group.add([request("group.member")])
    rescue ArgumentError => e
      error = e
      {}
    end
    drain(subject)

    expect(error.message).to eq("Task #{task_id} is not a member of a task group")
  end

  it "cancels a group, reads its events, and repairs a counter that drifted" do
    group = queue.task_group(on_failure: request("group.failed")) do |builder|
      builder.enqueue("group.member", {})
      builder.enqueue("group.member", {})
    end.group

    canceled = admin.cancel_task_group(group.id, audit: audit)
    expect([canceled.state, canceled.result, canceled.counts.canceled, canceled.canceled_by])
      .to eq([:finished, :failed, 2, "rspec"])
    expect(admin.cancel_task_group(group.id, audit: audit).finished_at).to eq(canceled.finished_at)
    expect(admin.cancel_task_group(SecureRandom.uuid, audit: audit)).to be_nil
    events = admin.list_task_group_events(group.id).map(&:type)
    expect(events).to include(:created, :sealed, :canceled, :finished, :callback_enqueued)

    open = queue.create_task_group
    queue.add_to_task_group(open.id, [request("group.member")])
    # The counts of a group that is not finished live in its shard rows (ADR 0096). The member is in shard 0.
    @connection.exec_params(
      "UPDATE workhorse.task_group_shard SET succeeded_count = 1 WHERE group_id = $1 AND shard = 0", [open.id]
    )
    drift = admin.list_task_group_drift.find { |item| item.group_id == open.id }
    expect(drift.recorded).to eq(W::TaskGroupCounts.new(total: 1, succeeded: 1, failed: 0, canceled: 0, pending: nil))
    expect([drift.state, drift.counted.pending, drift.action]).to eq([:open, 1, :recounted])

    repair = admin.repair_task_group_drift(audit: audit).find { |item| item.group_id == open.id }
    expect([repair.recorded_pending, repair.pending, repair.action]).to eq([0, 1, :recounted])
    expect(admin.get_task_group(open.id).counts.succeeded).to eq(0)
    expect(admin.list_task_group_events(open.id).map(&:type)).to include(:counter_repaired)
    expect { admin.list_task_group_drift(limit: 10_001) }.to raise_error(ArgumentError, /between 1 and 10000/)
  end
end
