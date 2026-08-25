package dashboard

import (
	"context"
)

func (service *backend) system(ctx context.Context, input any, _ string) (any, error) {
	value, err := document(input)
	if err != nil {
		return nil, err
	}
	return service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_system_v1($1::jsonb) AS result",
		string(mustJSON(value)),
	)
}
