# frozen_string_literal: true

require "spec_helper"

# SM-1868: each registry write runs on its own thread after the write before it, and a write keeps
# no reference to the write before it. A dead Ruby thread keeps its block, so a block that kept the
# earlier thread would keep every earlier registry thread reachable from the newest one.
RSpec.describe "A worker registry write" do
  # A pool whose every statement fails, as a short database outage does.
  let(:offline_pool) do
    Class.new do
      def size = 3

      def with = raise(IOError, "registry is offline")
    end.new
  end

  subject(:worker) do
    W::Worker.new(offline_pool, queues: ["default"], polling_only: true, worker_id: "registry-worker",
      registry_interval: 0.1, on_registration_error: ->(_error) {})
  end

  it "runs after the write before it ends" do
    order = Concurrent::Array.new
    release = Concurrent::Event.new
    first = subject.send(:registry_step, "first") do
      release.wait(5)
      order << :first
    end
    second = subject.send(:registry_step, "second") { order << :second }

    expect(second.join(0.1)).to be_nil
    release.set
    expect(second.join(5)).not_to be_nil
    expect(first).not_to be_alive
    expect(order).to eq(%i[first second])
  end

  it "runs after a write whose body raised an error that is not a StandardError" do
    failed = subject.send(:registry_step, "failed") { raise NotImplementedError, "registry driver" }
    after = subject.send(:registry_step, "after") { :ran }

    expect(after.value).to eq(:ran)
    expect(failed).not_to be_alive
    expect { subject.send(:raise_registry_failure) }.to raise_error(NotImplementedError, "registry driver")
  end

  it "raises the failure of an earlier refresh on the dispatch thread after a later write" do
    subject.send(:registry_step, "failed") { raise NotImplementedError, "registry driver" }.join
    subject.send(:registry_step, "later") { nil }.join

    expect { subject.send(:refresh_registration_if_due) }.to raise_error(NotImplementedError, "registry driver")
  end

  it "starts no periodic refresh while a registry write still runs" do
    release = Concurrent::Event.new
    held = subject.send(:registry_step, "held") { release.wait(5) }
    subject.send(:refresh_registration_if_due)
    expect(subject.instance_variable_get(:@registry_write)).to equal(held)
  ensure
    release.set
    held&.join(5)
  end

  it "lets each failed periodic refresh before the newest become collectable" do
    refreshes = Array.new(20) do
      subject.instance_variable_set(:@last_registry_at, -Float::INFINITY)
      subject.send(:refresh_registration_if_due)
      thread = subject.instance_variable_get(:@registry_write)
      thread.join(5)
      ObjectSpace::WeakMap.new.tap { |map| map[:refresh] = thread }
    end
    GC.start(full_mark: true, immediate_sweep: true)
    GC.start

    # The garbage collector scans the stack conservatively, so one stale reference can survive.
    # Without the fix every refresh stays reachable from the newest one.
    reachable = refreshes[0...-1].count { |map| map.key?(:refresh) }
    expect(reachable).to be <= 2
  end
end
