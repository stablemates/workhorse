# frozen_string_literal: true

require "spec_helper"

RSpec.describe "Worker heartbeat round bound" do
  heartbeat = Stablemates::Workhorse::Worker.const_get(:Heartbeat)

  it "is three quarters of the interval from 200 ms, and the interval up to 50 ms" do
    expect([0.01, 0.04, 0.05, 0.066, 0.069, 0.2, 10.0].map { |interval| heartbeat.round_bound(interval) })
      .to eq([0.01, 0.04, 0.05, 0.05, 0.051, 0.15, 7.5])
  end

  it "leaves a renewal margin after one timed-out round with the defaults" do
    lease = 30.0
    interval = lease / 3
    expect(2 * interval + heartbeat.round_bound(interval)).to be < lease
  end
end

RSpec.describe "Worker heartbeat statement order" do
  heartbeat_class = Stablemates::Workhorse::Worker.const_get(:Heartbeat)
  member = Struct.new(:worker_id, :name)
  members = [member.new("a", 1), member.new("b", 2), member.new("a", 3)]

  it "starts each dedicated round with the next worker, so no worker is always last" do
    heartbeat = heartbeat_class.new(nil, dedicated: true)
    firsts = Array.new(4) { heartbeat.send(:ordered_groups, members).first.first }
    expect(firsts).to eq(%w[a b a b])
    expect(heartbeat.send(:ordered_groups, members).to_h.transform_values { |group| group.map(&:name) })
      .to eq("a" => [1, 3], "b" => [2])
  end

  it "keeps the order of a borrowing heartbeat, which sends every statement" do
    heartbeat = heartbeat_class.new(nil, dedicated: false)
    firsts = Array.new(3) { heartbeat.send(:ordered_groups, members).first.first }
    expect(firsts).to eq(%w[a a a])
  end
end
