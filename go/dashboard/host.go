package dashboard

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"path"
	"strings"
	"sync"

	workhorse "github.com/stablemates/workhorse/go"
)

// Principal is the identity established by an embedding application's authorization boundary.
type Principal struct{ Actor string }

// Authorization is one host authorization decision. A nil Principal is unauthenticated.
type Authorization struct {
	Principal *Principal
	Response  *http.Response
}

// Authorize authenticates and authorizes every dashboard, asset, and RPC request.
type Authorize func(*http.Request) Authorization

// Procedure implements one dashboard/v1 RPC operation.
type Procedure func(context.Context, any, string) (any, error)

// RPCError is a defined dashboard error returned by a procedure.
type RPCError struct {
	Status  int
	Code    string
	Message string
	Data    any
}

func (failure *RPCError) Error() string { return failure.Message }

// HandlerOptions configure one single-workspace embedded dashboard.
type HandlerOptions struct {
	Executor          workhorse.Executor
	Authorize         Authorize
	Path              string
	Environment       string
	AuditActor        string
	ReadOnly          bool
	BrowserModules    []string
	ConfiguredWorkers []string
	MaintenanceLoops  map[string]int
	// Procedures permits host-supplied extensions and is primarily useful for enqueueTest.
	Procedures map[string]Procedure
	// SkipCompatibilityCheck is intended for transport tests whose executor cannot reach PostgreSQL.
	SkipCompatibilityCheck bool
}

type handler struct {
	options         HandlerOptions
	basePath        string
	compatible      bool
	compatibilityMu sync.Mutex
	assets          map[string][]byte
	assetsErr       error
	assetsOnce      sync.Once
}

var mutations = map[string]bool{
	"enqueueTest": true, "setScheduleEnabled": true, "setQueuePaused": true,
	"purgeQueue": true, "setWorkerPaused": true, "overrideMaintenancePolicy": true,
	"revertMaintenancePolicy": true, "overrideRetentionPolicy": true,
	"revertRetentionPolicy": true, "runTaskNow": true, "cancelTask": true,
	"signalTask": true, "completeHumanWait": true,
}

var optionalMutations = map[string]bool{
	"enqueueTest": true, "setScheduleEnabled": true,
}

var contentTypes = map[string]string{
	".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
	".woff2": "font/woff2",
}

// NormalizePath canonicalizes a dashboard mount. Root ownership is represented by an empty path.
func NormalizePath(value string) string {
	parts := strings.FieldsFunc(value, func(r rune) bool { return r == '/' })
	if len(parts) == 0 {
		return ""
	}
	return "/" + strings.Join(parts, "/")
}

// NewHandler constructs a framework-neutral net/http dashboard backend.
func NewHandler(options HandlerOptions) (http.Handler, error) {
	if options.Executor == nil {
		return nil, errors.New("dashboard executor is required")
	}
	if options.Authorize == nil {
		return nil, errors.New("dashboard authorize callback is required")
	}
	if options.Path == "" {
		options.Path = "/workhorse"
	}
	if options.Environment == "" {
		options.Environment = "development"
	}
	if options.Procedures == nil {
		options.Procedures = make(map[string]Procedure)
	}
	if options.MaintenanceLoops == nil {
		options.MaintenanceLoops = map[string]int{"tickIntervalMs": 1000}
	}
	builtins := (&backend{executor: options.Executor, admin: workhorse.NewAdmin(options.Executor), environment: options.Environment, configuredWorkers: options.ConfiguredWorkers, readOnly: options.ReadOnly, maintenanceLoops: options.MaintenanceLoops}).procedures()
	for name, procedure := range options.Procedures {
		builtins[name] = procedure
	}
	options.Procedures = builtins
	return &handler{options: options, basePath: NormalizePath(options.Path)}, nil
}

func (host *handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	pathname := request.URL.Path
	if !host.owns(pathname) {
		http.NotFound(response, request)
		return
	}
	authorization := host.options.Authorize(request)
	if authorization.Response != nil {
		copyResponse(response, authorization.Response)
		return
	}
	if authorization.Principal == nil {
		writeJSON(response, http.StatusUnauthorized, map[string]any{"error": "Unauthorized"})
		return
	}
	actor := authorization.Principal.Actor
	if host.options.AuditActor != "" {
		actor = host.options.AuditActor
	}
	if err := host.assertCompatible(request.Context()); err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"error": err.Error()})
		return
	}
	mountRoot := host.basePath
	if mountRoot == "" {
		mountRoot = "/"
	}
	if pathname == mountRoot {
		http.Redirect(response, request, host.basePath+"/tasks", http.StatusFound)
		return
	}
	assetPrefix := host.basePath + "/assets/"
	if strings.HasPrefix(pathname, assetPrefix) {
		host.serveAsset(response, strings.TrimPrefix(pathname, host.basePath+"/"))
		return
	}
	rpcPrefix := host.basePath + "/rpc/dashboard/"
	if strings.HasPrefix(pathname, rpcPrefix) {
		host.serveRPC(response, request, strings.TrimPrefix(pathname, rpcPrefix), actor)
		return
	}
	host.serveApplication(response, actor)
}

func (host *handler) owns(pathname string) bool {
	if host.basePath == "" {
		return strings.HasPrefix(pathname, "/")
	}
	return pathname == host.basePath || strings.HasPrefix(pathname, host.basePath+"/")
}

func (host *handler) assertCompatible(ctx context.Context) error {
	if host.options.SkipCompatibilityCheck {
		return nil
	}
	host.compatibilityMu.Lock()
	defer host.compatibilityMu.Unlock()
	if host.compatible {
		return nil
	}
	if err := workhorse.AssertSchemaCompatible(ctx, host.options.Executor); err != nil {
		return err
	}
	host.compatible = true
	return nil
}

func (host *handler) serveRPC(response http.ResponseWriter, request *http.Request, name, actor string) {
	if request.Method != http.MethodPost {
		writeRPCError(response, http.StatusMethodNotAllowed, "METHOD_NOT_SUPPORTED", "Method Not Supported")
		return
	}
	if mutations[name] {
		if !sameOrigin(request) {
			writeJSON(response, http.StatusForbidden, map[string]any{"error": "A same-origin mutation request is required"})
			return
		}
		if host.options.ReadOnly {
			writeRPCError(response, http.StatusForbidden, "FORBIDDEN", "This dashboard is read-only")
			return
		}
	}
	procedure := host.options.Procedures[name]
	if procedure == nil {
		if optionalMutations[name] {
			writeRPCError(response, http.StatusForbidden, "FORBIDDEN", "This procedure is not available")
			return
		}
		writeRPCError(response, http.StatusNotFound, "NOT_FOUND", "Procedure not found")
		return
	}
	var envelope struct {
		JSON any `json:"json"`
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, 2<<20))
	decoder.UseNumber()
	if err := decoder.Decode(&envelope); err != nil {
		writeRPCError(response, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	if err := ValidateInput(name, envelope.JSON); err != nil {
		if name == "tasks" {
			if input, ok := envelope.JSON.(map[string]any); ok {
				if page, valid := number(input["page"]); valid && page < 1 {
					writeRPCErrorData(response, http.StatusBadRequest, "BAD_REQUEST", "Input validation failed", map[string]any{"issues": []any{map[string]any{"origin": "number", "code": "too_small", "minimum": 1, "inclusive": true, "path": []any{"page"}, "message": "Too small: expected number to be >=1"}}})
					return
				}
			}
		}
		writeRPCError(response, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	if name == "enqueueTest" {
		if input, ok := envelope.JSON.(map[string]any); ok && input["kind"] == "feature" && input["feature"] == nil {
			writeRPCErrorData(response, http.StatusBadRequest, "BAD_REQUEST", "Input validation failed", map[string]any{"issues": []any{map[string]any{"code": "custom", "path": []any{"feature"}, "message": "The feature demo kind requires a feature family"}}})
			return
		}
	}
	assignActor(envelope.JSON, actor)
	result, err := procedure(request.Context(), envelope.JSON, actor)
	if err != nil {
		var rpcError *RPCError
		if errors.As(err, &rpcError) {
			writeRPCErrorData(response, rpcError.Status, rpcError.Code, rpcError.Message, rpcError.Data)
			return
		}
		writeRPCError(response, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "Internal server error")
		return
	}
	if result == nil {
		writeJSON(response, http.StatusOK, map[string]any{})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"json": result})
}

func assignActor(input any, actor string) {
	document, ok := input.(map[string]any)
	if !ok {
		return
	}
	audit, ok := document["audit"].(map[string]any)
	if ok {
		audit["actor"] = actor
	}
}

func sameOrigin(request *http.Request) bool {
	origin := request.Header.Get("Origin")
	parsed, err := request.URL.Parse(origin)
	if err != nil || origin == "" || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	scheme := request.URL.Scheme
	if scheme == "" {
		if request.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	return parsed.Scheme == scheme && parsed.Host == request.Host
}

func (host *handler) serveApplication(response http.ResponseWriter, actor string) {
	assets, err := host.bundle()
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	template := string(assets["app/index.html"])
	config := map[string]any{
		"basePath": host.basePath, "rpcUrl": host.basePath + "/rpc", "auditActor": actor,
		"authentication": nil, "demoTools": host.options.Procedures["enqueueTest"] != nil,
		"workspaces": []any{}, "workspace": nil,
	}
	encoded, _ := json.Marshal(config)
	modules := strings.Builder{}
	for _, source := range host.options.BrowserModules {
		fmt.Fprintf(&modules, `<script type="module" src="%s"></script>`, html.EscapeString(source))
	}
	page := strings.Replace(template, "/*__WORKHORSE_RUNTIME_CONFIG__*/", "window.workhorseDashboard = "+string(encoded), 1)
	page = strings.Replace(page, "<!--__WORKHORSE_BROWSER_MODULES__-->", modules.String(), 1)
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(response, page)
}

func (host *handler) serveAsset(response http.ResponseWriter, name string) {
	clean := path.Clean(name)
	if clean != name || strings.HasPrefix(clean, "../") {
		http.NotFound(response, nil)
		return
	}
	assets, err := host.bundle()
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	data, ok := assets["app/"+name]
	if !ok {
		http.NotFound(response, nil)
		return
	}
	if contentType := contentTypes[path.Ext(name)]; contentType != "" {
		response.Header().Set("Content-Type", contentType)
	}
	response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	_, _ = response.Write(data)
}

func (host *handler) bundle() (map[string][]byte, error) {
	host.assetsOnce.Do(func() {
		manifestData, err := Files.ReadFile("bundle.json")
		if err != nil {
			host.assetsErr = err
			return
		}
		var manifest struct {
			Archive string `json:"archive"`
		}
		if err := json.Unmarshal(manifestData, &manifest); err != nil {
			host.assetsErr = err
			return
		}
		archive, err := Files.Open(manifest.Archive)
		if err != nil {
			host.assetsErr = err
			return
		}
		defer archive.Close()
		gzipReader, err := gzip.NewReader(archive)
		if err != nil {
			host.assetsErr = err
			return
		}
		defer gzipReader.Close()
		result := make(map[string][]byte)
		reader := tar.NewReader(gzipReader)
		for {
			header, err := reader.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				host.assetsErr = err
				return
			}
			if header.Typeflag != tar.TypeReg {
				continue
			}
			data, err := io.ReadAll(reader)
			if err != nil {
				host.assetsErr = err
				return
			}
			result[header.Name] = data
		}
		host.assets = result
	})
	return host.assets, host.assetsErr
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeRPCError(response http.ResponseWriter, status int, code, message string) {
	writeRPCErrorData(response, status, code, message, nil)
}

func writeRPCErrorData(response http.ResponseWriter, status int, code, message string, data any) {
	failure := map[string]any{
		"defined": false, "code": code, "status": status, "message": message,
	}
	if data != nil {
		failure["data"] = data
	}
	writeJSON(response, status, map[string]any{"json": failure})
}

func copyResponse(destination http.ResponseWriter, source *http.Response) {
	for name, values := range source.Header {
		for _, value := range values {
			destination.Header().Add(name, value)
		}
	}
	destination.WriteHeader(source.StatusCode)
	if source.Body != nil {
		defer source.Body.Close()
		_, _ = io.Copy(destination, source.Body)
	}
}
