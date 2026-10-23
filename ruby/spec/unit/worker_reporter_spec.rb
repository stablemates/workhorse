# frozen_string_literal: true

require "logger"
require "spec_helper"

# SM-1696: a reporter callback that raises never stops the worker, and its report is bounded.
RSpec.describe "A worker reporter callback that raises" do
  # A pool whose every statement fails, as a short database outage does.
  let(:offline_pool) do
    Class.new do
      def size = 3

      def with = raise(IOError, "registry is offline")
    end.new
  end

  let(:calls) { [] }

  let(:reporter) do
    lambda do |error|
      calls << error
      raise "alert client is offline"
    end
  end

  def worker(**options)
    W::Worker.new(offline_pool, queues: ["default"], polling_only: true, **options)
  end

  it "does not stop registration, and reports once in each interval" do
    subject = worker(on_registration_error: reporter)
    allow(Kernel).to receive(:warn)

    3.times { subject.send(:refresh_registration, force: true) }

    expect(calls.map(&:class)).to eq([IOError] * 3)
    expect(subject.instance_variable_get(:@registered)).not_to be_true
    expect(Kernel).to have_received(:warn).once.with(
      "workhorse: Workhorse worker on_registration_error reporter failed: RuntimeError: alert client is offline"
    )

    # After the interval, the next report states the failures that the worker did not log.
    failures = subject.instance_variable_get(:@reporter_failures)
    reported_at, count = failures[:on_registration_error]
    failures[:on_registration_error] = [reported_at - 60.0, count]
    subject.send(:refresh_registration, force: true)
    expect(Kernel).to have_received(:warn).with(
      "workhorse: Workhorse worker on_registration_error reporter failed after 2 unreported failures: " \
      "RuntimeError: alert client is offline"
    )
  end

  it "reports a notification reporter failure through the logger" do
    output = StringIO.new
    subject = worker(on_notification_error: reporter, logger: Logger.new(output))

    2.times do
      subject.send(:call_reporter, :on_notification_error, subject.instance_variable_get(:@on_notification_error),
        IOError.new("listener is offline"))
    end

    expect(output.string.scan("Workhorse worker on_notification_error reporter failed").size).to eq(1)
  end

  it "ignores a logger that raises while it reports" do
    logger = Logger.new(StringIO.new)
    allow(logger).to receive(:error).and_raise(IOError, "formatter broke")
    subject = worker(on_registration_error: reporter, logger: logger)

    expect { subject.send(:refresh_registration, force: true) }.not_to raise_error
    expect(calls.size).to eq(1)
  end
end
