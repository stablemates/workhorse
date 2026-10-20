package example

import (
	"net/http"

	workhorse "github.com/stablemates/workhorse/go"
	"github.com/stablemates/workhorse/go/dashboard"
)

type operatorContextKey struct{}

func mountDashboard(mux *http.ServeMux, executor workhorse.Executor) error {
	handler, err := dashboard.NewHandler(dashboard.HandlerOptions{
		Executor: executor,
		Path:     "/workhorse",
		Authorize: func(request *http.Request) dashboard.Authorization {
			actor, ok := request.Context().Value(operatorContextKey{}).(string)
			if !ok || actor == "" {
				return dashboard.Authorization{}
			}
			return dashboard.Authorization{
				Principal: &dashboard.Principal{Actor: actor},
			}
		},
	})
	if err != nil {
		return err
	}
	mux.Handle("/workhorse/", handler)
	return nil
}
