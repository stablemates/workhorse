# frozen_string_literal: true

# PostgreSQL limits a value by octet_length(value::jsonb::text), so the worker measures that text.
RSpec.describe W::Values do
  {
    "a multibyte string" => ["é€😀", 11],
    "escaped control characters, DEL, and a slash" => ["\u0001\n\"\\\u007f/", 16],
    "a positive exponent" => [1e+20, 21],
    "a negative exponent with a fraction" => [1.23e-20, 24],
    "a negative number with a negative exponent" => [-2.5e-10, 14],
    "negative zero" => [-0.0, 3],
    "a plain float" => [1.5, 3],
    "an integer beyond 64 bits" => [2**70, 22],
    "the literals" => [[nil, true, false], 19],
    "nested containers with separators" => [[1, {"a" => "é", "b" => []}], 25],
    "empty containers" => [[{}, []], 8]
  }.each do |description, (value, bytes)|
    it "measures #{description} as #{bytes} bytes of jsonb text" do
      expect(described_class.jsonb_text_bytes(described_class.json(value))).to eq(bytes)
    end
  end

  # A custom to_json can write any JSON number, and jsonb keeps the scale its token states.
  {
    "1e20" => 21, "1E+20" => 21, "1.00000" => 7, "0.5e1" => 1, "1.5E-3" => 6, "-0e5" => 1,
    "0.00" => 4, "-1.50e1" => 5, "120E-1" => 4, '{"a":1,"a":2.50}' => 11
  }.each do |text, bytes|
    it "measures the token #{text} as #{bytes} bytes of jsonb text" do
      expect(described_class.jsonb_text_bytes(text)).to eq(bytes)
    end
  end

  describe ".milliseconds" do
    it "names the lower limit of an endless range" do
      [0, -1, Float::NAN, "1", nil].each do |value|
        expect { described_class.milliseconds(value, "heartbeat", 1..) }
          .to raise_error(ArgumentError, "heartbeat must be a finite Numeric count of seconds of at least 0.001")
      end
      expect(described_class.milliseconds(0.001, "heartbeat", 1..)).to eq(1)
    end

    it "names both limits of a bounded range" do
      expect { described_class.milliseconds(0, "lease", 100..86_400_000) }
        .to raise_error(ArgumentError, "lease must be a finite Numeric count of seconds between 0.1 and 86400")
    end
  end

  # Five worker options have no upper limit. A bad value raises ArgumentError before the worker
  # touches PostgreSQL.
  describe "an interval option of a worker" do
    pool_class = Class.new(FakeExecutor) do
      def size = 3

      def with = raise("unit specs never check out a connection")
    end

    {
      heartbeat: [0, "0.001"],
      poll_interval: [0, "0.001"],
      maintenance_interval: [0.05, "0.1"],
      maintenance_routine_interval: [0.05, "0.1"],
      registry_interval: [0.05, "0.1"]
    }.each do |option, (value, limit)|
      it "raises ArgumentError for #{option}: #{value}" do
        pool = pool_class.new
        options = {queues: ["default"], polling_only: true}.merge(option => value)
        expect { W::Worker.new(pool, **options) }
          .to raise_error(ArgumentError, "#{option} must be a finite Numeric count of seconds of at least #{limit}")
        expect(pool.statements).to be_empty
      end
    end
  end
end
