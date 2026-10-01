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
end
