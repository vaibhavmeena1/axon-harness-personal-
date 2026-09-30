/**
 * Central registry for every DeputyDev service endpoint.
 *
 * Add new backend routes here instead of scattering string literals across
 * feature folders. Callers compose a full URL with {@link resolveServiceUrl}
 * and keep any domain-specific defaults (for example `BUILD_INFO.serviceOrigin`)
 * in their own `paths.ts`.
 *
 * ```ts
 * import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../product/endpoints.ts";
 *
 * const url = resolveServiceUrl(serviceOrigin, SERVICE_ENDPOINTS.pi.mcpConfig);
 * ```
 */

/** A service path, always rooted at `/` (never a full URL). */
export type EndpointPath = `/${string}`;

/** Template parameters for dynamic endpoints, e.g. `/v1/items/:id`. */
export type EndpointTemplateParams = Readonly<Record<string, string | number>>;

/** Optional query string appended by {@link resolveServiceUrl}. */
export type EndpointQuery = Readonly<Record<string, string | number | boolean>>;

function defineEndpoint<const T extends EndpointPath>(path: T): T {
  return path;
}

/**
 * Every backend endpoint grouped by domain. One glance shows the full
 * service surface; adding a route is a one-line change in one file.
 */
export const SERVICE_ENDPOINTS = Object.freeze({
  auth: Object.freeze({
    browserLogin: defineEndpoint("/api/v1/auth/browser-login"),
  }),
  otel: Object.freeze({
    /** Authenticated OTLP/HTTP base; exporters append /v1/{signal}. */
    base: defineEndpoint("/api/v1/otel"),
  }),
  cli: Object.freeze({
    /** Authenticated, non-secret telemetry preferences. */
    config: defineEndpoint("/api/v1/cli/config"),
  }),
  pi: Object.freeze({
    /** Organization MCP catalog consumed by Pi setup. */
    mcpConfig: defineEndpoint("/v1/cli/pi/mcp.json"),
  }),
  release: Object.freeze({
    /** Public CLI release discovery, checksums, and CloudFront download redirect. */
    base: defineEndpoint("/api/v1/cli/releases"),
  }),
  // Add future domains here, for example:
  // updater: Object.freeze({
  //   manifest: defineEndpoint("/v1/cli/updates/manifest.json"),
  // }),
});

type EndpointGroup = (typeof SERVICE_ENDPOINTS)[keyof typeof SERVICE_ENDPOINTS];
type GroupPaths<T> = T extends Readonly<Record<string, infer V>> ? V : never;

/** Union of every registered endpoint path. Useful for type-safe helpers. */
export type ServiceEndpointPath = GroupPaths<EndpointGroup>;

/**
 * Fill a `:param` template, e.g.
 * `fillEndpointTemplate("/v1/items/:id", { id: "42" })`.
 * Values are URI-encoded. Throws when a parameter is missing.
 */
export function fillEndpointTemplate<const T extends string>(
  template: T,
  params: EndpointTemplateParams,
): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`missing endpoint parameter: ${JSON.stringify(name)}`);
    }
    return encodeURIComponent(String(value));
  });
}

function appendQuery(url: string, query?: EndpointQuery): string {
  if (query === undefined || Object.keys(query).length === 0) {
    return url;
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    search.append(key, String(value));
  }
  return `${url}?${search.toString()}`;
}

/**
 * Compose a full service URL from a validated origin and an endpoint path.
 * The origin is expected to have no trailing slash (see `parseServiceOrigin`),
 * but a stray slash is tolerated so callers never produce `//v1/...`.
 */
export function resolveServiceUrl(
  serviceOrigin: string,
  endpointPath: EndpointPath | string,
  query?: EndpointQuery,
): string {
  const origin = serviceOrigin.replace(/\/+$/, "");
  return appendQuery(`${origin}${endpointPath}`, query);
}

/**
 * Create a bound resolver for a fixed origin. Handy for dependency injection
 * and tests: `const toUrl = createServiceUrlResolver(origin)`.
 */
export function createServiceUrlResolver(serviceOrigin: string) {
  return (endpointPath: EndpointPath | string, query?: EndpointQuery): string =>
    resolveServiceUrl(serviceOrigin, endpointPath, query);
}

export interface ServiceEndpointEntry {
  readonly group: string;
  readonly name: string;
  readonly path: string;
}

/**
 * Flat, sorted view of the whole registry. Useful for `doctor --verbose`,
 * debug logging, or auditing the service surface in one place.
 */
export function listServiceEndpoints(): readonly ServiceEndpointEntry[] {
  const entries: ServiceEndpointEntry[] = [];
  for (const [group, endpoints] of Object.entries(SERVICE_ENDPOINTS)) {
    for (const [name, path] of Object.entries(endpoints as Readonly<Record<string, string>>)) {
      entries.push({ group, name, path });
    }
  }
  return entries.sort((a, b) =>
    a.group === b.group ? a.name.localeCompare(b.name) : a.group.localeCompare(b.group),
  );
}
