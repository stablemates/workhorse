# frozen_string_literal: true

require_relative "unit_helper"

class ContractSchemaTest < UnitTest
  def schema(document) = W::ContractSchema.new(document)

  def test_validates_draft_2020_12_keywords
    person = schema(
      "$defs" => { "name" => { "type" => "string", "minLength" => 1 } },
      "type" => "object",
      "properties" => { "name" => { "$ref" => "#/$defs/name" }, "age" => { "type" => "integer", "minimum" => 0 },
                        "tags" => { "type" => "array", "items" => { "enum" => %w[a b] }, "uniqueItems" => true } },
      "required" => ["name"],
      "additionalProperties" => false
    )
    assert person.valid?({ "name" => "Ann", "age" => 3, "tags" => ["a"] })
    refute person.valid?({ "age" => 3 })
    refute person.valid?({ "name" => "" })
    refute person.valid?({ "name" => "Ann", "age" => -1 })
    refute person.valid?({ "name" => "Ann", "tags" => %w[a a] })
    refute person.valid?({ "name" => "Ann", "extra" => true })
    assert schema(true).valid?(1)
    refute schema(false).valid?(1)
  end

  def test_combinators_and_conditionals
    either = schema("oneOf" => [{ "type" => "string" }, { "type" => "integer" }])
    assert either.valid?("x")
    refute either.valid?(1.5)
    conditional = schema("if" => { "properties" => { "kind" => { "const" => "a" } } },
                         "then" => { "required" => ["a"] }, "else" => { "required" => ["b"] })
    assert conditional.valid?({ "kind" => "a", "a" => 1 })
    refute conditional.valid?({ "kind" => "c", "a" => 1 })
  end

  def test_format_is_an_annotation
    assert schema("type" => "string", "format" => "email").valid?("not an email")
  end

  def test_refuses_schemas_outside_the_profile
    assert_raises(ArgumentError) { schema("$ref" => "https://example.com/schema") }
    assert_raises(ArgumentError) { schema("$schema" => "http://json-schema.org/draft-07/schema#") }
    assert_raises(ArgumentError) { schema("unevaluatedProperties" => false) }
    assert_raises(ArgumentError) { schema("$ref" => "#/$defs/missing") }
    assert_raises(ArgumentError) { schema("pattern" => "(") }
    assert_equal "$.properties.a.$dynamicRef is outside the Workhorse contract profile",
                 W::ContractSchema.profile_violation({ "properties" => { "a" => { "$dynamicRef" => "#x" } } })
  end
end
