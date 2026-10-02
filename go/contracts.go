package workhorse

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"

	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"
)

type TaskContractVersion struct {
	PayloadSchema        any
	ResultSchema         any
	MaxPayloadBytes      int
	MaxResultBytes       int
	SensitivePayloadKeys []string
	SensitiveResultKeys  []string
}

type TaskTypeContracts struct {
	CurrentVersion string
	Versions       map[string]TaskContractVersion
}

type TaskContractValidationError struct {
	TaskType string
	Version  string
	Kind     string
}

func (err *TaskContractValidationError) Error() string {
	return fmt.Sprintf(contractValidationErrorFormat, err.TaskType, err.Kind, err.Version)
}

type TaskContractUnavailableError struct {
	TaskType string
	Version  string
}

func (err *TaskContractUnavailableError) Error() string {
	return fmt.Sprintf(contractUnavailableErrorFormat, err.TaskType, err.Version)
}

// contractCache holds each task type's current contract between enqueues. A nil definition records
// that the type has none. PostgreSQL reports a stale entry as a contract_mismatch row, which
// refreshes it. An entry that rejects a payload is reloaded before the rejection is returned, so
// the cache needs no expiry.
type contractCache struct {
	mu          sync.RWMutex
	validators  map[string]*jsonschema.Schema
	definitions map[string]*payloadContract
	enabled     bool
}

func newContractCache() contractCache {
	return contractCache{
		validators:  make(map[string]*jsonschema.Schema),
		definitions: make(map[string]*payloadContract),
	}
}

var schemaValues = keywordSet(contractSchemaValueKeywords)
var contractDefinitionName = regexp.MustCompile(contractDefinitionNamePattern)
var schemaArrays = keywordSet(contractSchemaArrayKeywords)
var schemaMaps = keywordSet(contractSchemaMapKeywords)
var annotationKeywords = keywordSet(contractAnnotationKeywords)
var validationKeywords = keywordSet(contractValidationKeywords)

func keywordSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

type contractReference struct {
	path      string
	reference string
}

// checkContractSchema requires every reference to name the root schema or one root definition. The
// libraries behind the five SDKs resolve those two forms alike, and both name a schema position the
// profile walk checked.
func checkContractSchema(schema any, path string) error {
	var references []contractReference
	if err := checkContractProfile(schema, path, &references); err != nil {
		return err
	}
	for _, reference := range references {
		if !referencesSubschema(schema, reference.reference) {
			return fmt.Errorf(contractSubschemaReferenceErrorFormat, reference.path)
		}
	}
	return nil
}

func referencesSubschema(root any, reference string) bool {
	if reference == contractLocalReferencePrefix {
		return true
	}
	name, ok := strings.CutPrefix(reference, contractDefinitionReferencePrefix)
	if !ok {
		return false
	}
	document, ok := root.(map[string]any)
	if !ok {
		return false
	}
	definitions, ok := document[contractDefinitionsKeyword].(map[string]any)
	if !ok {
		return false
	}
	_, present := definitions[name]
	return present
}

func checkContractProfile(schema any, path string, references *[]contractReference) error {
	if _, ok := schema.(bool); ok {
		return nil
	}
	document, ok := schema.(map[string]any)
	if !ok {
		return fmt.Errorf(contractSchemaTypeErrorFormat, path)
	}
	for keyword, value := range document {
		keywordPath := path + contractPathSeparator + keyword
		switch {
		case keyword == contractReferenceKeyword:
			ref, ok := value.(string)
			if !ok || !strings.HasPrefix(ref, contractLocalReferencePrefix) {
				return fmt.Errorf(contractBundledReferenceErrorFormat, keywordPath)
			}
			*references = append(*references, contractReference{path: keywordPath, reference: ref})
		case keyword == contractDialectKeyword:
			if value != contractDialectValue {
				return fmt.Errorf(contractDialectErrorFormat, keywordPath)
			}
		case keyword == contractDefinitionsKeyword && path != contractRootPath:
			return fmt.Errorf(contractRootDefinitionsErrorFormat, keywordPath)
		case schemaValues[keyword]:
			if err := checkContractProfile(value, keywordPath, references); err != nil {
				return err
			}
		case schemaArrays[keyword]:
			values, ok := value.([]any)
			if !ok {
				return fmt.Errorf(contractArrayErrorFormat, keywordPath)
			}
			for index, child := range values {
				if err := checkContractProfile(child, fmt.Sprintf(contractArrayPathFormat, keywordPath, index), references); err != nil {
					return err
				}
			}
		case schemaMaps[keyword]:
			values, ok := value.(map[string]any)
			if !ok {
				return fmt.Errorf(contractObjectErrorFormat, keywordPath)
			}
			for name, child := range values {
				childPath := keywordPath + contractPathSeparator + name
				if keyword == contractDefinitionsKeyword && !contractDefinitionName.MatchString(name) {
					return fmt.Errorf(contractDefinitionNameErrorFormat, childPath, contractDefinitionNamePattern)
				}
				if err := checkContractProfile(child, childPath, references); err != nil {
					return err
				}
			}
		case !annotationKeywords[keyword] && !validationKeywords[keyword]:
			return fmt.Errorf(contractProfileErrorFormat, keywordPath)
		}
	}
	return nil
}

func compileContractSchema(schema any) (*jsonschema.Schema, error) {
	if err := checkContractSchema(schema, contractRootPath); err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	if err := compiler.AddResource(contractResourceURL, schema); err != nil {
		return nil, err
	}
	return compiler.Compile(contractResourceURL)
}

func (cache *contractCache) validator(key string, schema any) (*jsonschema.Schema, error) {
	cache.mu.RLock()
	validator := cache.validators[key]
	cache.mu.RUnlock()
	if validator != nil {
		return validator, nil
	}
	compiled, err := compileContractSchema(schema)
	if err != nil {
		return nil, err
	}
	cache.mu.Lock()
	cache.validators[key] = compiled
	cache.mu.Unlock()
	return compiled, nil
}

func (queue *Queue) SyncContracts(ctx context.Context, contracts map[string]TaskTypeContracts) error {
	definitions := make([]map[string]any, 0, len(contracts))
	for taskType, typeContracts := range contracts {
		versions := make(map[string]any, len(typeContracts.Versions))
		for version, contract := range typeContracts.Versions {
			payloadSchema := contract.PayloadSchema
			if payloadSchema == nil {
				payloadSchema = true
			}
			resultSchema := contract.ResultSchema
			if resultSchema == nil {
				resultSchema = true
			}
			if _, err := compileContractSchema(payloadSchema); err != nil {
				return err
			}
			if _, err := compileContractSchema(resultSchema); err != nil {
				return err
			}
			versions[version] = map[string]any{
				contractPayloadSchemaJSONField: payloadSchema, contractResultSchemaJSONField: resultSchema,
				contractMaxPayloadBytesJSONField:  defaultContractLimit(contract.MaxPayloadBytes),
				contractMaxResultBytesJSONField:   defaultContractLimit(contract.MaxResultBytes),
				contractSensitivePayloadJSONField: contractStrings(contract.SensitivePayloadKeys),
				contractSensitiveResultJSONField:  contractStrings(contract.SensitiveResultKeys),
			}
		}
		definitions = append(definitions, map[string]any{contractTaskTypeJSONField: taskType, contractCurrentVersionJSONField: typeContracts.CurrentVersion, contractVersionsJSONField: versions})
	}
	payload, err := json.Marshal(definitions)
	if err != nil {
		return err
	}
	if err := AssertSchemaCompatible(ctx, queue.executor); err != nil {
		return err
	}
	_, err = queue.executor.Query(ctx, protocolStatementRegistry[syncContractDefinitionsStatementName], payload)
	if err == nil {
		queue.contracts.mu.Lock()
		queue.contracts.enabled = true
		clear(queue.contracts.definitions)
		queue.contracts.mu.Unlock()
	}
	return err
}

func contractStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func defaultContractLimit(value int) int {
	if value == 0 {
		return defaultTaskValueMaxBytes
	}
	return value
}

func contractDocument(value any) (map[string]any, error) {
	if document, ok := value.(map[string]any); ok {
		return document, nil
	}
	encoded, ok := value.([]byte)
	if !ok {
		if text, stringOK := value.(string); stringOK {
			encoded = []byte(text)
		} else {
			return nil, errorsNewInvalidContract()
		}
	}
	var document map[string]any
	if err := decodeContractJSON(encoded, &document); err != nil {
		return nil, err
	}
	return document, nil
}

func decodeContractJSON(encoded []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	return decoder.Decode(destination)
}

func errorsNewInvalidContract() error { return errors.New(invalidContractDefinitionMessage) }
