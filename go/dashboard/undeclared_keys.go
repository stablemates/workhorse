package dashboard

// dropUndeclaredKeys returns a valid procedure input without the object keys that its request
// schema does not declare, as the TypeScript host's schema parse does.
//
// Each SQL procedure reads its input document by key. A key that the contract does not declare,
// such as a health document in a system read, must not reach SQL, so a later SQL change that reads
// one more key cannot read a value that the caller controls. An object schema with
// additionalProperties, such as a signal payload, is free JSON and keeps every key.
func dropUndeclaredKeys(procedure string, value any) any {
	schema, ok := inputSchemas[procedure].(map[string]any)
	if !ok {
		return value
	}
	return declaredOnly(schema, schema, value)
}

func declaredOnly(schema, root map[string]any, value any) any {
	if ref, ok := schema["$ref"].(string); ok {
		defs, _ := root["$defs"].(map[string]any)
		resolved, ok := defs[ref[len("#/$defs/"):]].(map[string]any)
		if !ok {
			return value
		}
		return declaredOnly(resolved, root, value)
	}
	if branches, ok := schema["anyOf"].([]any); ok {
		// The first branch that accepts the value owns it, as in validateSchema.
		for _, raw := range branches {
			if branch, ok := raw.(map[string]any); ok && validateSchema(branch, root, value, "$") == nil {
				return declaredOnly(branch, root, value)
			}
		}
		return value
	}
	switch value := value.(type) {
	case map[string]any:
		if additional, ok := schema["additionalProperties"].(map[string]any); ok {
			kept := make(map[string]any, len(value))
			for name, child := range value {
				kept[name] = declaredOnly(additional, root, child)
			}
			return kept
		}
		properties, ok := schema["properties"].(map[string]any)
		if !ok {
			return value
		}
		kept := make(map[string]any, len(value))
		for name, child := range value {
			if childSchema, declared := properties[name].(map[string]any); declared {
				kept[name] = declaredOnly(childSchema, root, child)
			}
		}
		return kept
	case []any:
		items, ok := schema["items"].(map[string]any)
		if !ok {
			return value
		}
		kept := make([]any, len(value))
		for index, item := range value {
			kept[index] = declaredOnly(items, root, item)
		}
		return kept
	default:
		return value
	}
}
