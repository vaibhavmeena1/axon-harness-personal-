# Vortex 3.3.1 reference for the DeputyDev backend

This is a source-level audit of the Vortex version locked by this backend. It is intended to be the local reference when application development begins, not a replacement for re-checking Vortex after an upgrade.

## Audited snapshot

- Package: `vortex==3.3.1`
- Git tag: `3.3.1`
- Locked commit: `e5e546595c43c73faf1c7b8ac7ffecff4473ec02`
- Runtime: Python `>=3.12,<3.13`
- Locked FastAPI version: `0.136.3`
- Locked Starlette version: `1.3.1`
- Installed package inspected: all 58 Python modules, the package metadata, changelog, examples, and tests
- Runtime-smoked locally: app creation, `/ping`, `InternalAPIRouter`, default middleware, request IDs, service headers, process-time headers, and HTTP status mapping

The implementation is the authority for this document. The upstream README and sample app contain several stale examples; those differences are called out below.

## Executive summary

### Good candidates for direct reuse

| Capability | Vortex component | Recommendation |
| --- | --- | --- |
| FastAPI assembly | `vortex.Vortex` | Use as the application wrapper. |
| Router registration | `Vortex(..., routers=[...])` | Use before `create_app()`. |
| Startup/shutdown lifecycle | `lifespans=[(hook, "startup"), ...]` | Use for database, cache, and client setup/cleanup. Hooks must accept the FastAPI app. |
| Basic liveness endpoint | built-in `GET /ping` | Reuse for liveness; add separate readiness checks later. |
| Conventionally internal routes | `InternalAPIRouter` | Reuse for gateway-protected service endpoints; it does not itself enforce access control. |
| Standard error envelope | Vortex exceptions and `ErrorHandler` | Reuse, but explicitly decide whether legacy status-code remapping is acceptable. |
| Correlation and forwarding headers | `VortexContextMiddleware` | Reuse; it is enabled by default. |
| Inter-service HTTP | `BaseAPIClient` plus a suitable parser | Reuse through service-specific subclasses. |
| Structured production logs | Vortex logging setup | Reuse initially, while accounting for its process-global monkey patches. |
| Sentry | built-in integration | Reuse after adding real environment configuration. |
| Sentry cron check-ins | top-level `monitor` decorator | Reuse for async scheduled jobs after Sentry review. |
| OpenTelemetry | built-in tracing, metrics, and error promotion | Reuse when an OTLP collector is available. |
| Event-loop diagnostics | `EventLoopMonitor` | Enable through OTEL only when needed. |
| Interactive shell | `vortex console` | Reuse after the app module exists. |

### Use with care

- `send_response()` returns a `JSONResponse`; callers must pass JSON-serializable data and FastAPI response-model serialization is bypassed.
- Vortex remaps `404 -> 400`, `403 -> 401`, and `405 -> 400` by default.
- `BaseAPIClient` expects a Vortex response envelope unless a different parser is configured.
- Configuration is loaded from `./config.json` at import time and is relative to the process working directory.
- Vortex logging modifies global/private Python logging behavior for the whole process.
- Sentry is initialized with `send_default_pii=True`.

### Do not build new code around these yet

- `Vortex.run()` does not exist. Run the returned FastAPI app with Uvicorn/Gunicorn.
- `Vortex(title=...)` is invalid in 3.3.1 because Vortex already supplies `title` to FastAPI.
- `serialise` is an `async def` wrapper factory, not a normal decorator; the documented `@serialise(...)` form does not work.
- `VortexConfig` and the `default_config=` constructor argument are stored but not applied.
- `debug=` on `Vortex` is stored but does not control FastAPI debug mode; `config.json`'s `DEBUG` does.
- Elastic APM was removed in 3.1.0. The `APM` section in our current template is ignored by Vortex.
- Custom method OTEL instrumentation exists but automatic initialization is commented out.
- The banner/`Wall` implementation is not invoked by `create_app()` and contains hard-coded stale version information.

---

## 1. Import and configuration behavior

### Import-time requirement

Importing `vortex` imports `CONFIG`, whose class body immediately executes:

```python
CONFIG.config = json_file_to_dict("./config.json")
```

Consequences:

1. A readable JSON file named `config.json` must exist in the process working directory before most Vortex imports.
2. Launch backend commands from `apps/backend`, unless deployment explicitly sets that directory as the working directory.
3. Vortex does not natively merge environment variables, YAML, defaults, or multiple config files.
4. `CONFIG.config` is a mutable, process-global dictionary.
5. Passing `service_config=` does not remove the import-time `config.json` requirement because Vortex modules have already loaded `CONFIG`.
6. HTTP clients and OTEL capture configuration from the global `CONFIG.config`; using a separate programmatic dictionary can make components disagree. Prefer the one loaded config object.

The top-level package exports:

```python
from vortex import (
    CONFIG,
    HostConfig,
    InternalAPIRouter,
    LifespanHook,
    Vortex,
    logger,
    monitor,
)
```

### Configuration keys actually consumed by Vortex

#### Host/application keys

| Key | Required | Default | Used for |
| --- | --- | --- | --- |
| `NAME` | Yes | none | FastAPI title, service name, response/log metadata |
| `HOST` | Yes | none | `HostConfig` and default `VortexClient` URL; does not bind a server |
| `PORT` | Yes | none | metadata and default `VortexClient` URL; does not bind a server |
| `WORKERS` | No | `1` | startup metadata only |
| `SINGLE_PROCESS` | No | `true` | parsed and exposed only; no runner behavior |
| `DEBUG` | No | `false` | FastAPI debug mode and logging branch |
| `ACCESS_LOG` | No | `true` | sets `app.state.ACCESS_LOG` in non-debug mode; Vortex does not register its request-log signal automatically |
| `DEV_MODE` | No | `true` | permits Rich logging when local and attached to a TTY |
| `RICH_SHOW_LOCALS` | No | `true` | Rich tracebacks |
| `RICH_TRACEBACK_THEME` | No | `"one-dark"` | Rich traceback theme |

`HOST`, `PORT`, and `WORKERS` are not used to start Uvicorn. They must also be supplied to the actual process command/deployment configuration.

#### Sentry keys

A non-empty service config causes Vortex to initialize Sentry. In practice, `SENTRY` and `SENTRY.DSN` must be present even when the DSN is empty.

| Key | Required | Default/behavior |
| --- | --- | --- |
| `SENTRY.DSN` | Yes | Passed to `sentry_sdk.init` |
| `SENTRY.ENVIRONMENT` | No | `"Local"` |
| `SENTRY.SERVICE_NAME` | No | `"Vortex"` |
| `SENTRY.CAPTURE_WARNING` | No | falsey; warning events are enabled when true |
| `GIT_BRANCH` environment variable | No | added to structured log records |
| `RELEASE_TAG` environment variable | No | used as the Sentry release and OTEL service version |

Important details:

- `send_default_pii=True` is hard-coded.
- `before_send()` exists and understands `exception.sentry_raise`, but it is not passed to `sentry_sdk.init()` in 3.3.1. Do not rely on `sentry_raise=False` suppressing an event.
- `SENTRY.RELEASE_TAG` in JSON is ignored; the process environment variable is used.

#### OpenTelemetry keys

```json
{
  "OPEN_TELEMETRY": {
    "ENABLED": false,
    "SERVICE_NAME": "deputydev-console-backend",
    "ENDPOINT": "collector-host:4317",
    "SAMPLING_RATE": 0.1,
    "METRICS_ENABLED": true,
    "METRICS_EXPORT_INTERVAL_MILLIS": 10000,
    "AIOKAFKA_CONSUMER_AUTO_INSTRUMENTATION_ENABLED": true,
    "EVENT_LOOP_MONITORING": true,
    "EVENT_LOOP_MONITOR_INTERVAL": 0.1,
    "EVENT_LOOP_MONITOR_BLOCKING_THRESHOLD": 0.05,
    "EVENT_LOOP_MONITOR_CRITICAL_THRESHOLD": 0.5,
    "BLOCKING_DETECTION": {
      "ENABLED": false,
      "CODE_PATH_PREFIX": "app",
      "STACK_CAPTURE_THRESHOLD": 0.1,
      "PYSPY_SAMPLE_RATE": 0.1
    },
    "ERROR_SAMPLING": {
      "ENABLED": false,
      "RATE_5XX": 1.0,
      "RATE_4XX": 0.01,
      "EXPORT_FULL_TRACE_ON_ERROR": false,
      "PROMOTE_HANDLED_ERRORS": false,
      "REPORT_ACTUAL_PROMOTION_RATE": false,
      "SKIP_PROMOTION_CODES": [408, 504, 524, 598, 599]
    }
  }
}
```

Behavior:

- `ENABLED` gates tracing, metrics, and event-loop monitoring.
- `ENDPOINT` is used by insecure gRPC OTLP trace and metric exporters.
- `SAMPLING_RATE` is converted to a float and clamped to `0..1`; invalid values become `0.1`.
- Metrics default to enabled when OTEL is enabled.
- `SERVICE_NAME` is inserted from root `NAME` by `setup_otel()` if absent.
- Auto-instrumentation covers FastAPI, HTTPX, aiohttp, Redis, asyncpg, PyMongo/Motor, and aiokafka. Failures are logged as warnings rather than aborting app creation.
- `ERROR_SAMPLING.ENABLED` opts into status-aware trace promotion. Success traffic remains head-sampled at `SAMPLING_RATE`; selected 4xx/5xx or handled-error traces can be promoted at separate rates.
- `RATE_4XX` and `RATE_5XX` default to `SAMPLING_RATE`, are converted to floats, and are clamped to `0..1`.
- `EXPORT_FULL_TRACE_ON_ERROR=true` buffers all child spans for a promoted trace; false buffers only errored child spans.
- `PROMOTE_HANDLED_ERRORS=true` allows a 2xx root with an errored child span to use `RATE_5XX`.
- `REPORT_ACTUAL_PROMOTION_RATE=true` reports the promotion rate in the promoted root's `sample_rate`; false reports the normal head-sampling rate.
- `SKIP_PROMOTION_CODES` defaults to timeout-like statuses `408`, `504`, `524`, `598`, and `599`.

#### HTTP-client keys

`BaseAPIClient.create_client()` reads these root-level keys:

| Key | Default |
| --- | --- |
| `CONCURRENCY_LIMIT` | `100` maximum connections |
| `CONCURRENCY_LIMIT_HOST` | `30` keep-alive connections |
| `TTL_DNS_CACHE` | `10`; used as HTTPX `keepalive_expiry`, despite the key name |
| `HTTP_RETRIES` | `3` transport retries |
| `CONNECT_TIMEOUT` | `10.0` seconds |
| `READ_TIMEOUT` | `30.0` seconds |
| `WRITE_TIMEOUT` | `10.0` seconds |
| `POOL_TIMEOUT` | `10.0` seconds |
| `HTTP2_ENABLED` | `false` |
| `SSL_VERIFY` | `true` |
| `HEALTH_CHECK.TIMEOUT` | `1`; default `VortexClient` timeout |

#### Keys in our template that Vortex itself does not consume

These remain available through `CONFIG.config` and `app.state.config`, so our application can use them, but Vortex 3.3.1 does not implement behavior for them:

- `HTTP_VERSION`
- `LOG_LEVEL`
- `ENABLE_APP_CORS`
- `CORS_ORIGINS`
- `INTERSERVICE_TIMEOUT`
- `JWT_SECRET`
- `DATABASE`
- `REDIS_CACHE_HOSTS`
- `APM` (Elastic APM was removed)

Vortex does not install CORS middleware, authentication, RBAC, database clients, Redis clients, migrations, rate limiting, or security headers. Those remain backend responsibilities.

---

## 2. Application wrapper

### Correct minimal assembly

```python
from fastapi import APIRouter, FastAPI
from vortex import Vortex

router = APIRouter(prefix="/api/v1")


@router.get("/status")
async def status() -> dict[str, str]:
    return {"status": "ok"}


async def startup(app: FastAPI) -> None:
    # Initialize shared dependencies and attach them to app.state.
    pass


async def shutdown(app: FastAPI) -> None:
    # Close shared clients and pools.
    pass


vortex = Vortex(
    routers=[router],
    lifespans=[(startup, "startup"), (shutdown, "shutdown")],
    description="Centralized management API for DeputyDev CLI installations",
    version="0.1.0",
)
app = vortex.create_app()
```

Use `uvicorn app.main:app` or an equivalent deployment command later. There is no Vortex server runner.

Do not pass `title`, `debug`, or `lifespan` through `**vortex_kwargs`:

- Vortex always calls `FastAPI(title=host_config.NAME, ...)`.
- Vortex always calls `FastAPI(debug=host_config.DEBUG, ...)`.
- Vortex always supplies its combined lifespan.
- Passing `title=` or `lifespan=` causes duplicate-keyword errors.
- The explicit `debug=` argument to `Vortex` does not override `host_config.DEBUG`.

Other FastAPI constructor arguments such as `description`, `version`, `docs_url`, `redoc_url`, `openapi_url`, and `root_path` can be passed through.

### `Vortex` constructor

```python
Vortex(
    routers: list[APIRouter] | None = None,
    lifespans: list[VortexLifespan] | None = None,
    *,
    service_config: dict[str, Any] | None = None,
    default_config: VortexConfig | None = None,
    middlewares: list[MiddlewareTuple] | None = None,
    debug: bool = False,
    error_handler: ErrorHandler | None = None,
    **vortex_kwargs,
)
```

Public API:

| Member | Behavior |
| --- | --- |
| `create_app() -> FastAPI` | Idempotently constructs and returns one FastAPI app. |
| `host_config -> HostConfig` | Parsed host configuration. |
| `register_router(router)` | Adds a router before app creation; raises `RuntimeError` afterward. |
| `register_listener(listener, hook_type)` | Adds a tuple lifecycle hook before app creation; raises `RuntimeError` afterward. |
| `routers -> list[APIRouter]` | Returns a shallow copy, including the built-in health router. |
| `lifespans -> list[VortexLifespan]` | Returns a shallow copy, including default hooks. |
| `middlewares -> list[MiddlewareTuple]` | Returns a shallow copy, including default context middleware. |

`create_app()` performs this sequence:

1. Build the combined lifespan.
2. Initialize Sentry.
3. Construct FastAPI.
4. Set `app.state.host_config` and `app.state.config`.
5. Initialize OTEL tracing/instrumentation when enabled.
6. Copy the service config into `app.extra`.
7. Register Vortex exception handlers.
8. Include user routers, then the default health router.
9. Register middleware.
10. Configure logging.

`Vortex` is marked `@final` for type checkers. Prefer composition and injected routers/hooks/handlers instead of subclassing it.

### Built-in route

`HealthCheck.get_default_routers()` supplies:

```text
GET /ping -> {"ping": "pong"}
```

It is a simple liveness check. It does not inspect database, cache, downstream-service, OTEL, or event-loop health. The upstream `/healthcheck/ping` documentation is stale.

### Internal routes

`InternalAPIRouter` is a top-level-exported `APIRouter` subclass that prefixes every route with `/__onemg-internal__`:

```python
from vortex import InternalAPIRouter

router = InternalAPIRouter(prefix="/v1")


@router.get("/cli-installations")
async def list_installations():
    ...

# Registered path: /__onemg-internal__/v1/cli-installations
```

An optional non-empty `prefix` must begin with `/` or construction raises `ValueError`. The router provides naming only: it performs no authentication, authorization, network filtering, or external-traffic blocking. The ingress/gateway must block `/__onemg-internal__` publicly, and application-level auth should still be used where appropriate.

The prefix is also available as `vortex.constants.constants.INTERNAL_HTTP_PREFIX`.

---

## 3. Lifespan management

### Supported forms

`VortexLifespan` accepts either:

1. `(hook, "startup")` or `(hook, "shutdown")`, where the hook receives `FastAPI`; or
2. a Starlette/FastAPI async lifespan context-manager factory.

Hooks may be synchronous or return an awaitable:

```python
async def connect(app: FastAPI) -> None:
    app.state.client = await create_client()


async def disconnect(app: FastAPI) -> None:
    await app.state.client.close()
```

Default lifecycle hooks:

- startup: `add_service_started`
- startup: `log_meta`
- startup: `init_metrics_and_event_loop_monitor`
- shutdown: `stop_event_loop_monitor`

User lifespans are appended after those defaults. Context managers enter in registration order and exit in reverse order. Tuple shutdown hooks therefore execute in reverse registration position during normal app shutdown.

Public helpers in `vortex.lifespan`:

| Symbol | Purpose |
| --- | --- |
| `HookType` | `Literal["startup", "shutdown"]` |
| `LifespanHook` | callable receiving `FastAPI`, returning `None` or an awaitable |
| `separate_hooks(lifespans)` | separates tuple hooks into startup and shutdown lists; intended mainly for the CLI |
| `create_fastapi_lifespan(lifespans)` | combines tuple hooks and lifespan context managers |

Caveat: `vortex console` calls `separate_hooks(vortex_manager._lifespans)` and expects every item to be a tuple. A custom context-manager lifespan can work under FastAPI but break the console path.

---

## 4. Middleware and request context

### Default behavior

The only default middleware is:

```python
(VortexContextMiddleware, 999)
```

For each HTTP request it:

- accepts `X-REQUEST-ID` or generates a UUID;
- writes the ID back into the request headers;
- stores it in Vortex's task `ContextVar`;
- builds global inter-service headers;
- stores those headers at `request.state.global_headers`;
- adds `X-SERVICE-NAME`, `X-PROCESS-TIME`, and `X-REQUEST-ID` to the response.

Propagated headers are:

- `X-SERVICE-NAME` (replaced with the current service name)
- `X-VISITOR-ID`
- `X-SOURCE-IP`
- `X-SOURCE-USER-AGENT`
- `X-SOURCE-REFERER`
- `X-REQUEST-ID`

`BaseAPIClient` reads the task context and forwards these headers automatically.

### Available middleware classes

| Class | Status | Behavior |
| --- | --- | --- |
| `VortexContextMiddleware` | Default/recommended | Request ID, forwarding context, response metadata, timing |
| `VortexTimingMiddleware` | Optional/redundant | Adds `X-Process-Time`; context middleware already does this |
| `VortexLoggingMiddleware` | Marked unused | Logs request start/completion |
| `asgi_correlation_id.CorrelationIdMiddleware` | Special-cased by registrar | Registered with `validator=None` if supplied |

### Registration API

`MiddlewareTuple` is either an ASGI middleware class or `(middleware_class, priority)`.

```python
Vortex(middlewares=[(MyASGIMiddleware, 100)])
```

`register_middlewares()` supports no arbitrary constructor kwargs. Only Vortex context middleware and `CorrelationIdMiddleware` receive special kwargs.

Observed ordering in 3.3.1:

- higher numeric priorities become outer middleware and execute earlier on the request path;
- equal-priority user middleware is outside the default context middleware;
- middleware that requires Vortex request context during its request-side work should use a priority lower than `999` so the default context middleware runs first.

Do not add a second `VortexContextMiddleware`; Vortex appends one automatically.

`vortex.ctx._task_ctx` is importable but private. Prefer `request.state.global_headers`, normal FastAPI dependencies, and `BaseAPIClient` rather than coupling application code to it.

---

## 5. Responses and errors

### Standard success response

```python
send_response(
    data=None,
    status_code=200,
    *,
    status_mapping=True,
    meta=None,
    body=None,
    headers=None,
    purge_response_keys=False,
)
```

Normal output:

```json
{
  "data": {},
  "is_success": true,
  "status_code": 200,
  "meta": {}
}
```

`meta` is omitted when falsey. `body=` bypasses envelope construction and must itself contain `status_code`. `purge_response_keys=True` returns the envelope dictionary instead of a `JSONResponse`; despite the name, it does not return only the inner `data`.

Important FastAPI behavior:

- Returning `JSONResponse` bypasses FastAPI's normal response serialization and response-model handling.
- Pydantic models, datetimes, decimals, and ORM objects must be converted first, for example with `fastapi.encoders.jsonable_encoder`.
- A route's `response_model=User` does not match Vortex's `{data, is_success, status_code}` envelope. Define envelope response models or return normal FastAPI data consistently.
- Avoid bodies with HTTP 204 responses.

### Legacy status mapping

With `status_mapping=True`, both success and error helpers apply:

| Requested status | Actual status |
| --- | --- |
| `404` | `400` |
| `403` | `401` |
| `405` | `400` |

This also affects FastAPI `HTTPException` and Vortex exceptions through the global error handler. For conventional REST semantics, use `status_mapping=False` on success responses and `custom_http_codes_mapping_enabled=False` where supported by exceptions/error helpers.

### Error helpers

| Function | Purpose |
| --- | --- |
| `send_error_response(error, status_code, meta=None, error_code=None, custom_http_codes_mapping_enabled=True)` | Builds the standard error envelope. |
| `get_error_body_response` | Alias of `send_error_response`. |
| `exception_response(exception, error=None, status_code=None, *, meta=None)` | Builds an error response from an exception. For a generic exception, pass `error=` explicitly. |
| `serialise(handler, *, status_mapping=True)` | Async wrapper factory. It must itself be awaited and should not be used as a route decorator in 3.3.1. |

String errors become:

```json
{
  "is_success": false,
  "status_code": 400,
  "error": {
    "message": "message",
    "errors": [{"message": "message"}]
  }
}
```

Dictionary errors are passed through as the `error` value without normalization.

### Global `ErrorHandler`

`ExceptionRegistry.register()` installs handlers for:

- `VortexException`
- `RequestValidationError`
- Starlette/FastAPI `HTTPException`
- all other `Exception` instances

Behavior:

- handled Vortex 4xx exceptions produce their declared envelope;
- request validation errors produce status 422 and detailed error entries;
- `HTTPException` is normalized into the Vortex error envelope;
- unknown exceptions log and return `500` with `"Something went wrong!"`;
- a custom `ErrorHandler` can be injected into `Vortex(error_handler=...)`.

### Exception classes

All derive from `VortexException` unless noted.

| Class | Default status | Notes |
| --- | ---: | --- |
| `VortexException` | 400 | Base for service/domain exceptions |
| `TaskExecutorException` | 400 | Task execution failures |
| `InterServiceRequestException` | 400 | Downstream response failures; supports mapping toggle |
| `HTTPInterServiceRequestException` | 400 | Alias of `InterServiceRequestException` |
| `HTTPRequestException` | 500 | General HTTP client failure |
| `HTTPRequestTimeoutException` | 408 | HTTP timeout |
| `BadRequestException` | 400 | Explicit bad request |
| `JsonDecodeException` | 500 | JSON decoding failure |
| `ForbiddenException` | 403 | Becomes 401 by default mapping; supports mapping toggle |
| `NotFoundException` | 404 | Becomes 400 by default mapping; supports mapping toggle |
| `OpenCircuitException` | 503 | Circuit-open/service-unavailable case |
| `StartupException` | 400 | Startup failure; inherits base constructor |
| `HTTPClientException` | 500 | HTTP client base-style exception |
| `HTTPResponseParsingException` | 500 | Downstream parsing failure |
| `HTTPConnectException` | 503 | Downstream connection failure |

Common exception properties:

- `error`
- `status_code`
- `meta`
- `quiet` (stored but not used by Vortex)
- `error_id`
- `error_code`
- `code` (stored but not used by Vortex)
- `sentry_raise` (not reliably honored because `before_send` is not wired)

Observed constructor defect in 3.3.1: `HTTPRequestException`, `HTTPRequestTimeoutException`, `JsonDecodeException`, `ForbiddenException`, `HTTPClientException`, `HTTPResponseParsingException`, and `HTTPConnectException` pass `error_code` into the base constructor's `error_id` position. Do not depend on `error_code` for those classes until Vortex fixes it. `BadRequestException`, `InterServiceRequestException`, `NotFoundException`, and `OpenCircuitException` pass it correctly.

---

## 6. Inter-service HTTP clients

### Public client classes

```python
from vortex.clients import (
    AsyncTaskResponse,
    BaseAPIClient,
    BaseAPIResponseParser,
    LegacyAPIResponseParser,
    SearchAPIClient,
    SearchAPIResponseParser,
    VortexClient,
    VortexResponseParser,
)
```

Recommended pattern:

```python
from vortex.clients import BaseAPIClient, LegacyAPIResponseParser


class CliRegistryClient(BaseAPIClient):
    _host = "https://registry.internal"
    _timeout = 10
    _parser = LegacyAPIResponseParser
```

Use one subclass per downstream service and close its shared class-level HTTPX client during shutdown:

```python
await CliRegistryClient.close()
```

### Request API

`BaseAPIClient` provides async class methods:

- `request(method, path, data=None, query_params=None, timeout=None, headers=None, multipart=False, response_headers_list=None, purge_response_keys=False, **httpx_kwargs)`
- `get(...)`
- `post(...)`
- `put(...)`
- `patch(...)`
- `delete(...)`
- `create_client()`
- `close()`

Behavior:

- URL is simple concatenation of `_host + path`.
- non-multipart `data` is encoded with `ujson` and sent as raw `content`;
- `Content-Type: application/json` is forced for non-multipart calls;
- multipart dictionaries split file-like/bytes/tuple values into `files` and everything else into string form fields;
- caller headers are mutated and Vortex global headers overwrite matching caller values;
- HTTPX request kwargs are accepted through `**kwargs`;
- one pooled `httpx.AsyncClient` is retained per subclass until `close()`;
- redirects are followed;
- only JSON responses are supported reliably.

Query behavior:

- booleans become lowercase `true`/`false`;
- list key `tags` becomes repeated `tags[]` entries;
- `None` values are omitted;
- existing query parameters in the URL are replaced, not appended.

Exceptions:

- timeout -> `HTTPRequestTimeoutException` (408)
- connect error -> `HTTPConnectException` (503)
- other request/parsing error -> `HTTPRequestException` (500)
- a valid downstream error envelope -> `InterServiceRequestException`

`__interservice__` exists as a class attribute but is not consulted by `request()`. `prepare_headers(..., interservice=False)` supports disabling propagation only when called directly; the normal request path always enables it.

### Response parsers

| Parser | Expected payload | Success rule |
| --- | --- | --- |
| `BaseAPIResponseParser` | strict Vortex/Search envelope | truthy `is_success` |
| `SearchAPIResponseParser` | same envelope, with `errors` handling | truthy `is_success` |
| `VortexResponseParser` | Vortex envelope or a raw JSON dictionary | HTTP 2xx/3xx and `is_success` not false |
| `LegacyAPIResponseParser` | arbitrary JSON | HTTP 2xx/3xx |

The default `_parser` is `BaseAPIResponseParser`. A raw JSON list or dictionary without `is_success` will not work with the default parser. Configure `LegacyAPIResponseParser` for ordinary third-party APIs, or `VortexResponseParser` for tolerant Vortex-to-Vortex calls.

`VortexClient` does not switch to `VortexResponseParser`; it still inherits the strict base parser. It builds its URL once at import time as `http://{CONFIG.HOST}:{CONFIG.PORT}` and uses `HEALTH_CHECK.TIMEOUT`. Treat it as a narrow self-service helper, not the default client for arbitrary downstreams.

### `AsyncTaskResponse`

Properties:

- `.data`
- `.status` / `.status_code`
- `.meta`
- `.headers`
- `.to_dict()`

Boolean conversion is true only for status `200 <= status < 400`.

`response_headers_list` controls which downstream headers are retained in `.headers`; headers are discarded by default.

---

## 7. Logging

### Exposed components

| Symbol | Purpose |
| --- | --- |
| `vortex.logger` | package logger from `vortex.logging.log` |
| `StructuredLoggingFormatter` | JSON formatter based on `python-json-logger` |
| `patch_standard_logging()` | enforces the structured formatter process-wide |
| `patch_log_record_factory(...)` | adds Vortex metadata to every log record |
| `setup_rich_logging(...)` | local Rich handler/tracebacks |

In non-debug mode, Vortex patches logging and adds:

- `version` (`"v2"`)
- `request_id`
- `logtype`
- `service_name`
- `branchname`
- `current_tag`
- `host`
- `trace_id`
- `span_id`

`logtype` values:

- `access`
- `custom`
- `background`
- `external`

The JSON formatter renames `levelname -> loglevel`, `asctime -> timestamp`, renames `exc_info -> traceback`, removes logger `name`, and truncates `message` to 2,000 characters.

Caveats:

- the patch replaces `logging._addHandlerRef` and `logging.Handler.setFormatter`, both process-global/private implementation points;
- after patching, attempts to install a non-Vortex formatter are ignored;
- production logging is selected by `DEBUG=false`, not by a separate environment concept;
- `is_local()` means only “not running with `KUBERNETES_SERVICE_HOST`”; a non-Kubernetes production host is considered local;
- `log_request_info()` exists in `vortex.constants.signals` but is not wired by Vortex, and its direct use should be tested before adoption.

---

## 8. OpenTelemetry and event-loop monitoring

### Tracing

`init_tracing_provider()` creates:

- normal `ParentBasedTraceIdRatio` sampling, or the error-promotion sampler when enabled;
- an insecure gRPC OTLP exporter;
- `SampleRateAttributeSpanProcessor`;
- `OtelSpanContextProcessor` for log correlation;
- `SpanRenamerSpanProcessor`;
- batched span export, optionally wrapped in `PromotingExportProcessor`.

Span renaming covers asyncpg, HTTP clients, aiokafka, MongoDB, and Redis. Some renaming uses SDK-private span attributes such as `_name`, so validate after OTEL SDK upgrades.

The span context API exposes `otel_span_context.get_trace_id()` and `.get_span_id()`. It is mainly consumed by logging. Context is set on span start and is not explicitly cleared on span end in 3.3.1.

### Status-aware error sampling

When `OPEN_TELEMETRY.ERROR_SAMPLING.ENABLED=true`, `create_error_promotion_sampler()` records head-dropped local spans without initially marking them sampled. `PromotingExportProcessor` then decides whether to export a trace when its local root ends:

- head-sampled traces are exported unchanged;
- a head-dropped 4xx root is promoted at `RATE_4XX`;
- a head-dropped 5xx or `StatusCode.ERROR` root is promoted at `RATE_5XX`;
- a 2xx root with an errored child is promoted at `RATE_5XX` only when `PROMOTE_HANDLED_ERRORS=true`;
- ordinary head-dropped 2xx traces are discarded;
- timeout-like codes in `SKIP_PROMOTION_CODES` are treated as non-errors for promotion;
- promoted roots receive `promoted=true`.

By default, only errored child spans are buffered, so a promoted result is the local root plus errored children. `EXPORT_FULL_TRACE_ON_ERROR=true` buffers all child spans. Internal bounds are 1,024 trace entries, 30 child spans per trace, and a 300-second stale-entry TTL during eviction.

This design records more unsampled spans than basic head sampling and uses private OTEL SDK fields to flip sampled contexts during export. Enable it deliberately, load-test it, and revalidate it after OTEL dependency changes.

Public implementation APIs include:

- `create_error_promotion_sampler(sampling_rate)`;
- `PromotingExportProcessor(...)`;
- `is_error_sampling_enabled()`;
- `get_rate_4xx()` and `get_rate_5xx()`;
- `is_full_trace_on_error_enabled()`;
- `is_report_actual_promotion_rate_enabled()`;
- `is_promote_handled_errors_enabled()`;
- `get_skip_promotion_codes()`.

Application code should normally configure this feature rather than instantiate its sampler/processor directly.

### Metrics and event-loop monitor

When OTEL and event-loop monitoring are enabled, Vortex attaches the monitor to:

```python
app.state.event_loop_monitor
```

Useful API:

- `await monitor.start()`
- `await monitor.stop()`
- `monitor.get_stats()`
- `monitor.reset_stats()`
- `monitor.blocking_operations_monitoring_enabled()`

`get_stats()` returns current lag, active tasks, cumulative utilization, blocking count, maximum lag, measurement count, thresholds, status, and task breakdown.

Emitted metrics:

- `asyncio.eventloop.lag`
- `asyncio.eventloop.active_tasks`
- `asyncio.eventloop.utilization`
- `asyncio.eventloop.max_lag`
- `asyncio.eventloop.blocking_events`
- `asyncio.eventloop.blocking_events.pyspy`
- `asyncio.eventloop.lag_distribution`
- `asyncio.eventloop.task.active_count`
- `asyncio.eventloop.task.lag_contribution`

Health labels are `healthy`, `ok`, `degraded`, and `critical`. “Utilization” is a cumulative lag/interval ratio, not CPU utilization.

### Deep blocking detection

`BlockingDetector` runs in a daemon process and monitors an event-loop heartbeat. `PySpyManager` can capture and attribute a frozen stack to a low-cardinality application frame.

Operational requirements:

- `py-spy` is installed by Vortex;
- Linux/Kubernetes generally needs `SYS_PTRACE` capability;
- macOS attachment generally needs elevated permission;
- stack captures are sampled by `PYSPY_SAMPLE_RATE`;
- no attributed metric is emitted when a usable frame under `CODE_PATH_PREFIX` cannot be found.

Keep blocking detection disabled until deployment permissions and overhead have been reviewed.

### Dynamic custom instrumentation

`CustomInstrumentor` can monkey-patch sync or async class methods with spans:

- `instrument_method(...) -> bool`
- `uninstrument_method(...) -> bool`
- `get_instrumented_methods() -> list[tuple[str, str, str]]`

Helpers include `extract_bucket_name`, `safe_queue_name`, `extract_queue_name`, and `extract_kafka_topic`.

A global `custom_instrumentor` is available. However, Vortex's `_init_custom_instrumentation()` call is commented out, so `OPEN_TELEMETRY.CUSTOM_INSTRUMENTATION.METHODS` currently has no automatic effect. Avoid relying on this private initialization path.

---

## 9. Sentry

Public functions:

- `init_sentry(service_config)`
- `init_sentry_for_cron(service_config)`
- `before_send(event, hint)`
- listener-level `setup_sentry(config)`
- listener-level `setup_sentry_for_cron(config)`
- listener-level `setup_logging_for_cron(service_config, app_name, debug=False)`

Vortex calls `setup_sentry()` during `create_app()`. It installs Starlette, FastAPI, and logging integrations. Logging events are captured at ERROR by default or WARNING when `CAPTURE_WARNING` is true.

Before enabling a real DSN for DeputyDev:

1. Review `send_default_pii=True` against the data policy.
2. Confirm exception and request-body scrubbing.
3. Confirm whether handled exceptions are captured as desired.
4. Do not rely on `sentry_raise=False` until `before_send` is wired upstream or by the application.

### Async cron monitoring

The top-level `monitor` export aliases `SentryCronMonitor.monitor`:

```python
from vortex import monitor


@monitor(
    monitor_slug="sync-cli-installations",
    monitor_config={
        "schedule": {"type": "crontab", "value": "*/10 * * * *"},
        "timezone": "Asia/Kolkata",
        "checkin_margin": 5,
        "max_runtime": 10,
    },
)
async def sync_cli_installations() -> None:
    ...
```

It sends direct Sentry envelope API check-ins with one generated check-in ID:

1. `in_progress` before the async function;
2. `ok` with duration on success; or
3. `error` with duration on any `BaseException`, then re-raises.

Real `Exception` failures are also captured as Sentry issues with cron tags. Cancellation is marked as an error check-in but not captured as an issue. Check-in delivery uses a new HTTPX client, a 10-second timeout, up to three attempts, and a two-second delay between attempts. Delivery failure is logged/captured but swallowed, so it does not replace the job's own result. `PYTEST_CURRENT_TEST` suppresses all real check-ins during an active pytest test.

The decorator supports async functions only. It reads `SENTRY.DSN` from global `CONFIG.config`, constructs the Sentry envelope URL from that DSN, and sends `monitor_config` only on the initial check-in.

For a standalone cron process, call `setup_logging_for_cron()` and `setup_sentry_for_cron()` before executing the decorated function. The cron Sentry setup intentionally avoids FastAPI/Starlette integrations and skips initialization when no DSN is configured. A background task inside the web service should use the already initialized web Sentry integration instead.

Elastic APM is not part of Vortex 3.3.1. It was explicitly removed in the 3.1.0 changelog.

---

## 10. CLI

Installed entry point:

```text
vortex -> vortex.cli:run
```

Commands:

- `vortex console`
- `vortex example-command` (no-op placeholder)

Console defaults:

- `VORTEX_APP=app.main:app`
- `VORTEX_MANAGER=app.main:vortex`

The console:

- imports the FastAPI app and Vortex manager;
- runs tuple startup hooks on one persistent event loop;
- opens IPython with top-level `await` support;
- exposes `app`, `vortex_manager`, `asyncio`, `json`, `os`, and `sys`;
- optionally imports models from `app.models.db.db_models`;
- runs tuple shutdown hooks when exiting.

Limitations:

- it accesses the private `vortex_manager._lifespans` attribute;
- custom context-manager lifespans are not supported by its `separate_hooks()` path;
- console shutdown order is list order, while normal nested lifespan shutdown is reverse order;
- it does not start an HTTP server.

---

## 11. Smaller reusable utilities

### Configuration classes

- `HostConfig.from_dict(config)` parses required `NAME`, `HOST`, and `PORT` plus host defaults.
- `SentryConfig.from_dict(config)` parses Sentry settings and reads release from `RELEASE_TAG` environment variable.
- `VortexConfig(**kwargs)` only stores `.settings`; Vortex 3.3.1 does not apply them.

### Common utilities

| Symbol | Behavior/caveat |
| --- | --- |
| `json_file_to_dict(file)` | Reads JSON with `ujson`; logs and re-raises parse/file errors. |
| `get_current_time()` | Integer Unix timestamp. |
| `get_uuid_token()` | UUID4 string. |
| `log_combined_message(title, error, level="error")` | Structured exception field plus a second combined info log; inputs must concatenate as strings. |
| `log_combined_error(title, error)` | Error log plus combined info log. |
| `log_combined_exception(title, exception)` | Adds exception type and text. |
| `object_to_dict(result)` | Recursively converts `__dict__`, dictionaries, lists, and datetimes; mutates dictionaries/objects and has no cycle protection. |
| `get_page_info(count, records, limit, offset)` | Returns zero-based `page_number`, page size, total, and `has_more_records`; `limit` must be nonzero. |
| `name(obj)` | Returns `type(obj).__name__`. |
| `is_atty()` | Whether stdout is attached to a TTY. |
| `is_running_in_k8s()` | Checks `KUBERNETES_SERVICE_HOST`. |
| `is_local()` | Negation of `is_running_in_k8s()`. |
| `legacy(reason=None)` | Marker wrapper only; use `@legacy()` or `@legacy("reason")`, not bare `@legacy`. |
| `SingletonMeta` | Process-local singleton metaclass; not lock-protected and ignores later constructor arguments. |

### Request and context helpers

- `RequestHeaders(headers, service_name).interservice_headers` creates the forwarding-header dictionary.
- `_task_ctx.req_id` and `_task_ctx.global_headers` are private context-variable properties used internally.

### Rich wall

`Wall(app).render()` can print registered routes and metadata in a local TTY. It is not called by `Vortex.create_app()` and currently hard-codes old Vortex/FastAPI/Starlette versions and localhost port 8000. Treat it as development-only and non-authoritative.

---

## 12. Constants and types

### HTTP

`HTTPStatusCodes`:

- `SUCCESS=200`
- `BAD_REQUEST=400`
- `NOT_FOUND=404`
- `FORBIDDEN=403`
- `UNAUTHORIZED=401`
- `MOVED_TEMPORARILY=302`
- `INTERNAL_SERVER_ERROR=500`
- `REQUEST_TIMEOUT=408`
- `SERVICE_UNAVAILABLE=503`
- `UNPROCESSABLE_ENTITY=422`

`HTTPMethod`: `get`, `post`, `put`, `patch`, `delete`.

`STATUS_CODE_MAPPING = {404: 400, 403: 401, 405: 400}`.

### Headers

- `X-HEADERS`
- `X-SHARED-CONTEXT`
- `X-REQUEST-ID`
- `X-VISITOR-ID`
- `X-SOURCE-IP`
- `X-SOURCE-USER-AGENT`
- `X-SOURCE-REFERER`
- `X-SERVICE-NAME`
- `X-SERVICE-VERSION`
- `X-PROCESS-TIME`
- `X-USER-AGENT`
- `User-Agent`
- `Content-Type`
- `Accept`
- `global_headers`

### Other enums/constants

- `ENV.GIT_BRANCH`, `ENV.RELEASE_TAG`
- `Client`: `android`, `ios`, `web`, `mweb`, `admin`
- `LifespanEvent`: `startup`, `shutdown`
- `HEALTHY_STATUS`, `UNHEALTHY_STATUS`
- `INTERNAL_HTTP_PREFIX="/__onemg-internal__"`
- `FORMAT_VERSION="v2"`
- `LogType`: access, custom, background, external
- `LogLevel`: debug, info, warning, error, critical
- error/log message constants in `vortex.constants.errors`

### Typing helpers

- `ResponseDict`
- `ErrorResponseDict`
- `LifespanTuple`
- `VortexLifespan`
- `MiddlewareTuple`
- `HookType`
- `LifespanHook`

---

## 13. Complete importable API inventory

Vortex does not consistently declare `__all__`, so “public” below means either explicitly re-exported or a non-underscore symbol available from a package module.

| Module | Importable symbols |
| --- | --- |
| `vortex` | `Vortex`, `LifespanHook`, `HostConfig`, `CONFIG`, `logger`, `InternalAPIRouter`, `monitor` |
| `vortex.clients` | `BaseAPIClient`, `SearchAPIClient`, `VortexClient`, `BaseAPIResponseParser`, `SearchAPIResponseParser`, `VortexResponseParser`, `LegacyAPIResponseParser`, `AsyncTaskResponse` |
| `vortex.common_utils` | `json_file_to_dict`, `CONFIG`, `get_current_time`, `get_uuid_token`, `log_combined_message`, `log_combined_error`, `log_combined_exception`, `object_to_dict`, `get_page_info` |
| `vortex.config` | `HostConfig`, `SentryConfig`, `VortexConfig` |
| `vortex.constants` | `ENV`, `HTTPStatusCodes` |
| `vortex.constants.constants` | `ENV`, `Client`, `LifespanEvent`, `HEALTHY_STATUS`, `UNHEALTHY_STATUS`, `INTERNAL_HTTP_PREFIX` |
| `vortex.constants.http` | `HTTPStatusCodes`, `HTTPMethod`, `STATUS_CODE_MAPPING`, `STATUS_CODE_4XX` |
| `vortex.constants.headers` | all header constants listed above |
| `vortex.constants.logging` | `FORMAT_VERSION`, `LogType`, `LogLevel` |
| `vortex.constants.signals` | `log_request_info` |
| `vortex.defaults` | `HealthCheck` |
| `vortex.error_handling.error_handler` | `ErrorHandler`, `HANDLED_EXCEPTIONS` |
| `vortex.error_handling.exception_registry` | `ExceptionRegistry` |
| `vortex.event_loop_monitor.blocking_detector` | `should_pyspy_capture`, `BlockingDetector` |
| `vortex.event_loop_monitor.event_loop_monitor` | `EventLoopStats`, `EventLoopMonitor` |
| `vortex.event_loop_monitor.pyspy_manager` | `PySpyManager` |
| `vortex.exceptions` | all exception classes and alias listed in section 5 |
| `vortex.integrations.otel.custom_instrumentation` | `SampleRateAttributeSpanProcessor`, `OtelSpanContextProcessor`, `SpanRenamerSpanProcessor` |
| `vortex.integrations.otel.custom_method_instrumentation` | `extract_bucket_name`, `safe_queue_name`, `extract_queue_name`, `extract_kafka_topic`, `CustomInstrumentor`, `custom_instrumentor` |
| `vortex.integrations.otel.exporters` | `PromotingExportProcessor` |
| `vortex.integrations.otel.samplers` | `create_error_promotion_sampler` |
| `vortex.integrations.otel.otel` | `OtelInitializationState`, OTEL/metrics/event-loop/error-sampling config getters, provider initialization, `get_tracer`, `get_meter`, app instrumentation, monitor startup/shutdown |
| `vortex.integrations.otel.span_context` | `OtelSpanDetails`, `otel_span_context` |
| `vortex.integrations.sentry` | `init_sentry`, `init_sentry_for_cron`, `before_send` |
| `vortex.lifespan` | `HookType`, `LifespanHook`, `separate_hooks`, `create_fastapi_lifespan` |
| `vortex.listeners.integrations` | `setup_sentry`, `setup_sentry_for_cron`, `setup_logging_for_cron`, `setup_otel` |
| `vortex.listeners.meta` | `add_service_started`, `log_meta` |
| `vortex.logging.factory` | `patch_log_record_factory` |
| `vortex.logging.formatters` | `StructuredLoggingFormatter` |
| `vortex.logging.setup` | `patch_standard_logging`, `setup_rich_logging`, `LOG_FORMAT` |
| `vortex.meta_class` | `SingletonMeta` |
| `vortex.middleware` | `MiddlewareTuple`, three Vortex middleware classes, `DEFAULT_MIDDLEWARES`, `register_middlewares` |
| `vortex.request.request_headers` | `RequestHeaders` |
| `vortex.response` | `send_response`, `serialise`, `send_error_response`, `get_error_body_response`, `exception_response` |
| `vortex.routing` | `InternalAPIRouter` |
| `vortex.types` | `ResponseDict`, `ErrorResponseDict`, `LifespanTuple`, `VortexLifespan` |
| `vortex.utils` | `name`, `is_atty`, `is_local`, `is_running_in_k8s`, `legacy` |
| `vortex.wall` | `Wall`, logos, `COLOR_1MG` |
| `vortex.wrappers` | top-level-friendly `monitor` alias |
| `vortex.wrappers.sentry_monitor` | `SentryCronMonitor` (`monitor`, `_send_checkin`, and `_parse_dsn` methods; only `monitor` is intended as public use) |
| `vortex.cli` | CLI runner, console helpers, import helper, and placeholder command |

Empty namespace packages include `vortex.event_loop_monitor`, `vortex.integrations`, `vortex.integrations.otel`, `vortex.logging`, and `vortex.request`. Import concrete symbols from their implementation modules unless a parent package explicitly re-exports them.

---

## 14. Upstream documentation and example mismatches

Do not copy these upstream examples without checking this reference:

| Upstream claim/example | Vortex 3.3.1 implementation |
| --- | --- |
| `Vortex(title="...")` | Causes duplicate `title` when FastAPI is constructed. Use config `NAME`. |
| `app.run()` / `vortex_app.run()` | No such method. Use Uvicorn/Gunicorn. |
| `GET /healthcheck/ping` | Actual built-in route is `GET /ping`. |
| Hooks with no parameters | Vortex calls every tuple hook with the FastAPI app. |
| Environment-driven Vortex config | Config is import-time `./config.json`; no built-in env merge. |
| Elastic APM integration | Removed in 3.1.0. |
| Built-in CORS/security headers | Not implemented by Vortex middleware. |
| `@serialise(...)` | `serialise` is async and cannot be used that way. |
| `vortex.ctx.req_ctx` | Does not exist in the installed package. |
| Middleware tuples carrying kwargs | Registrar accepts only class or `(class, integer_priority)`. |
| Raw third-party API via base client | Default parser expects a Vortex envelope. |
| Pydantic object passed directly to `send_response` | `JSONResponse` requires prior JSON encoding. |
| Response model describes inner model while returning envelope | FastAPI validation/serialization is bypassed by the returned `JSONResponse`. |
| Wall displays current versions | Values are hard-coded and stale; wall is not invoked. |

The upstream test suite is broad but includes placeholder/skipped tests and several shallow assertions, so tests alone should not be treated as proof that every documented integration works end to end.

---

## 15. Recommended DeputyDev adoption plan

When backend code is introduced:

1. Keep the process working directory at `apps/backend` so `config.json` loads predictably.
2. Create one `Vortex` manager and one exported FastAPI `app`.
3. Register all routers and lifecycle hooks before `create_app()`.
4. Use lifecycle hooks to initialize and close database pools, Redis, and every `BaseAPIClient` subclass.
5. Add CORS explicitly with FastAPI/Starlette middleware; the config keys alone do nothing.
6. Choose one response contract early:
   - normal FastAPI/Pydantic responses, or
   - typed Vortex envelopes using JSON-encoded data.
7. Decide whether to disable legacy HTTP status mapping. Conventional API behavior should preserve 404 and 403.
8. Define a client subclass and parser for each downstream service; never assume the default parser accepts raw JSON.
9. Use `request.state` and FastAPI dependencies for application context. Keep `_task_ctx` internal.
10. Add readiness endpoints separate from `/ping`.
11. Review Sentry PII behavior before supplying a DSN.
12. Use `InternalAPIRouter` only together with verified ingress filtering and application authorization.
13. Use `monitor` only for async cron jobs, with standalone cron Sentry/logging setup where required.
14. Enable OTEL only after collector endpoint, sampling, and Kubernetes permissions are defined.
15. Keep `ERROR_SAMPLING.ENABLED=false` until promotion rates and buffering overhead are load-tested.
16. Keep `BLOCKING_DETECTION.ENABLED=false` until `SYS_PTRACE` and py-spy operational requirements are approved.
17. Add regression tests around response envelopes, 404/403 mapping, exception `error_code`, lifecycle order, and client parsing.
18. Re-audit this file whenever the Vortex lock commit changes.

## Upgrade checklist

After changing the Vortex version:

1. Record the new tag and resolved Git commit.
2. Diff `vortex/__init__.py` and package `__all__` exports.
3. Diff `Vortex.__init__`, `create_app()`, default routers, lifespans, and middleware.
4. Diff config key reads.
5. Re-test the import-time `config.json` requirement.
6. Re-test `/ping` and response headers.
7. Re-test success/error status mapping.
8. Re-test client parser defaults and exception constructors.
9. Verify Sentry `before_send` and PII configuration.
10. Verify OTEL instrumentors and event-loop metric names.
11. Check whether custom instrumentation is enabled.
12. Reconcile this document and `config_template.json` with the new behavior.
