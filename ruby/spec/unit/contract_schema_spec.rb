# frozen_string_literal: true

RSpec.describe Stablemates::Workhorse::ContractSchema do
  def schema(document) = described_class.new(document)

  it "validates draft 2020-12 keywords" do
    person = schema(
      "$defs" => {"name" => {"type" => "string", "minLength" => 1}},
      "type" => "object",
      "properties" => {"name" => {"$ref" => "#/$defs/name"}, "age" => {"type" => "integer", "minimum" => 0},
                       "tags" => {"type" => "array", "items" => {"enum" => %w[a b]}, "uniqueItems" => true}},
      "required" => ["name"],
      "additionalProperties" => false
    )
    expect(person.valid?({"name" => "Ann", "age" => 3, "tags" => ["a"]})).to be(true)
    expect(person.valid?({"age" => 3})).to be(false)
    expect(person.valid?({"name" => ""})).to be(false)
    expect(person.valid?({"name" => "Ann", "age" => -1})).to be(false)
    expect(person.valid?({"name" => "Ann", "tags" => %w[a a]})).to be(false)
    expect(person.valid?({"name" => "Ann", "extra" => true})).to be(false)
    expect(schema(true).valid?(1)).to be(true)
    expect(schema(false).valid?(1)).to be(false)
  end

  it "applies combinators and conditionals" do
    either = schema("oneOf" => [{"type" => "string"}, {"type" => "integer"}])
    expect(either.valid?("x")).to be(true)
    expect(either.valid?(1.5)).to be(false)
    conditional = schema("if" => {"properties" => {"kind" => {"const" => "a"}}},
      "then" => {"required" => ["a"]}, "else" => {"required" => ["b"]})
    expect(conditional.valid?({"kind" => "a", "a" => 1})).to be(true)
    expect(conditional.valid?({"kind" => "c", "a" => 1})).to be(false)
  end

  it "treats format as an annotation" do
    expect(schema("type" => "string", "format" => "email").valid?("not an email")).to be(true)
  end

  it "refuses schemas outside the profile" do
    expect { schema("$ref" => "https://example.com/schema") }.to raise_error(ArgumentError)
    expect { schema("$schema" => "http://json-schema.org/draft-07/schema#") }.to raise_error(ArgumentError)
    expect { schema("unevaluatedProperties" => false) }.to raise_error(ArgumentError)
    expect { schema("$ref" => "#/$defs/missing") }.to raise_error(ArgumentError)
    expect { schema("pattern" => "(") }.to raise_error(ArgumentError)
    expect(described_class.profile_violation({"properties" => {"a" => {"$dynamicRef" => "#x"}}}))
      .to eq("$.properties.a.$dynamicRef is outside the Workhorse contract profile")
  end
end
