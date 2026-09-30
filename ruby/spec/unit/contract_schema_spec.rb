# frozen_string_literal: true

RSpec.describe Stablemates::Workhorse::ContractSchema do
  def schema(document) = described_class.new(document)

  fixtures = JSON.parse(File.read(File.expand_path("../../../protocol/v1/contracts.json", __dir__)))
  fixtures.each do |fixture|
    it "matches the protocol contract fixture #{fixture.fetch("id")}" do
      if fixture["schemaError"]
        expect { schema(fixture.fetch("schema")) }.to raise_error(ArgumentError)
        next
      end
      validator = schema(fixture.fetch("schema"))
      fixture.fetch("instances", []).each do |instance|
        expect(validator.valid?(instance.fetch("value"))).to be(instance.fetch("valid")), instance.inspect
      end
    end
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
    expect { schema("pattern" => "(") }.to raise_error(ArgumentError)
    expect(described_class.profile_violation({"properties" => {"a" => {"$dynamicRef" => "#x"}}}))
      .to eq("$.properties.a.$dynamicRef is outside the Workhorse contract profile")
  end

  it "refuses a keyword whose value the draft 2020-12 meta-schema refuses" do
    [
      {"type" => "strnig"}, {"type" => %w[string string]}, {"minimum" => "1"}, {"maxLength" => -1},
      {"maxItems" => 1.5}, {"required" => [1]}, {"enum" => "a"}, {"uniqueItems" => "yes"},
      {"pattern" => 1}, {"properties" => []}, {"items" => 1}, {"allOf" => []}, {"$anchor" => "1a"}
    ].each do |document|
      expect { schema(document) }.to raise_error(ArgumentError), document.inspect
    end
  end

  it "matches patterns with ECMA-262 semantics" do
    anchored = schema("type" => "string", "pattern" => "^a$")
    expect(anchored.valid?("a")).to be(true)
    expect(anchored.valid?("a\nb")).to be(false), "^ and $ do not match at line ends"
    expect(schema("pattern" => "^.$").valid?("\r")).to be(false), ". excludes every line terminator"
    expect(schema("pattern" => "^\\s$").valid?("\u0085")).to be(false), "\\s excludes NEL"
    expect(schema("pattern" => "^\\w$").valid?("é")).to be(false), "\\w is ASCII"
    expect(schema("pattern" => "\\bb").valid?("éb")).to be(true), "\\b uses ASCII word characters"
    expect(schema("pattern" => "^(?<x>a)(b)\\2$").valid?("abb")).to be(true), "a plain group still captures"
    expect(schema("pattern" => "^\\p{Lu}$").valid?("A")).to be(true)
    ["\\p{greek}", "\\p{Alnum}", "(?i)a", "\\A", "\\h", "a{2,1}", "\\1"].each do |source|
      expect { schema("pattern" => source) }.to raise_error(ArgumentError), source
    end
  end

  it "resolves an anchor declared after its reference and refuses a duplicate" do
    document = {"properties" => {"a" => {"$ref" => "#name"}}, "$defs" => {"name" => {"$anchor" => "name", "type" => "string"}}}
    expect(schema(document).valid?({"a" => "x"})).to be(true)
    expect(schema(document).valid?({"a" => 1})).to be(false)
    duplicate = {"$defs" => {"a" => {"$anchor" => "x"}, "b" => {"$anchor" => "x"}}}
    expect { schema(duplicate) }.to raise_error(ArgumentError)
  end
end
