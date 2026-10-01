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
const SCHEMA_MAPS: &[&str] = &["$defs", "dependentSchemas", "patternProperties", "properties"];
const PLAIN_KEYWORDS: &[&str] = &[
    "$anchor",
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
    "pattern",
    "required",
    "type",
    "uniqueItems",
];
const DIALECT: &str = "https://json-schema.org/draft/2020-12/schema";

/// Reports whether an ECMA-262 pattern contains `\1`-`\9` or `\k<name>` outside a character class.
///
/// A backreference to a group that has not matched behaves differently across regex engines, and RE2
/// has none, so the profile rejects it. Every byte this scan compares is ASCII, so it can walk bytes.
fn uses_backreference(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut in_class = false;
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => {
                let escaped = bytes.get(index + 1).copied();
                if !in_class && matches!(escaped, Some(b'k' | b'1'..=b'9')) {
                    return true;
                }
                index += 1;
            }
            b'[' => in_class = true,
            b']' => in_class = false,
            _ => {}
        }
        index += 1;
    }
    false
}

fn check_backreference(source: &str, path: &str) -> Result<(), String> {
    if uses_backreference(source) {
        return Err(format!(
            "{path} uses a backreference, which is outside the Workhorse contract profile"
        ));
    }
    Ok(())
}

fn check_profile(schema: &Value, path: &str) -> Result<(), String> {
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
        } else if keyword == "$schema" {
            if value.as_str() != Some(DIALECT) {
                return Err(format!("{keyword_path} must select Draft 2020-12"));
            }
        } else if SCHEMA_VALUES.contains(&keyword) {
            check_profile(value, &keyword_path)?;
        } else if SCHEMA_ARRAYS.contains(&keyword) {
            let children =
                value.as_array().ok_or_else(|| format!("{keyword_path} must be an array"))?;
            for (index, child) in children.iter().enumerate() {
                check_profile(child, &format!("{keyword_path}[{index}]"))?;
            }
        } else if SCHEMA_MAPS.contains(&keyword) {
            let children =
                value.as_object().ok_or_else(|| format!("{keyword_path} must be an object"))?;
            for (name, child) in children {
                let child_path = format!("{keyword_path}.{name}");
                if keyword == "patternProperties" {
                    check_backreference(name, &child_path)?;
                }
                check_profile(child, &child_path)?;
            }
        } else if keyword == "pattern" {
            if let Some(source) = value.as_str() {
                check_backreference(source, &keyword_path)?;
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
    check_profile(schema, "$").map_err(Error::InvalidArgument)?;
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
    fn names_the_pattern_that_uses_a_backreference() {
        for (path, schema) in [
            ("$.properties.a.pattern", json!({"properties": {"a": {"pattern": "^(a)\\1$"}}})),
            (
                "$.patternProperties.^(?<x>a)\\k<x>$",
                json!({"patternProperties": {"^(?<x>a)\\k<x>$": true}}),
            ),
        ] {
            let Err(Error::InvalidArgument(message)) = compile_contract_schema(&schema) else {
                panic!("{path} compiled");
            };
            assert_eq!(
                message,
                format!(
                    "{path} uses a backreference, which is outside the Workhorse contract profile"
                )
            );
        }
    }

    #[test]
    fn reads_an_escaped_backslash_or_a_class_as_no_backreference() {
        assert!(!uses_backreference(r"^\\1$"));
        assert!(!uses_backreference(r"^[\]1]$"));
        assert!(uses_backreference(r"^[a]\1$"));
    }
}
