# frozen_string_literal: true

require "spec_helper"

RSpec.describe "Workhorse.checkpoint_input_fingerprint" do
  # The vectors of typescript/core/test/checkpoint-fingerprint.test.ts, which every SDK must match.
  # The last vector orders keys by UTF-16 code units: U+1F600 encodes as D83D DE00, before U+FB33.
  # 2**53 - 1 is the largest number magnitude that an input can hold.
  vectors = [
    [nil, "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"],
    [true, "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b"],
    [0, "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"],
    [1.5, "9f29a130438b81170b92a42650f9a94291ecad60bd47af2a3886e75f7f728725"],
    [9_007_199_254_740_991, "f40b423c2dd95ff2b2f027e22208f438cf7242862e5e746860e697308c9add26"],
    [-9_007_199_254_740_991, "4c933a456bb8f2e9894b2d0b26480439cd72d52fb8a27cbf8fd7f323f22c7815"],
    [9_007_199_254_740_991.0, "f40b423c2dd95ff2b2f027e22208f438cf7242862e5e746860e697308c9add26"],
    [1e-7, "5b33e02f2c5103a05d32f6ba9cb058294452bfbf393967f68bb30c1bdcbbab22"],
    ["é", "f2886017e9c7abacf804b54d64787dce2b611c9544ba21f3affdd126a6e50086"],
    [[], "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"],
    [{}, "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"],
    [{"amountCents" => 1000, "currency" => "EUR"}, "f5e4dce1a6a38b7186257335fb274c4221391505f139b60596c5f57ce4924471"],
    [{"b" => [1, {"d" => 2, "c" => 3}], "a" => "x"}, "4bc2f0faf907fa5fdaedde9cbf7002e3cbf041208b96a4ab4ce6693fbf4bea67"],
    [{"\u{1F600}" => 1, "\u{FB33}" => 2}, "2aa3f5086e32bb90ce39c508a6f40fd72e792684f130d0f3b896ea191368f1e3"]
  ]

  vectors.each do |input, digest|
    it "hashes the canonical JSON of #{input.inspect}" do
      expect(W.checkpoint_input_fingerprint(input)).to eq(digest)
    end
  end

  it "ignores key order and gives a different digest for a different input" do
    charge = {"amountCents" => 1000, "currency" => "EUR"}
    expect(W.checkpoint_input_fingerprint({"currency" => "EUR", "amountCents" => 1000}))
      .to eq(W.checkpoint_input_fingerprint(charge))
    expect(W.checkpoint_input_fingerprint(charge.merge("amountCents" => 900)))
      .not_to eq(W.checkpoint_input_fingerprint(charge))
    expect(W.checkpoint_input_fingerprint(-0.0)).to eq(W.checkpoint_input_fingerprint(0))
    expect(W.checkpoint_input_fingerprint(1.0)).to eq(W.checkpoint_input_fingerprint(1))
  end

  it "writes numbers and strings in the RFC 8785 form" do
    canonical = ->(value) { W::CheckpointFingerprint.canonical(value) }
    # The fingerprint refuses a magnitude above 2**53 - 1, so this test calls the number form.
    number = ->(value) { W::CheckpointFingerprint.number(value) }
    expect([1e20, 1e16, 100.0, 123.456, 1e-6, 1.234e-6, -2.5e-8, 5e-324, 1.7976931348623157e308].map(&number))
      .to eq(%w[100000000000000000000 10000000000000000 100 123.456 0.000001 0.000001234 -2.5e-8 5e-324
        1.7976931348623157e+308])
    expect(canonical.call(9_007_199_254_740_991)).to eq("9007199254740991")
    expect(canonical.call("q\"\\\b\t\n\f\r\u0001\u007f /")).to eq("\"q\\\"\\\\\\b\\t\\n\\f\\r\\u0001\u007f /\"")
  end

  it "rejects an input that is not JSON with finite numbers and valid UTF-8" do
    expect { W.checkpoint_input_fingerprint({"amount" => Float::NAN}) }
      .to raise_error(ArgumentError, "checkpoint input contains a non-finite number")
    expect { W.checkpoint_input_fingerprint({amount: 1}) }
      .to raise_error(ArgumentError, "checkpoint input object keys must be Strings")
    expect { W.checkpoint_input_fingerprint(Object.new) }
      .to raise_error(ArgumentError, /contains Object, which is not a JSON value/)
    [2**53, -(2**53), 2**64, {"id" => (2**53) + 1}, 2.0**53, [1e21], -Float::MAX].each do |input|
      expect { W.checkpoint_input_fingerprint(input) }
        .to raise_error(ArgumentError, "checkpoint input numbers must be at most 2**53 - 1 in magnitude")
    end
    expect { W.checkpoint_input_fingerprint("\xED\xA0\x80") }
      .to raise_error(ArgumentError, "checkpoint input strings must be valid UTF-8")
    expect { W.checkpoint_input_fingerprint(["\xFF".b]) }
      .to raise_error(ArgumentError, "checkpoint input strings must be valid UTF-8")
  end
end
