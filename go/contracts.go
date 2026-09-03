package workhorse

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"
)

type JobContractVersion struct {
	PayloadSchema        any
	ResultSchema         any
	MaxPayloadBytes      int
	MaxResultBytes       int
	SensitivePayloadKeys []string
	SensitiveResultKeys  []string
}

type JobTypeContracts struct {
	CurrentVersion string
	Versions       map[string]JobContractVersion
}

type JobContractValidationError struct {
	JobType string
	Version string
	Kind    string
}

func (err *JobContractValidationError) Error() string {
	return fmt.Sprintf(contractValidationErrorFormat, err.JobType, err.Kind, err.Version)
}

type JobContractUnavailableError struct {
	JobType string
	Version string
}

func (err *JobContractUnavailableError) Error() string {
	return fmt.Sprintf(contractUnavailableErrorFormat, err.JobType, err.Version)
}

type contractCache struct {
	mu         sync.RWMutex
	validators map[string]*jsonschema.Schema
	enabled    bool
}

func newContractCache() contractCache {
	return contractCache{validators: make(map[string]*jsonschema.Schema)}
}

var schemaValues = keywordSet(contractSchemaValueKeywords)
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

func checkContractSchema(schema any, path string) error {
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
		case keyword == contractDialectKeyword:
			if value != contractDialectValue {
				return fmt.Errorf(contractDialectErrorFormat, keywordPath)
			}
		case schemaValues[keyword]:
			if err := checkContractSchema(value, keywordPath); err != nil {
				return err
			}
		case schemaArrays[keyword]:
			values, ok := value.([]any)
			if !ok {
				return fmt.Errorf(contractArrayErrorFormat, keywordPath)
			}
			for index, child := range values {
				if err := checkContractSchema(child, fmt.Sprintf(contractArrayPathFormat, keywordPath, index)); err != nil {
					return err
				}
			}
		case schemaMaps[keyword]:
			values, ok := value.(map[string]any)
			if !ok {
				return fmt.Errorf(contractObjectErrorFormat, keywordPath)
			}
			for name, child := range values {
				if err := checkContractSchema(child, keywordPath+contractPathSeparator+name); err != nil {
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

func (queue *Queue) SyncContracts(ctx context.Context, contracts map[string]JobTypeContracts) error {
	definitions := make([]map[string]any, 0, len(contracts))
	for jobType, typeContracts := range contracts {
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
		definitions = append(definitions, map[string]any{contractJobTypeJSONField: jobType, contractCurrentVersionJSONField: typeContracts.CurrentVersion, contractVersionsJSONField: versions})
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
		return defaultJobValueMaxBytes
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
