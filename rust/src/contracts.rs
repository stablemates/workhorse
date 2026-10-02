//! Versioned payload contracts: the Workhorse JSON Schema profile, compilation, and sync.
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::queue::Executor;
use crate::sql_catalogue_generated as sql;
use crate::Error;

/// One version of a task type's payload and result contract.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskContractVersion {
    /// A Draft 2020-12 schema inside the Workhorse profile; `true` accepts anything.
    pub payload_schema: Value,
    pub result_schema: Value,
    pub max_payload_bytes: i32,
    pub max_result_bytes: i32,
    pub sensitive_payload_keys: Vec<String>,
    pub sensitive_result_keys: Vec<String>,
}

impl Default for TaskContractVersion {
    fn default() -> Self {
        Self {
            payload_schema: Value::Bool(true),
            result_schema: Value::Bool(true),
            max_payload_bytes: sql::DEFAULT_TASK_VALUE_MAX_BYTES as i32,
            max_result_bytes: sql::DEFAULT_TASK_VALUE_MAX_BYTES as i32,
            sensitive_payload_keys: Vec::new(),
            sensitive_result_keys: Vec::new(),
        }
    }
}

/// Every retained contract version of one task type and the version new tasks use.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TaskTypeContracts {
    pub current_version: String,
    pub versions: BTreeMap<String, TaskContractVersion>,
}

/// A compiled contract schema.
pub struct ContractSchema(jsonschema::Validator);

impl ContractSchema {
    pub fn is_valid(&self, instance: &Value) -> bool {
        self.0.is_valid(instance)
    }
}

impl std::fmt::Debug for ContractSchema {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ContractSchema")
    }
}

const SCHEMA_VALUES: &[&str] =
    &["additionalProperties", "contains", "else", "if", "items", "not", "propertyNames", "then"];
const SCHEMA_ARRAYS: &[&str] = &["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_MAPS: &[&str] = &["$defs", "dependentSchemas", "properties"];
const PLAIN_KEYWORDS: &[&str] = &[
    "$comment",
    "$schema",
    "default",
    "deprecated",
    "description",
    "examples",
    "format",
    "readOnly",
    "title",
    "writeOnly",
    "const",
    "dependentRequired",
    "enum",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "maxContains",
    "maximum",
    "maxItems",
    "maxLength",
    "maxProperties",
    "minContains",
    "minimum",
    "minItems",
    "minLength",
    "minProperties",
    "multipleOf",
    "required",
    "type",
    "uniqueItems",
];
const DIALECT: &str = "https://json-schema.org/draft/2020-12/schema";

const DEFINITION_NAME: &str = "^[A-Za-z_][-A-Za-z0-9._]*$";
const DEFINITION_REFERENCE_PREFIX: &str = "#/$defs/";

/// Requires every reference to name the root schema or one root definition. The libraries behind
/// the five SDKs resolve those two forms alike, and both name a schema position the profile walk
/// checked.
fn check_contract_profile(schema: &Value) -> Result<(), String> {
    let mut references = Vec::new();
    check_profile(schema, "$", &mut references)?;
    for (path, reference) in &references {
        if !references_subschema(schema, reference) {
            return Err(format!("{path} must point at a subschema of the contract"));
        }
    }
    Ok(())
}

fn references_subschema(root: &Value, reference: &str) -> bool {
    if reference == "#" {
        return true;
    }
    let Some(name) = reference.strip_prefix(DEFINITION_REFERENCE_PREFIX) else {
        return false;
    };
    root.get("$defs")
        .and_then(Value::as_object)
        .is_some_and(|definitions| definitions.contains_key(name))
}

/// Matches `DEFINITION_NAME` without a regular expression engine.
fn is_definition_name(name: &str) -> bool {
    let mut characters = name.chars();
    characters.next().is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|rest| rest.is_ascii_alphanumeric() || matches!(rest, '-' | '.' | '_'))
}

fn check_profile<'a>(
    schema: &'a Value,
    path: &str,
    references: &mut Vec<(String, &'a str)>,
) -> Result<(), String> {
    let document = match schema {
        Value::Bool(_) => return Ok(()),
        Value::Object(document) => document,
        _ => return Err(format!("{path} must be an object or boolean JSON Schema")),
    };
    for (keyword, value) in document {
        let keyword_path = format!("{path}.{keyword}");
        let keyword = keyword.as_str();
        if keyword == "$ref" {
            if !value.as_str().is_some_and(|reference| reference.starts_with('#')) {
                return Err(format!("{keyword_path} must be a bundled local reference"));
            }
            if let Some(reference) = value.as_str() {
                references.push((keyword_path, reference));
            }
        } else if keyword == "$schema" {
            if value.as_str() != Some(DIALECT) {
                return Err(format!("{keyword_path} must select Draft 2020-12"));
            }
        } else if keyword == "$defs" && path != "$" {
            return Err(format!("{keyword_path} must appear only on the root schema"));
        } else if SCHEMA_VALUES.contains(&keyword) {
            check_profile(value, &keyword_path, references)?;
        } else if SCHEMA_ARRAYS.contains(&keyword) {
            let children =
                value.as_array().ok_or_else(|| format!("{keyword_path} must be an array"))?;
            for (index, child) in children.iter().enumerate() {
                check_profile(child, &format!("{keyword_path}[{index}]"), references)?;
            }
        } else if SCHEMA_MAPS.contains(&keyword) {
            let children =
                value.as_object().ok_or_else(|| format!("{keyword_path} must be an object"))?;
            for (name, child) in children {
                let child_path = format!("{keyword_path}.{name}");
                if keyword == "$defs" && !is_definition_name(name) {
                    return Err(format!(
                        "{child_path} must be a definition name matching {DEFINITION_NAME}"
                    ));
                }
                check_profile(child, &child_path, references)?;
            }
        } else if !PLAIN_KEYWORDS.contains(&keyword) {
            return Err(format!("{keyword_path} is outside the Workhorse contract profile"));
        }
    }
    Ok(())
}

/// Checks a schema against the Workhorse contract profile and compiles it as Draft 2020-12.
///
/// `format` is an annotation, and only bundled local references resolve.
pub fn compile_contract_schema(schema: &Value) -> Result<ContractSchema, Error> {
    check_contract_profile(schema).map_err(Error::InvalidArgument)?;
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .should_validate_formats(false)
        .with_base_uri("urn:workhorse:contract")
        .build(schema)
        .map(ContractSchema)
        .map_err(|error| Error::invalid(format!("invalid contract schema: {error}")))
}

/// The current contract PostgreSQL holds for one task type.
pub(crate) struct PayloadContract {
    pub version: String,
    pub validator: ContractSchema,
    pub payload_max_bytes: i32,
    pub result_max_bytes: i32,
    pub payload_redact_keys: Vec<String>,
    pub result_redact_keys: Vec<String>,
}

/// Contracts a queue has loaded; before `sync_contracts`, only types PostgreSQL reported.
#[derive(Default)]
pub(crate) struct ContractCache {
    pub enabled: bool,
    pub definitions: HashMap<String, Option<Arc<PayloadContract>>>,
}

pub(crate) async fn load_contract<E: Executor>(
    executor: &E,
    task_type: &str,
) -> Result<Option<Arc<PayloadContract>>, Error> {
    load_contract_version(executor, task_type, None).await
}

/// Loads `version` of a task type's contract, or its current contract when `version` is `None`.
pub(crate) async fn load_contract_version<E: Executor>(
    executor: &E,
    task_type: &str,
    version: Option<&str>,
) -> Result<Option<Arc<PayloadContract>>, Error> {
    let rows = executor.rows(sql::GET_CONTRACT_DEFINITION_V1, &[&task_type, &version]).await?;
    let row = match rows.as_slice() {
        [] => return Ok(None),
        [row] => row,
        _ => return Err(invalid_definition()),
    };
    let schema: Value = row.try_get("schema").map_err(|_| invalid_definition())?;
    let validator =
        schema.get("payload").ok_or_else(invalid_definition).and_then(compile_contract_schema)?;
    let contract = (|| -> Result<PayloadContract, tokio_postgres::Error> {
        Ok(PayloadContract {
            version: row.try_get("version")?,
            validator,
            payload_max_bytes: row.try_get("payload_max_bytes")?,
            result_max_bytes: row.try_get("result_max_bytes")?,
            payload_redact_keys: row.try_get("payload_redact_keys")?,
            result_redact_keys: row.try_get("result_redact_keys")?,
        })
    })()
    .map_err(|_| invalid_definition())?;
    Ok(Some(Arc::new(contract)))
}

fn invalid_definition() -> Error {
    Error::invalid("invalid contract definition returned by PostgreSQL")
}

/// Compiles every schema, then renders the `sync_contract_definitions_v1` document.
pub(crate) fn serialize_contracts(
    contracts: &BTreeMap<String, TaskTypeContracts>,
) -> Result<Value, Error> {
    let mut definitions = Vec::with_capacity(contracts.len());
    for (task_type, type_contracts) in contracts {
        let mut versions = Map::new();
        for (version, contract) in &type_contracts.versions {
            compile_contract_schema(&contract.payload_schema)?;
            compile_contract_schema(&contract.result_schema)?;
            versions.insert(
                version.clone(),
                json!({
                    "payloadSchema": contract.payload_schema,
                    "resultSchema": contract.result_schema,
                    "maxPayloadBytes": default_limit(contract.max_payload_bytes),
                    "maxResultBytes": default_limit(contract.max_result_bytes),
                    "sensitivePayloadKeys": contract.sensitive_payload_keys,
                    "sensitiveResultKeys": contract.sensitive_result_keys,
                }),
            );
        }
        definitions.push(json!({
            "taskType": task_type,
            "currentVersion": type_contracts.current_version,
            "versions": versions,
        }));
    }
    Ok(Value::Array(definitions))
}

fn default_limit(value: i32) -> i64 {
    if value == 0 {
        sql::DEFAULT_TASK_VALUE_MAX_BYTES
    } else {
        i64::from(value)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn names_the_pattern_keyword_it_refuses_at_any_depth() {
        for (path, schema) in [
            (
                "$.properties.a.pattern",
                json!({"properties": {"a": {"type": "string", "pattern": "^a$"}}}),
            ),
            ("$.items.patternProperties", json!({"items": {"patternProperties": {"^a": true}}})),
        ] {
            let Err(Error::InvalidArgument(message)) = compile_contract_schema(&schema) else {
                panic!("{path} compiled");
            };
            assert_eq!(message, format!("{path} is outside the Workhorse contract profile"));
        }
    }

    #[test]
    fn refuses_a_reference_outside_the_schema_tree() {
        let schema =
            json!({"default": {"pattern": "^a$"}, "properties": {"a": {"$ref": "#/default"}}});
        let Err(Error::InvalidArgument(message)) = compile_contract_schema(&schema) else {
            panic!("a reference into default compiled");
        };
        assert_eq!(message, "$.properties.a.$ref must point at a subschema of the contract");
    }

    #[test]
    fn names_the_anchor_and_definition_forms_it_refuses() {
        for (schema, expected) in [
            (
                json!({"items": {"$anchor": "a"}}),
                "$.items.$anchor is outside the Workhorse contract profile",
            ),
            (json!({"items": {"$defs": {}}}), "$.items.$defs must appear only on the root schema"),
            (
                json!({"$defs": {"a b": true}}),
                "$.$defs.a b must be a definition name matching ^[A-Za-z_][-A-Za-z0-9._]*$",
            ),
        ] {
            let Err(Error::InvalidArgument(message)) = compile_contract_schema(&schema) else {
                panic!("{schema} compiled");
            };
            assert_eq!(message, expected);
        }
    }
}
