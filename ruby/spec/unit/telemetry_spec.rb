# frozen_string_literal: true

require "opentelemetry"
require "spec_helper"

RSpec.describe "The workhorse.handler span" do
  # Records the parent context each span starts from.
  let(:tracer) do
    Class.new(OpenTelemetry::Trace::Tracer) do
      attr_reader :parents

      def initialize
        super
        @parents = {}
      end

      def start_span(name, with_parent: nil, **)
        @parents[name] = OpenTelemetry::Trace.current_span(with_parent).context
        OpenTelemetry::Trace.non_recording_span(OpenTelemetry::Trace::SpanContext.new)
      end
    end.new
  end

  let(:unrelated) { OpenTelemetry::Trace.non_recording_span(OpenTelemetry::Trace::SpanContext.new) }

  before { allow(W::Telemetry).to receive(:tracer).and_return(tracer) }

  def under_unrelated_span(&block)
    OpenTelemetry::Trace.with_span(unrelated, &block)
  end

  it "starts a new trace for a task without a stored trace context" do
    under_unrelated_span { W::Telemetry.span("workhorse.handler", {}, trace_context: nil, consumer: true) { nil } }
    expect(tracer.parents.fetch("workhorse.handler")).not_to be_valid
  end

  it "parents a task with a stored trace context to that context" do
    stored = {"traceparent" => "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}
    under_unrelated_span { W::Telemetry.span("workhorse.handler", {}, trace_context: stored, consumer: true) { nil } }
    parent = tracer.parents.fetch("workhorse.handler")
    expect(parent.hex_trace_id).to eq("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(parent.hex_span_id).to eq("00f067aa0ba902b7")
  end

  it "leaves an internal span parented to the current span" do
    under_unrelated_span { W::Telemetry.span("workhorse.claim", {}) { nil } }
    expect(tracer.parents.fetch("workhorse.claim")).to eq(unrelated.context)
  end
end

RSpec.describe "The worker instruments" do
  # The kind, unit, and description of each instrument in api/telemetry.txt.
  let(:contract) do
    text = File.read(File.expand_path("../../../api/telemetry.txt", __dir__))
    rows = text.split("## Instruments", 2).last.split("## Spans", 2).first.lines
    rows.map { |line| line.split(/\s+/, 4).map(&:strip) }
      .select { |row| row.size == 4 && row.first.start_with?("workhorse.") }
      .to_h { |name, kind, unit, description| [name, [kind.to_sym, description, unit]] }
  end

  it "match the kind, unit, and description in api/telemetry.txt" do
    W::Telemetry.const_get(:INSTRUMENTS).each do |name, declared|
      expect(declared).to eq(contract.fetch(name)), name
    end
  end
end
