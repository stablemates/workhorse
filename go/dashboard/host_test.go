package dashboard

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
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
	handler, err := newHandler(HandlerOptions{
		Executor:    rejectingExecutor{},
		Authorize:   authorize,
		Environment: "test",
		Procedures: map[string]Procedure{
			"meta": func(_ context.Context, _ any, actor string) (any, error) {
				return map[string]any{"environment": "test", "actor": actor}, nil
			},
		},
	}, true)
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
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), `"auditActor":"operator@example.test"`) || !strings.Contains(page.Body.String(), `"workhorseVersion":"`+workhorse.Version+`"`) {
		t.Fatalf("page = %d %s", page.Code, page.Body.String())
	}
	if cacheControl := page.Header().Get("Cache-Control"); cacheControl != "no-store" {
		t.Fatalf("page Cache-Control = %q", cacheControl)
	}
	asset := regexp.MustCompile(`\./assets/[^"]+\.js`).FindString(page.Body.String())
	if asset == "" {
		t.Fatalf("the page names no script asset: %s", page.Body.String())
	}
	assetResponse := httptest.NewRecorder()
	handler.ServeHTTP(assetResponse, httptest.NewRequest(http.MethodGet, "https://example.test/workhorse"+asset[1:], nil))
	if cacheControl := assetResponse.Header().Get("Cache-Control"); assetResponse.Code != http.StatusOK || cacheControl != "public, max-age=31536000, immutable" {
		t.Fatalf("asset = %d Cache-Control %q", assetResponse.Code, cacheControl)
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
	handler, err := newHandler(HandlerOptions{
		Executor: rejectingExecutor{}, Path: "/",
		Authorize: func(*http.Request) Authorization {
			return Authorization{Principal: &Principal{Actor: "operator@example.test"}}
		},
	}, true)
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
	handler, err := newHandler(HandlerOptions{
		Executor:  rejectingExecutor{},
		Authorize: func(*http.Request) Authorization { return Authorization{Principal: &Principal{Actor: "trusted"}} },
		Procedures: map[string]Procedure{
			"purgeQueue": func(context.Context, any, string) (any, error) { return map[string]any{"deletedCount": 1}, nil },
		},
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	// A relative Origin such as "null" must not resolve against the request URL.
	for _, origin := range []string{"https://attacker.test", "null", "not a url"} {
		request := httptest.NewRequest(http.MethodPost, "https://example.test/workhorse/rpc/dashboard/purgeQueue", io.NopCloser(strings.NewReader(`{"json":{"queue":"default","audit":{"actor":"fake","reason":"x","requestId":"r"}}}`)))
		request.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "same-origin mutation") {
			t.Fatalf("Origin %q: response = %d %s", origin, response.Code, response.Body.String())
		}
	}
}

// A host CORS policy with credentials would let a foreign page read these responses.
func TestHandlerRejectsCrossOriginRead(t *testing.T) {
	handler := testHandler(t, func(*http.Request) Authorization {
		return Authorization{Principal: &Principal{Actor: "operator@example.test"}}
	})
	reads := []struct{ method, path string }{
		{http.MethodGet, "/workhorse"},
		{http.MethodGet, "/workhorse/tasks"},
		{http.MethodGet, "/workhorse/assets/index.js"},
		{http.MethodPost, "/workhorse/rpc/dashboard/meta"},
	}
	for _, read := range reads {
		for _, origin := range []string{"https://attacker.test", "null", "not a url", ""} {
			request := httptest.NewRequest(read.method, "https://example.test"+read.path, strings.NewReader(`{"json":null}`))
			request.Header.Set("Origin", origin)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || strings.TrimSpace(response.Body.String()) != `{"error":"A same-origin request is required"}` {
				t.Fatalf("%s %s with Origin %q = %d %s", read.method, read.path, origin, response.Code, response.Body.String())
			}
		}
	}
}

func TestHandlerComparesTheOriginWithoutLetterCaseOrDefaultPort(t *testing.T) {
	handler := testHandler(t, func(*http.Request) Authorization {
		return Authorization{Principal: &Principal{Actor: "operator@example.test"}}
	})
	cases := map[string]int{
		"https://example.test":      http.StatusOK,
		"HTTPS://example.test":      http.StatusOK,
		"https://example.test/":     http.StatusForbidden,
		"https://user@example.test": http.StatusForbidden,
		"https://example.test?x=1":  http.StatusForbidden,
		"https://example.test:8443": http.StatusForbidden,
		"http://example.test":       http.StatusForbidden,
	}
	for origin, want := range cases {
		request := httptest.NewRequest(http.MethodGet, "https://example.test/workhorse/tasks", nil)
		request.Host = "EXAMPLE.test:443"
		request.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != want {
			t.Fatalf("Origin %q = %d, want %d", origin, response.Code, want)
		}
	}
}

// Two Origin headers name no single origin, so a foreign second value cannot hide behind the first.
func TestHandlerRejectsTwoOriginHeaders(t *testing.T) {
	handler, err := newHandler(HandlerOptions{
		Executor:  rejectingExecutor{},
		Authorize: func(*http.Request) Authorization { return Authorization{Principal: &Principal{Actor: "trusted"}} },
		Procedures: map[string]Procedure{
			"meta":       func(context.Context, any, string) (any, error) { return map[string]any{"environment": "test"}, nil },
			"purgeQueue": func(context.Context, any, string) (any, error) { return map[string]any{"deletedCount": 1}, nil },
		},
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/workhorse/tasks", "/workhorse/rpc/dashboard/meta", "/workhorse/rpc/dashboard/purgeQueue"} {
		method := http.MethodPost
		if path == "/workhorse/tasks" {
			method = http.MethodGet
		}
		request := httptest.NewRequest(method, "https://example.test"+path, strings.NewReader(`{"json":{"queue":"default","audit":{"actor":"fake","reason":"x","requestId":"r"}}}`))
		request.Header.Add("Origin", "https://example.test")
		request.Header.Add("Origin", "https://attacker.test")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("%s = %d %s", path, response.Code, response.Body.String())
		}
	}
}

func TestHandlerServesAReadWithoutOriginOrFromTheSameOrigin(t *testing.T) {
	handler := testHandler(t, func(*http.Request) Authorization {
		return Authorization{Principal: &Principal{Actor: "operator@example.test"}}
	})
	for _, origin := range []string{"", "https://example.test"} {
		send := func(method, path string) *httptest.ResponseRecorder {
			request := httptest.NewRequest(method, "https://example.test"+path, strings.NewReader(`{"json":null}`))
			if origin != "" {
				request.Header.Set("Origin", origin)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			return response
		}
		if response := send(http.MethodGet, "/workhorse"); response.Code != http.StatusFound {
			t.Fatalf("redirect with Origin %q = %d", origin, response.Code)
		}
		if response := send(http.MethodGet, "/workhorse/tasks"); response.Code != http.StatusOK {
			t.Fatalf("page with Origin %q = %d %s", origin, response.Code, response.Body.String())
		}
		if response := send(http.MethodPost, "/workhorse/rpc/dashboard/meta"); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"environment":"test"`) {
			t.Fatalf("read with Origin %q = %d %s", origin, response.Code, response.Body.String())
		}
	}
}

func TestHandlerForbidsUnavailableOptionalMutation(t *testing.T) {
	for _, test := range []struct {
		readOnly bool
		message  string
	}{
		{false, "This dashboard host does not provide the setSchedulePaused action"},
		{true, "This dashboard is read-only"},
	} {
		handler, err := newHandler(HandlerOptions{
			Executor: rejectingExecutor{},
			ReadOnly: test.readOnly,
			Authorize: func(*http.Request) Authorization {
				return Authorization{Principal: &Principal{Actor: "operator@example.test"}}
			},
		}, true)
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		request := httptest.NewRequest(
			http.MethodPost,
			"https://example.test/workhorse/rpc/dashboard/setSchedulePaused",
			strings.NewReader(`{"json":null}`),
		)
		request.Header.Set("Origin", "https://example.test")
		handler.ServeHTTP(response, request)
		want := `{"json":{"code":"FORBIDDEN","defined":false,"message":"` + test.message + `","status":403}}`
		if response.Code != http.StatusForbidden || strings.TrimSpace(response.Body.String()) != want {
			t.Fatalf("read-only %v: response = %d %s", test.readOnly, response.Code, response.Body.String())
		}
	}
}

func TestHandlerRefusesAForeignHostBeforeAuthorization(t *testing.T) {
	authorized := 0
	handler, err := newHandler(HandlerOptions{
		Executor:     rejectingExecutor{},
		AllowedHosts: []string{"127.0.0.1:4100", "Dashboard.Example:80"},
		Authorize: func(*http.Request) Authorization {
			authorized++
			return Authorization{}
		},
	}, true)
	if err != nil {
		t.Fatal(err)
	}

	refused := httptest.NewRecorder()
	handler.ServeHTTP(refused, httptest.NewRequest(http.MethodPost, "http://rebound.example:4100/workhorse/rpc/dashboard/queues", strings.NewReader(`{}`)))
	if refused.Code != http.StatusMisdirectedRequest || strings.TrimSpace(refused.Body.String()) != `{"error":"Misdirected Request"}` {
		t.Fatalf("foreign host = %d %s", refused.Code, refused.Body.String())
	}
	if authorized != 0 {
		t.Fatalf("authorize ran %d times for a foreign host", authorized)
	}

	for _, target := range []string{"http://127.0.0.1:4100/workhorse", "http://DASHBOARD.example/workhorse", "http://dashboard.example:80/workhorse"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s = %d", target, response.Code)
		}
	}
	if authorized != 3 {
		t.Fatalf("authorize ran %d times for listed hosts", authorized)
	}
}

func TestHandlerRejectsAnAllowedHostThatIsNotABareHost(t *testing.T) {
	_, err := NewHandler(HandlerOptions{
		Executor:     rejectingExecutor{},
		AllowedHosts: []string{"http://127.0.0.1:4100/"},
		Authorize:    func(*http.Request) Authorization { return Authorization{} },
	})
	if err == nil || !strings.Contains(err.Error(), "host") {
		t.Fatalf("err = %v", err)
	}
}

type failingExecutor struct{ err error }

func (executor failingExecutor) Query(context.Context, string, ...any) ([]workhorse.Row, error) {
	return nil, executor.err
}

func TestHandlerHidesAnUnexpectedCompatibilityFailure(t *testing.T) {
	var logged bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logged, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	handler, err := newHandler(HandlerOptions{
		Executor: failingExecutor{err: errors.New("dial tcp db.internal:5432: connection refused")},
		Authorize: func(*http.Request) Authorization {
			return Authorization{Principal: &Principal{Actor: "operator"}}
		},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	page := httptest.NewRecorder()
	handler.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "https://example.test/workhorse/tasks", nil))
	if page.Code != http.StatusServiceUnavailable || strings.Contains(page.Body.String(), "db.internal") ||
		!strings.Contains(page.Body.String(), unverifiedCompatibility) {
		t.Fatalf("page = %d %s", page.Code, page.Body.String())
	}
	if !strings.Contains(logged.String(), "db.internal:5432") {
		t.Fatalf("log = %q", logged.String())
	}
}

func TestHandlerReportsACompatibilityRefusal(t *testing.T) {
	handler, err := newHandler(HandlerOptions{
		Executor: failingExecutor{err: &workhorse.CompatibilityError{Code: workhorse.SchemaTooOld}},
		Authorize: func(*http.Request) Authorization {
			return Authorization{Principal: &Principal{Actor: "operator"}}
		},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	page := httptest.NewRecorder()
	handler.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "https://example.test/workhorse/tasks", nil))
	if page.Code != http.StatusServiceUnavailable ||
		!strings.Contains(page.Body.String(), "refused mutation: schema-too-old") {
		t.Fatalf("page = %d %s", page.Code, page.Body.String())
	}
}

type failingBody struct{ err error }

func (body failingBody) Read([]byte) (int, error) { return 0, body.err }

// A body that the host cannot read gets a fixed message. The text of the reader's error can name
// a path or an address, so it stays in the log. The JSON decoder keeps its own messages.
func TestHandlerAnswersAnUnreadableBodyWithAFixedMessage(t *testing.T) {
	var logged bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logged, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	handler := testHandler(t, func(*http.Request) Authorization {
		return Authorization{Principal: &Principal{Actor: "operator"}}
	})
	const marker = "body-reader-marker /srv/private/decoder.go:42"
	post := func(body io.Reader) map[string]any {
		t.Helper()
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "https://example.test/workhorse/rpc/dashboard/meta", body))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
		}
		var envelope struct {
			JSON map[string]any `json:"json"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		return envelope.JSON
	}

	for _, failure := range []error{
		errors.New(marker),
		fmt.Errorf("%s: %w", marker, io.EOF),
		&json.UnmarshalTypeError{Value: marker, Type: reflect.TypeFor[int]()},
	} {
		unreadable := post(io.MultiReader(strings.NewReader(`{"json":`), failingBody{err: failure}))
		if unreadable["code"] != "BAD_REQUEST" || unreadable["message"] != malformedRequest {
			t.Fatalf("unreadable body with %T = %v", failure, unreadable)
		}
	}
	if !strings.Contains(logged.String(), marker) {
		t.Fatalf("log = %q", logged.String())
	}
	if syntax := post(strings.NewReader(`{"json":}`)); syntax["message"] != "invalid character '}' looking for beginning of value" {
		t.Fatalf("syntax error = %v", syntax)
	}
	if truncated := post(strings.NewReader(`{"json":`)); truncated["message"] != "unexpected EOF" {
		t.Fatalf("truncated body = %v", truncated)
	}
}

// A procedure error that is not a deliberate RPCError gets the fixed 500 answer, because its text
// can name a path or an address.
func TestHandlerAnswersAnUnexpectedProcedureErrorWithAFixed500(t *testing.T) {
	handler, err := newHandler(HandlerOptions{
		Executor: rejectingExecutor{},
		Authorize: func(*http.Request) Authorization {
			return Authorization{Principal: &Principal{Actor: "operator"}}
		},
		Procedures: map[string]Procedure{
			"meta": func(context.Context, any, string) (any, error) {
				return nil, errors.New("procedure-marker db.internal:5432")
			},
		},
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "https://example.test/workhorse/rpc/dashboard/meta", strings.NewReader(`{}`)))
	want := `{"json":{"code":"INTERNAL_SERVER_ERROR","defined":false,"message":"Internal server error","status":500}}`
	if recorder.Code != http.StatusInternalServerError || strings.TrimSpace(recorder.Body.String()) != want {
		t.Fatalf("answer = %d %s", recorder.Code, recorder.Body.String())
	}
}
