const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface ServiceOriginOptions {
  readonly allowLoopbackHttp: boolean;
}

/** Validate the service base URL, including an optional deployment path such as /axon. */
export function parseServiceOrigin(value: string, options: ServiceOriginOptions): string {
  if (value.endsWith("/")) {
    throw new Error("service origin must not have a trailing slash");
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("service origin must be an absolute URL");
  }

  if (value.includes("?") || value.includes("#") || url.username || url.password) {
    throw new Error("service origin must not contain credentials, a query, or a fragment");
  }

  // Inspect the original path: URL parsing silently removes dot segments and normalizes
  // backslashes/whitespace, which could otherwise move requests outside the deployment mount.
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(value);
  const path = match?.[1] ?? "";
  if (
    !match ||
    /[\\\s\p{Cc}]/u.test(value) ||
    (path !== "" &&
      path
        .slice(1)
        .split("/")
        .some(
          (segment) => !/^[A-Za-z0-9._~-]+$/.test(segment) || segment === "." || segment === "..",
        ))
  ) {
    throw new Error("service origin base path must contain safe, non-empty URL segments");
  }

  const isHttps = url.protocol === "https:";
  const isAllowedLoopbackHttp =
    options.allowLoopbackHttp && url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);

  if (!isHttps && !isAllowedLoopbackHttp) {
    throw new Error("service origin must use HTTPS outside loopback development");
  }

  return `${url.origin}${path}`;
}
