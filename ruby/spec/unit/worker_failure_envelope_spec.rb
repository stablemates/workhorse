# frozen_string_literal: true

require "spec_helper"

# PostgreSQL's jsonb stores no NUL, and the JSON generator refuses text that is not UTF-8. Either
# refusal used to end the worker instead of recording the handler's failure (SM-1650).
RSpec.describe W::Worker do
  # The envelope reads no worker state, so the worker needs no pool.
  subject(:worker) { described_class.allocate }

  def envelope(error) = worker.send(:error_envelope, error, false)

  it "replaces each NUL and each byte that is not UTF-8 in every field" do
    error = RuntimeError.new("a\u0000b \xFF c \u{1F600} �".dup.force_encoding(Encoding::UTF_8))
    error.set_backtrace(["at\u0000here"])
    recorded = envelope(error)
    expect(recorded["name"]).to eq("RuntimeError")
    expect(recorded["message"]).to eq("a�b � c \u{1F600} �")
    expect(recorded["stack"]).to include("a�b", "at�here")
    expect(recorded["stack"]).not_to include("\u0000")
    expect(JSON.generate(recorded)).not_to include("\\u0000")
  end

  it "reads a binary message as UTF-8 and keeps ordinary text" do
    expect(envelope(RuntimeError.new("caf\xC3\xA9 \x00".b))["message"]).to eq("café �")
    expect(envelope(RuntimeError.new("plain"))["message"]).to eq("plain")
    expect(envelope(RuntimeError.new("x\xE1\x80y".dup.force_encoding(Encoding::UTF_8)))["message"]).to eq("x\uFFFD\uFFFDy")
  end

  it "replaces a NUL in a name that a class defines for itself" do
    named = Class.new(StandardError) { def self.name = "Payment\u0000Declined" }
    expect(envelope(named.new("x"))["name"]).to eq("Payment�Declined")
  end

  # An anonymous class has a nil name, and the envelope recorded JSON null (SM-1668, PAR-14).
  it "records the nearest named superclass for an anonymous error class" do
    anonymous = Class.new(StandardError)
    recorded = envelope(anonymous.new("declined"))
    expect(recorded["name"]).to eq("StandardError")
    expect(JSON.parse(JSON.generate(recorded))["name"]).to eq("StandardError")
    expect(envelope(Class.new(anonymous).new("x"))["name"]).to eq("StandardError")
    expect(envelope(Class.new(ArgumentError).new("x"))["name"]).to eq("ArgumentError")
  end
end
