# frozen_string_literal: true

require "spec_helper"

RSpec.describe "Workhorse.checkpoint_input_fingerprint" do
  # protocol/v1/checkpoint-fingerprints.json holds the vectors that every SDK must give.
  fixture = File.expand_path("../../../protocol/v1/checkpoint-fingerprints.json", __dir__)
  vectors = JSON.parse(File.read(fixture)).fetch("vectors")
  # The json gem refuses a lone surrogate escape when it decodes the text, before the fingerprint.
  refusals = {
    "loneSurrogate" => [JSON::ParserError, /surrogate/],
    "nonFinite" => [ArgumentError, "checkpoint input contains a non-finite number"],
    "unsafeNumber" => [ArgumentError, "checkpoint input numbers must be at most 2**53 - 1 in magnitude"]
  }

  it "reads the shared vectors" do
    expect(vectors).not_to be_empty
  end

  vectors.each do |vector|
    it "gives the outcome of the vector #{vector.fetch("id")}" do
      fingerprint = -> { W.checkpoint_input_fingerprint(JSON.parse(vector.fetch("input"))) }
      if vector.key?("refusal")
        expect(&fingerprint).to raise_error(*refusals.fetch(vector.fetch("refusal")))
      else
        expect(fingerprint.call).to eq(vector.fetch("digest"))
      end
    end
  end

  it "writes numbers in the RFC 8785 form" do
    # The fingerprint refuses a magnitude above 2**53 - 1, so this test calls the number form.
    number = ->(value) { W::CheckpointFingerprint.number(value) }
    expect([1e20, 1e16, 100.0, 123.456, 1e-6, 1.234e-6, -2.5e-8, 5e-324, 1.7976931348623157e308].map(&number))
      .to eq(%w[100000000000000000000 10000000000000000 100 123.456 0.000001 0.000001234 -2.5e-8 5e-324
        1.7976931348623157e+308])
  end

  it "rejects an input that is not JSON or not valid UTF-8" do
    expect { W.checkpoint_input_fingerprint({"amount" => Float::NAN}) }
      .to raise_error(ArgumentError, "checkpoint input contains a non-finite number")
    expect { W.checkpoint_input_fingerprint({amount: 1}) }
      .to raise_error(ArgumentError, "checkpoint input object keys must be Strings")
    expect { W.checkpoint_input_fingerprint(Object.new) }
      .to raise_error(ArgumentError, /contains Object, which is not a JSON value/)
    expect { W.checkpoint_input_fingerprint("\xED\xA0\x80") }
      .to raise_error(ArgumentError, "checkpoint input strings must be valid UTF-8")
    expect { W.checkpoint_input_fingerprint(["\xFF".b]) }
      .to raise_error(ArgumentError, "checkpoint input strings must be valid UTF-8")
  end
end
