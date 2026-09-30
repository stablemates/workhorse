# frozen_string_literal: true

RSpec.describe "Admin against PostgreSQL" do
  include_context "with a scratch database"

  nil_task = "00000000-0000-0000-0000-000000000000"

  let(:admin) { W::Admin.new(@connection) }
  let(:worker) { "rb-admin-#{SecureRandom.hex(6)}" }

  define_method(:audit) { |request_id = SecureRandom.uuid| W::AdminAudit.new("operator", "investigating", request_id) }

  # Claims the next task on +queue_name+ and returns [task ID, fence token] as text.
  define_method(:claim) do |queue_name = @queue_name|
    @connection.exec_params("SELECT task_id, fence_token FROM workhorse.claim_v1($1, $2, 30000)",
      [queue_name, worker]).first.values
  end

  # Enqueues a single-attempt task, claims it, and fails it into a dead letter.
  define_method(:dead_letter) do |type = "t", tags: []|
    queue.enqueue(type, {"n" => 1}, max_attempts: 1, tags: tags)
    task_id, fence = claim
    @connection.exec_params(W::SqlCatalogue::FAIL_V1,
      [task_id, worker, fence, '{"name":"Boom","message":"exploded"}', nil])
    task_id
  end

  define_method(:register_worker) do
    @connection.exec_params(W::SqlCatalogue::REGISTER_WORKER_V1, [
      worker, SecureRandom.uuid, "admin-test-host", "42", "{#{@queue_name}}", "{}", "1", "30000",
      "10000", "250", "1000", "60000", "5000", "0", "false", nil, nil, nil
    ])
  end

  it "lists tasks with filters, projection, and a cursor" do
    first = queue.enqueue("a", {"secret" => "s", "n" => 1}).task_id
    second = queue.enqueue("b", {"n" => 2}).task_id

    page = admin.list_tasks(queue: @queue_name, limit: 1,
      payload: W::TaskPayloadProjection.new(include: true, redact_keys: ["secret"]))
    expect(page.items.map(&:id)).to eq([second])
    expect(page.items.first).to have_attributes(queue: @queue_name, type: "b", state: :ready,
      payload_status: :included, payload: {"n" => 2})
    expect(page.next_cursor).to be_a(W::TaskListCursor)

    rest = admin.list_tasks(queue: @queue_name, limit: 1, cursor: page.next_cursor,
      payload: W::TaskPayloadProjection.new(include: true, redact_keys: ["secret"]))
    expect(rest.items.map(&:id)).to eq([first])
    expect(rest.items.first.payload).to eq({"n" => 1}), "a redacted key is removed"
    expect(rest.next_cursor).to be_nil

    omitted = admin.list_tasks(queue: @queue_name, type: "a", states: %i[ready])
    expect(omitted.items.map { |item| [item.id, item.payload, item.payload_status] }).to eq([[first, nil, :omitted]])
    expect(admin.list_tasks(queue: @queue_name, states: %i[failed]).items).to be_empty
    expect(admin.list_tasks(queue: @queue_name, created_after: Time.now + 3600).items).to be_empty
  end

  it "reads a task snapshot and its timeline" do
    task_id = queue.enqueue("t", {"n" => 1}, tags: %w[x], max_attempts: 2).task_id
    claimed, fence = claim
    expect(claimed).to eq(task_id)
    @connection.exec_params(W::SqlCatalogue::UPDATE_PROGRESS_V1, [task_id, worker, fence, '{"done":1}'])

    snapshot = admin.get_task(task_id)
    expect(snapshot).to have_attributes(id: task_id, queue: @queue_name, type: "t", payload: {"n" => 1},
      tags: %w[x], state: :active, current_attempt: 1, max_attempts: 2, fence_token: Integer(fence, 10),
      dependency_policy: nil, child_task_ids: [])
    expect(snapshot.progress).to have_attributes(task_id: task_id, value: {"done" => 1}, revision: 1,
      worker_id: worker)
    expect(admin.get_task(nil_task)).to be_nil

    timeline = admin.get_task_timeline(task_id, limit: 1)
    expect(timeline.items.length).to eq(1)
    expect(timeline.next_cursor).to have_attributes(task_id: task_id)
    rest = admin.get_task_timeline(task_id, limit: 1000, cursor: timeline.next_cursor)
    entries = timeline.items + rest.items
    expect(entries.map(&:kind)).to include(:event)
    expect(entries.map(&:record_id).uniq.length).to eq(entries.length)
    expect { admin.get_task_timeline(nil_task, cursor: timeline.next_cursor) }
      .to raise_error(ArgumentError, "cursor task_id must match the requested task_id")
  end

  it "reads checkpoints, progress, and waits" do
    task_id = queue.enqueue("t", {}).task_id
    _, fence = claim
    @connection.exec_params(W::SqlCatalogue::SAVE_CHECKPOINT_V1, [task_id, worker, fence, "step-1", '{"at":1}'])
    @connection.exec_params(W::SqlCatalogue::UPDATE_PROGRESS_V1, [task_id, worker, fence, '{"pct":50}'])

    checkpoint = admin.get_checkpoint(task_id, "step-1")
    expect(checkpoint).to have_attributes(task_id: task_id, name: "step-1", value: {"at" => 1}, attempt: 1,
      fence_token: Integer(fence, 10), worker_id: worker)
    expect(checkpoint.created_at).to be_a(Time)
    expect(admin.list_checkpoints(task_id)).to eq([checkpoint])
    expect(admin.get_checkpoint(task_id, "missing")).to be_nil

    expect(admin.get_progress(task_id)).to have_attributes(value: {"pct" => 50}, revision: 1)
    expect(admin.get_progress(nil_task)).to be_nil

    @connection.exec_params(W::SqlCatalogue::SCHEDULE_WAIT_V1, [task_id, worker, fence, "nap", "60000", nil])
    wait = admin.get_wait(task_id, "nap")
    expect(wait).to have_attributes(task_id: task_id, name: "nap", duration_ms: 60_000, worker_id: worker)
    expect(wait.wake_at).to be_a(Time)
    expect(admin.list_waits(task_id)).to eq([wait])
    expect(admin.get_wait(task_id, "missing")).to be_nil
  end

  it "lists signal and human waits with a cursor" do
    signal_queue = "#{@queue_name}-signal"
    human_queue = "#{@queue_name}-human"
    2.times do
      signalled = queue.enqueue("wait.signal", {}, queue: signal_queue).task_id
      _, fence = claim(signal_queue)
      @connection.exec_params(W::SqlCatalogue::WAIT_FOR_SIGNAL_V1, [signalled, worker, fence, "approved", "60000"])
    end
    human = queue.enqueue("wait.human", {}, queue: human_queue).task_id
    _, fence = claim(human_queue)
    @connection.exec_params(W::SqlCatalogue::WAIT_FOR_HUMAN_V1,
      [human, worker, fence, "review", '{"question":"ship it?"}', "60000"])

    signals = []
    cursor = nil
    loop do
      page = admin.list_signal_waits(limit: 1, cursor: cursor)
      signals.concat(page.items)
      cursor = page.next_cursor
      break if cursor.nil?
    end
    mine = signals.select { |wait| wait.queue == signal_queue }
    expect(mine.map(&:name)).to eq(%w[approved approved])
    expect(mine.map(&:task_type).uniq).to eq(["wait.signal"])

    humans = admin.list_human_waits(limit: 1000).items.select { |wait| wait.queue == human_queue }
    expect(humans.map { |wait| [wait.task_id, wait.name, wait.context] }).to eq([[human, "review", {"question" => "ship it?"}]])
  end

  it "lists dead letters and redrives one" do
    source = dead_letter("boom", tags: %w[billing])
    other = dead_letter("other")

    letters = admin.list_dead_letters(queue: @queue_name, limit: 1)
    expect(letters.items.map(&:task_id)).to eq([other])
    expect(letters.next_cursor).to be_a(W::DeadLetterCursor)
    rest = admin.list_dead_letters(queue: @queue_name, cursor: letters.next_cursor)
    expect(rest.items.map(&:task_id)).to eq([source])
    expect(rest.items.first).to have_attributes(type: "boom", tags: %w[billing], redrive_count: 0,
      error: include("name" => "Boom"))
    expect(admin.list_dead_letters(queue: @queue_name, tags: %w[billing]).items.map(&:task_id)).to eq([source])
    expect(admin.list_dead_letters(queue: @queue_name, error_name: "Other").items).to be_empty

    request = audit
    result = admin.redrive(source, audit: request)
    expect(result).to have_attributes(status: :redriven, source_task_id: source, source_state: :failed,
      target_state: :ready)
    expect(result.requested_at).to be_a(Time)
    expect(admin.redrive(source, audit: request)).to have_attributes(status: :replayed,
      target_task_id: result.target_task_id)
    changed = W::AdminAudit.new("operator", "a different reason", request.request_id)
    expect { admin.redrive(source, audit: changed) }.to raise_error(W::RedriveIdempotencyConflictError) { |error|
      expect(error.details).to be_a(Hash)
    }
    expect(admin.redrive(nil_task, audit: audit).status).to eq(:not_found)
    expect(admin.redrive(result.target_task_id, audit: audit).status).to eq(:not_failed)
  end

  it "redrives dead letters in bulk with a dry run and a cursor" do
    sources = [dead_letter, dead_letter]

    dry = admin.redrive_many(audit: audit, queue: @queue_name, dry_run: true)
    expect(dry.results.map(&:status)).to eq(%i[eligible eligible])
    expect(dry.results.map(&:source_task_id)).to match_array(sources)

    first = admin.redrive_many(audit: audit, queue: @queue_name, limit: 1)
    expect(first.results.map(&:status)).to eq([:redriven])
    expect(first.next_cursor).to be_a(W::DeadLetterCursor)
    second = admin.redrive_many(audit: audit, queue: @queue_name, limit: 1, cursor: first.next_cursor)
    expect(second.results.map(&:status)).to eq([:redriven])
    expect((first.results + second.results).map(&:source_task_id)).to match_array(sources)
  end

  it "lists workers and pauses one" do
    register_worker

    entry = admin.list_workers.find { |entry| entry.worker_id == worker }
    expect(entry).to have_attributes(paused: false, hostname: "admin-test-host", pid: 42, queues: [@queue_name],
      concurrency: 1, draining: false)
    expect(entry.last_heartbeat_at).to be_a(Time)

    paused = admin.set_worker_paused(worker, true, audit: audit)
    expect(paused).to have_attributes(worker_id: worker, paused: true, paused_by: "operator", reason: "investigating")
    expect(paused.paused_at).to be_a(Time)
    expect(admin.set_worker_paused(worker, false, audit: audit)).to have_attributes(paused: false, paused_by: nil)
    expect(admin.set_worker_paused("#{worker}-missing", true, audit: audit)).to be_nil
  end

  it "pauses, resumes, and purges a queue" do
    paused = lambda do
      @connection.exec_params("SELECT paused FROM workhorse.queue_control WHERE queue_name = $1",
        [@queue_name]).first&.fetch("paused")
    end

    expect(admin.pause_queue(@queue_name, audit: audit)).to be_nil
    expect(paused.call).to eq("t")
    expect(admin.resume_queue(@queue_name, audit: audit)).to be_nil
    expect(paused.call).to eq("f")

    3.times { queue.enqueue("t", {}) }
    request = audit
    expect(admin.purge_queue(@queue_name, audit: request)).to eq(3)
    expect(task_count).to eq(0)
    expect { admin.purge_queue("#{@queue_name}-other", audit: request) }
      .to raise_error(W::PurgeIdempotencyConflictError)
  end

  it "joins the caller's transaction" do
    dead = dead_letter
    rollback = Class.new(StandardError)

    expect {
      @connection.transaction do
        expect(admin.redrive(dead, audit: audit).status).to eq(:redriven)
        raise rollback
      end
    }.to raise_error(rollback)
    expect(admin.list_dead_letters(queue: @queue_name).items.map(&:redrive_count)).to eq([0])
  end
end
