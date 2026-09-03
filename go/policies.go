package workhorse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// ErrInvalidPolicyResult reports a policy row that violates the public result contract.
var ErrInvalidPolicyResult = errors.New(invalidPolicyResultMessage)

// ErrInvalidPolicyOptions reports an unsupported synchronization option combination.
var ErrInvalidPolicyOptions = errors.New(invalidPolicyOptionsMessage)

// SyncPolicyOptions controls desired-state policy reconciliation.
type SyncPolicyOptions struct {
	Prune bool
}

// ConcurrencyPolicyDefinition is one queue's deployment-synchronized active-job budget.
type ConcurrencyPolicyDefinition struct {
	Queue           string `json:"queue"`
	MaxActive       int    `json:"maxActive"`
	MaxActivePerKey *int   `json:"maxActivePerKey,omitempty"`
}

// ConcurrencyPolicy is one persisted queue concurrency policy.
type ConcurrencyPolicy struct {
	Namespace       string
	Queue           string
	MaxActive       int
	MaxActivePerKey *int
	UpdatedAt       time.Time
}

// RateLimit is one continuously refilled PostgreSQL token bucket.
type RateLimit struct {
	Limit      int `json:"limit"`
	IntervalMS int `json:"intervalMs"`
	Burst      int `json:"burst"`
}

// RateLimitPolicyDefinition is one queue's deployment-synchronized start-rate budget.
type RateLimitPolicyDefinition struct {
	Queue  string     `json:"queue"`
	Rate   RateLimit  `json:"rate"`
	PerKey *RateLimit `json:"perKey,omitempty"`
}

// RateLimitPolicy is one persisted and normalized queue rate-limit policy.
type RateLimitPolicy struct {
	Namespace string
	Queue     string
	Rate      RateLimit
	PerKey    *RateLimit
	UpdatedAt time.Time
}

// SyncConcurrencyPolicies atomically reconciles one namespace of concurrency policies.
// Omitted definitions are removed unless options explicitly set Prune to false.
func (queue *Queue) SyncConcurrencyPolicies(
	ctx context.Context,
	namespace string,
	definitions []ConcurrencyPolicyDefinition,
	options ...SyncPolicyOptions,
) ([]ConcurrencyPolicy, error) {
	prune, err := policyPruneOption(options)
	if err != nil {
		return nil, err
	}
	if definitions == nil {
		definitions = []ConcurrencyPolicyDefinition{}
	}
	payload, err := json.Marshal(definitions)
	if err != nil {
		return nil, err
	}
	if err := AssertSchemaCompatible(ctx, queue.executor); err != nil {
		return nil, err
	}
	rows, err := queue.executor.Query(
		ctx,
		internalStatementRegistry[syncConcurrencyPoliciesStatementName],
		namespace,
		payload,
		prune,
	)
	if err != nil {
		return nil, err
	}
	return concurrencyPolicyRows(rows)
}

// ListConcurrencyPolicies returns persisted policies ordered by queue name.
// A nil or empty queue-name slice returns every policy.
func (queue *Queue) ListConcurrencyPolicies(
	ctx context.Context,
	queueNames []string,
) ([]ConcurrencyPolicy, error) {
	if queueNames == nil {
		queueNames = []string{}
	}
	rows, err := queue.executor.Query(
		ctx,
		internalStatementRegistry[listConcurrencyPoliciesStatementName],
		queueNames,
	)
	if err != nil {
		return nil, err
	}
	return concurrencyPolicyRows(rows)
}

// SyncRateLimitPolicies atomically reconciles one namespace of rate-limit policies.
// Omitted definitions are removed unless options explicitly set Prune to false.
func (queue *Queue) SyncRateLimitPolicies(
	ctx context.Context,
	namespace string,
	definitions []RateLimitPolicyDefinition,
	options ...SyncPolicyOptions,
) ([]RateLimitPolicy, error) {
	prune, err := policyPruneOption(options)
	if err != nil {
		return nil, err
	}
	if definitions == nil {
		definitions = []RateLimitPolicyDefinition{}
	}
	payload, err := json.Marshal(definitions)
	if err != nil {
		return nil, err
	}
	if err := AssertSchemaCompatible(ctx, queue.executor); err != nil {
		return nil, err
	}
	rows, err := queue.executor.Query(
		ctx,
		internalStatementRegistry[syncRateLimitPoliciesStatementName],
		namespace,
		payload,
		prune,
	)
	if err != nil {
		return nil, err
	}
	return rateLimitPolicyRows(rows)
}

// ListRateLimitPolicies returns persisted policies ordered by queue name.
// A nil or empty queue-name slice returns every policy.
func (queue *Queue) ListRateLimitPolicies(
	ctx context.Context,
	queueNames []string,
) ([]RateLimitPolicy, error) {
	if queueNames == nil {
		queueNames = []string{}
	}
	rows, err := queue.executor.Query(
		ctx,
		internalStatementRegistry[listRateLimitPoliciesStatementName],
		queueNames,
	)
	if err != nil {
		return nil, err
	}
	return rateLimitPolicyRows(rows)
}

func policyPruneOption(options []SyncPolicyOptions) (bool, error) {
	if len(options) > 1 {
		return false, fmt.Errorf(tooManySyncPolicyOptionsMessage, ErrInvalidPolicyOptions)
	}
	if len(options) == 1 {
		return options[0].Prune, nil
	}
	return true, nil
}

func concurrencyPolicyRows(rows []Row) ([]ConcurrencyPolicy, error) {
	policies := make([]ConcurrencyPolicy, len(rows))
	for index, row := range rows {
		namespace, namespaceOK := row[rowNamespaceField].(string)
		queueName, queueOK := row[rowQueueNameField].(string)
		maxActive, maxActiveOK := integer(row[rowMaxActiveField])
		maxActivePerKey, maxActivePerKeyOK := optionalInteger(row[rowMaxActivePerKeyField])
		updatedAt, updatedAtOK := row[rowUpdatedAtField].(time.Time)
		if !namespaceOK {
			return nil, invalidPolicyField(rowNamespaceField)
		}
		if !queueOK {
			return nil, invalidPolicyField(rowQueueNameField)
		}
		if !maxActiveOK {
			return nil, invalidPolicyField(rowMaxActiveField)
		}
		if !maxActivePerKeyOK {
			return nil, invalidPolicyField(rowMaxActivePerKeyField)
		}
		if !updatedAtOK {
			return nil, invalidPolicyField(rowUpdatedAtField)
		}
		policies[index] = ConcurrencyPolicy{
			Namespace: namespace, Queue: queueName, MaxActive: maxActive,
			MaxActivePerKey: maxActivePerKey, UpdatedAt: updatedAt,
		}
	}
	return policies, nil
}

func rateLimitPolicyRows(rows []Row) ([]RateLimitPolicy, error) {
	policies := make([]RateLimitPolicy, len(rows))
	for index, row := range rows {
		namespace, namespaceOK := row[rowNamespaceField].(string)
		queueName, queueOK := row[rowQueueNameField].(string)
		rate, rateOK := rateLimitFromRow(row, rowRateLimitField, rowRateIntervalMSField, rowRateBurstField)
		perKey, perKeyOK := optionalRateLimitFromRow(
			row,
			rowPerKeyLimitField,
			rowPerKeyIntervalMSField,
			rowPerKeyBurstField,
		)
		updatedAt, updatedAtOK := row[rowUpdatedAtField].(time.Time)
		if !namespaceOK {
			return nil, invalidPolicyField(rowNamespaceField)
		}
		if !queueOK {
			return nil, invalidPolicyField(rowQueueNameField)
		}
		if !rateOK {
			return nil, invalidPolicyField(rowRateLimitField)
		}
		if !perKeyOK {
			return nil, invalidPolicyField(rowPerKeyLimitField)
		}
		if !updatedAtOK {
			return nil, invalidPolicyField(rowUpdatedAtField)
		}
		policies[index] = RateLimitPolicy{
			Namespace: namespace, Queue: queueName, Rate: rate, PerKey: perKey, UpdatedAt: updatedAt,
		}
	}
	return policies, nil
}

func rateLimitFromRow(row Row, limitField, intervalField, burstField string) (RateLimit, bool) {
	limit, limitOK := integer(row[limitField])
	interval, intervalOK := integer(row[intervalField])
	burst, burstOK := integer(row[burstField])
	return RateLimit{Limit: limit, IntervalMS: interval, Burst: burst}, limitOK && intervalOK && burstOK
}

func optionalRateLimitFromRow(
	row Row,
	limitField string,
	intervalField string,
	burstField string,
) (*RateLimit, bool) {
	if row[limitField] == nil && row[intervalField] == nil && row[burstField] == nil {
		return nil, true
	}
	rate, ok := rateLimitFromRow(row, limitField, intervalField, burstField)
	return &rate, ok
}

func invalidPolicyField(field string) error {
	return fmt.Errorf(invalidPolicyFieldFormat, ErrInvalidPolicyResult, field)
}
