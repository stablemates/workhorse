package dashboard

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	workhorse "github.com/stablemates/workhorse/go"
)

type rejectingExecutor struct{}

func (rejectingExecutor) Query(context.Context, string, ...any) ([]workhorse.Row, error) {
	panic("transport test queried PostgreSQL")
}

func testHandler(t *testing.T, authorize Authorize) http.Handler {
	t.Helper()
	handler, err := NewHandler(HandlerOptions{
		Executor:               rejectingExecutor{},
		Authorize:              authorize,
		Environment:            "test",
		SkipCompatibilityCheck: true,
		Procedures: map[string]Procedure{
			"meta": func(_ context.Context, _ any, actor string) (any, error) {
				return map[string]any{"environment": "test", "actor": actor}, nil
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func TestHandlerServesApplicationAndRPC(t *testing.T) {
	handler := testHandler(t, func(*http.Request) Authorization {
		return Authorization{Principal: &Principal{Actor: "operator@example.test"}}
	})
	redirect := httptest.NewRecorder()
	handler.ServeHTTP(redirect, httptest.NewRequest(http.MethodGet, "https://example.test/workhorse", nil))
	if redirect.Code != http.StatusFound || redirect.Header().Get("Location") != "/workhorse/tasks" {
		t.Fatalf("redirect = %d %q", redirect.Code, redirect.Header().Get("Location"))
	}

	page := httptest.NewRecorder()
	handler.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "https://example.test/workhorse/tasks", nil))
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), `"auditActor":"operator@example.test"`) {
		t.Fatalf("page = %d %s", page.Code, page.Body.String())
	}

	rpc := httptest.NewRecorder()
	handler.ServeHTTP(rpc, httptest.NewRequest(http.MethodPost, "https://example.test/workhorse/rpc/dashboard/meta", strings.NewReader(`{"json":null}`)))
	var body map[string]any
	if err := json.Unmarshal(rpc.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	result := body["json"].(map[string]any)
	if result["actor"] != "operator@example.test" {
		t.Fatalf("body = %#v", body)
	}
}

func TestHandlerRedirectsARootMount(t *testing.T) {
	handler, err := NewHandler(HandlerOptions{
		Executor: rejectingExecutor{}, Path: "/",
		Authorize: func(*http.Request) Authorization {
			return Authorization{Principal: &Principal{Actor: "operator@example.test"}}
		},
		SkipCompatibilityCheck: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "https://example.test/", nil))
	if response.Code != http.StatusFound || response.Header().Get("Location") != "/tasks" {
		t.Fatalf("redirect = %d %q", response.Code, response.Header().Get("Location"))
	}
}

func TestHandlerAuthorizesBeforeDispatch(t *testing.T) {
	handler := testHandler(t, func(*http.Request) Authorization { return Authorization{} })
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "https://example.test/workhorse/rpc/dashboard/meta", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestHandlerRejectsCrossOriginMutation(t *testing.T) {
	handler, err := NewHandler(HandlerOptions{
		Executor:               rejectingExecutor{},
		Authorize:              func(*http.Request) Authorization { return Authorization{Principal: &Principal{Actor: "trusted"}} },
		SkipCompatibilityCheck: true,
		Procedures: map[string]Procedure{
			"purgeQueue": func(context.Context, any, string) (any, error) { return map[string]any{"deletedCount": 1}, nil },
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "https://example.test/workhorse/rpc/dashboard/purgeQueue", io.NopCloser(strings.NewReader(`{"json":{"queue":"default","audit":{"actor":"fake","reason":"x","requestId":"r"}}}`)))
	request.Header.Set("Origin", "https://attacker.test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "same-origin") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestHandlerForbidsUnavailableOptionalMutation(t *testing.T) {
	handler := testHandler(t, func(*http.Request) Authorization {
		return Authorization{Principal: &Principal{Actor: "operator@example.test"}}
	})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost,
		"https://example.test/workhorse/rpc/dashboard/setScheduleEnabled",
		strings.NewReader(`{"json":null}`),
	)
	request.Header.Set("Origin", "https://example.test")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"FORBIDDEN"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}
