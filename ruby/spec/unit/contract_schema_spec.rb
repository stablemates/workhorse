# frozen_string_literal: true

RSpec.describe Stablemates::Workhorse::ContractSchema do
  def schema(document) = described_class.new(document)

  fixtures = JSON.parse(File.read(File.expand_path("../../../protocol/v1/contracts.json", __dir__)))
  # A Ruby value holds an exact Integer, but JSON.parse reads a fraction as a Float, so Ruby cannot
  # hold a fraction that a double cannot hold. The shared table marks those instances.
  unheld_numbers = %w[exactFraction].freeze
  fixtures.each do |fixture|
    it "matches the protocol contract fixture #{fixture.fetch("id")}" do
      # A schema in JSON text reads the way a schema that PostgreSQL stores does.
      build = lambda do
        next schema(fixture.fetch("schema")) unless fixture.key?("schemaJson")

        Stablemates::Workhorse::ContractSchema.stored(Stablemates::Workhorse::Contracts.parse_schema(fixture["schemaJson"]))
      end
      if fixture["schemaError"]
        expect { build.call }.to raise_error(ArgumentError)
        next
      end
      validator = build.call
      fixture.fetch("instances", []).each do |instance|
        next if unheld_numbers.include?(instance["needs"])

        value = instance.key?("json") ? JSON.parse(instance.fetch("json")) : instance.fetch("value")
        expect(validator.valid?(value)).to be(instance.fetch("valid")), instance.inspect
      end
    end
  end

  it "keeps a stored fraction that a Float cannot hold as a Rational" do
    stored = Stablemates::Workhorse::Contracts.parse_schema('{"minimum": 0.30000000000000000001, "maximum": 1.5}')
    expect(stored).to eq("minimum" => Rational("0.30000000000000000001"), "maximum" => 1.5)
    expect(stored["maximum"]).to be_a(Float)
    validator = Stablemates::Workhorse::ContractSchema.stored(stored)
    expect(validator.valid?(0.3)).to be(false)
    expect(validator.valid?(0.30000000000000004)).to be(true)
    expect { described_class.new(stored) }.to raise_error(ArgumentError)
  end

  it "refuses a non-finite Float under multipleOf" do
    expect(schema("multipleOf" => 0.1).valid?(Float::INFINITY)).to be(false)
    expect(schema("multipleOf" => 0.1).valid?(Float::NAN)).to be(false)
    expect(schema("multipleOf" => 0.1).valid?(0.3)).to be(true)
  end

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
    expect(described_class.profile_violation({"properties" => {"a" => {"$dynamicRef" => "#x"}}}))
      .to eq("$.properties.a.$dynamicRef is outside the Workhorse contract profile")
  end

  it "refuses a keyword whose value the draft 2020-12 meta-schema refuses" do
    [
      {"type" => "strnig"}, {"type" => %w[string string]}, {"minimum" => "1"}, {"maxLength" => -1},
      {"maxItems" => 1.5}, {"required" => [1]}, {"enum" => "a"}, {"uniqueItems" => "yes"},
      {"properties" => []}, {"items" => 1}, {"allOf" => []}
    ].each do |document|
      expect { schema(document) }.to raise_error(ArgumentError), document.inspect
    end
  end

  it "names the pattern keyword it refuses at any depth" do
    {"$.properties.a.pattern" => {"properties" => {"a" => {"type" => "string", "pattern" => "^a$"}}},
     "$.items.patternProperties" => {"items" => {"patternProperties" => {"^a" => true}}}}.each do |path, document|
      expect { schema(document) }.to raise_error(ArgumentError, /#{Regexp.escape(path)} is outside the Workhorse contract profile/)
    end
  end

  it "refuses a reference that leaves the profile-checked schema tree" do
    document = {"default" => {"pattern" => "^a$"}, "properties" => {"a" => {"$ref" => "#/default"}}}
    expect { schema(document) }.to raise_error(ArgumentError, "$.properties.a.$ref must point at a subschema of the contract")
  end

  it "names the anchor and definition forms outside the profile" do
    {
      {"items" => {"$anchor" => "a"}} => "$.items.$anchor is outside the Workhorse contract profile",
      {"items" => {"$defs" => {}}} => "$.items.$defs must appear only on the root schema",
      {"$defs" => {"a b" => true}} => "$.$defs.a b must be a definition name matching ^[A-Za-z_][-A-Za-z0-9._]*$"
    }.each do |document, message|
      expect { schema(document) }.to raise_error(ArgumentError, message)
    end
  end
end
