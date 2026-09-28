import { resolve, sep } from "node:path";

import { z } from "zod";

export const PI_PACKAGE_MANIFEST_SCHEMA_VERSION = 1 as const;

const packageIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
const semanticVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/i);

const exactVersionPolicySchema = z
  .strictObject({
    kind: z.literal("exact"),
    version: semanticVersionSchema.optional(),
    commit: gitCommitSchema.optional(),
  })
  .refine((policy) => (policy.version === undefined) !== (policy.commit === undefined), {
    message: "exact policy requires exactly one of version or commit",
  });

const minimumVersionPolicySchema = z.strictObject({
  kind: z.literal("minimum"),
  version: semanticVersionSchema,
});

const floatingVersionPolicySchema = z.strictObject({
  kind: z.literal("floating"),
});

export const piPackageVersionPolicySchema = z.union([
  exactVersionPolicySchema,
  minimumVersionPolicySchema,
  floatingVersionPolicySchema,
]);

export const piPackageManifestEntrySchema = z
  .strictObject({
    id: packageIdSchema,
    source: z.string().trim().min(1),
    required: z.literal(true),
    versionPolicy: piPackageVersionPolicySchema,
    install: z.strictObject({ action: z.literal("pi.install") }),
    updates: z.strictObject({ owner: z.literal("pi-or-user") }).optional(),
    revokedVersions: z.array(semanticVersionSchema).default([]),
  })
  .superRefine((entry, context) => {
    const sourceKind = getSourceKind(entry.source);
    if (sourceKind === undefined) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "source must be a version-free npm or git package source",
      });
      return;
    }

    if (sourceKind === "npm" && !isVersionFreeNpmSource(entry.source)) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "npm source must omit its version; versionPolicy owns the constraint",
      });
    }

    if (sourceKind === "git" && parseGitSource(entry.source) === undefined) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "git source must be a supported version-free repository URL or shorthand",
      });
    }

    if (entry.versionPolicy.kind === "minimum" && sourceKind !== "npm") {
      context.addIssue({
        code: "custom",
        path: ["versionPolicy"],
        message: "minimum version policy is supported only for npm packages",
      });
    }

    if (entry.versionPolicy.kind === "exact") {
      if (sourceKind === "npm" && entry.versionPolicy.version === undefined) {
        context.addIssue({
          code: "custom",
          path: ["versionPolicy"],
          message: "exact npm policy requires version",
        });
      }
      if (sourceKind === "git" && entry.versionPolicy.commit === undefined) {
        context.addIssue({
          code: "custom",
          path: ["versionPolicy"],
          message: "exact git policy requires commit",
        });
      }
    }

    if (
      entry.revokedVersions.length > 0 &&
      (sourceKind !== "npm" || entry.versionPolicy.kind !== "exact")
    ) {
      context.addIssue({
        code: "custom",
        path: ["revokedVersions"],
        message: "revokedVersions is supported only for exact npm packages",
      });
    }

    const piOrUserOwned = entry.versionPolicy.kind !== "exact";
    if (piOrUserOwned !== (entry.updates?.owner === "pi-or-user")) {
      context.addIssue({
        code: "custom",
        path: ["updates"],
        message:
          entry.versionPolicy.kind === "exact"
            ? "exact package must not declare Pi/user-owned updates"
            : "minimum and floating packages require updates.owner=pi-or-user",
      });
    }
  });

export const piResourceManifestEntrySchema = z.strictObject({
  id: packageIdSchema,
  type: z.enum(["extension", "skill", "prompt", "theme"]),
  destination: z.string().trim().min(1),
});

export const deputyDevManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(PI_PACKAGE_MANIFEST_SCHEMA_VERSION),
    revision: z.string().trim().min(1),
    pi: z.strictObject({
      packages: z.array(piPackageManifestEntrySchema),
      resources: z.array(piResourceManifestEntrySchema).default([]),
    }),
  })
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    const identities = new Set<string>();

    for (const [index, resource] of manifest.pi.resources.entries()) {
      if (
        resource.destination.startsWith("/") ||
        resource.destination
          .split(/[\\/]/)
          .some((part) => part === "" || part === "." || part === "..")
      ) {
        context.addIssue({
          code: "custom",
          path: ["pi", "resources", index, "destination"],
          message: "resource destination must be a safe relative path",
        });
      }
      if (ids.has(resource.id)) {
        context.addIssue({
          code: "custom",
          path: ["pi", "resources", index, "id"],
          message: `duplicate manifest id: ${resource.id}`,
        });
      }
      ids.add(resource.id);
    }

    for (const [index, entry] of manifest.pi.packages.entries()) {
      if (ids.has(entry.id)) {
        context.addIssue({
          code: "custom",
          path: ["pi", "packages", index, "id"],
          message: `duplicate manifest id: ${entry.id}`,
        });
      }
      ids.add(entry.id);

      try {
        const identity = normalizePackageIdentity(entry.source);
        if (identities.has(identity)) {
          context.addIssue({
            code: "custom",
            path: ["pi", "packages", index, "source"],
            message: `duplicate package identity: ${identity}`,
          });
        }
        identities.add(identity);
      } catch {
        // The entry-level source diagnostic is more specific.
      }
    }
  });

export type PiPackageVersionPolicy = z.infer<typeof piPackageVersionPolicySchema>;
export type PiPackageManifestEntry = z.infer<typeof piPackageManifestEntrySchema>;
export type PiResourceManifestEntry = z.infer<typeof piResourceManifestEntrySchema>;
export type DeputyDevManifest = z.infer<typeof deputyDevManifestSchema>;
export type PiPackageSourceKind = "npm" | "git";

export interface ParsedGitSource {
  readonly host: string;
  readonly path: string;
}

export interface NormalizedPiPackage extends PiPackageManifestEntry {
  readonly sourceKind: PiPackageSourceKind;
  readonly identity: string;
  readonly configuredSource: string;
  readonly packageName?: string;
  readonly git?: ParsedGitSource;
}

function getSourceKind(source: string): PiPackageSourceKind | undefined {
  if (source.startsWith("npm:")) {
    return "npm";
  }
  if (
    source.startsWith("git:") ||
    source.startsWith("https://") ||
    source.startsWith("http://") ||
    source.startsWith("ssh://") ||
    source.startsWith("git://")
  ) {
    return "git";
  }
  return undefined;
}

const NPM_PACKAGE_NAME_PATTERN = "(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*";

function npmPackageName(source: string): string | undefined {
  const match = source.match(new RegExp(`^npm:(${NPM_PACKAGE_NAME_PATTERN})$`, "i"));
  return match?.[1];
}

function configuredNpmPackageName(source: string): string | undefined {
  const match = source.match(new RegExp(`^npm:(${NPM_PACKAGE_NAME_PATTERN})(?:@.+)?$`, "i"));
  return match?.[1];
}

function isVersionFreeNpmSource(source: string): boolean {
  return npmPackageName(source) !== undefined;
}

function stripGitSuffix(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
}

function safeGitPath(path: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  const parts = decoded.split("/");
  return decoded.includes("\\") ||
    parts.length < 2 ||
    parts.some((part) => part === "" || part === "." || part === ".." || part.includes("@"))
    ? undefined
    : decoded;
}

export function parseGitSource(source: string): ParsedGitSource | undefined {
  const value = source.startsWith("git:") ? source.slice("git:".length) : source;

  if (/^[^/\s@]+@[^/:\s]+:[^\s]+$/.test(value)) {
    const match = value.match(/^[^@]+@([^:]+):(.+)$/);
    if (match?.[1] && match[2]) {
      const path = safeGitPath(stripGitSuffix(match[2]));
      return path === undefined ? undefined : { host: match[1].toLowerCase(), path };
    }
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    try {
      const url = new URL(value);
      const path = safeGitPath(stripGitSuffix(url.pathname));
      return url.hostname && path !== undefined
        ? { host: url.hostname.toLowerCase(), path }
        : undefined;
    } catch {
      return undefined;
    }
  }

  const shorthand = value.match(/^([^/:\s]+)\/(.+)$/);
  if (!shorthand?.[1] || !shorthand[2]) {
    return undefined;
  }
  const path = safeGitPath(stripGitSuffix(shorthand[2]));
  return path === undefined ? undefined : { host: shorthand[1].toLowerCase(), path };
}

export function normalizePackageIdentity(source: string): string {
  const npmName = npmPackageName(source);
  if (npmName !== undefined) {
    return `npm:${npmName}`;
  }

  const git = parseGitSource(source);
  if (git !== undefined) {
    return `git:${git.host}/${git.path}`;
  }

  throw new Error(`unsupported or versioned Pi package source: ${source}`);
}

export function normalizeConfiguredPackageIdentity(source: string): string | undefined {
  const npmName = configuredNpmPackageName(source);
  if (npmName !== undefined) {
    return `npm:${npmName}`;
  }

  const lastAt = source.lastIndexOf("@");
  const lastSeparator = Math.max(source.lastIndexOf("/"), source.lastIndexOf(":"));
  const sourceWithoutRef = lastAt > lastSeparator ? source.slice(0, lastAt) : source;
  const git = parseGitSource(sourceWithoutRef);
  return git === undefined ? undefined : `git:${git.host}/${git.path}`;
}

function configuredSource(entry: PiPackageManifestEntry): string {
  if (entry.versionPolicy.kind === "floating") {
    return entry.source;
  }
  if (entry.versionPolicy.kind === "minimum") {
    return `${entry.source}@>=${entry.versionPolicy.version}`;
  }
  if (entry.versionPolicy.version !== undefined) {
    return `${entry.source}@${entry.versionPolicy.version}`;
  }
  return `${entry.source}@${entry.versionPolicy.commit}`;
}

export function normalizePiPackage(entry: PiPackageManifestEntry): NormalizedPiPackage {
  const sourceKind = getSourceKind(entry.source);
  if (sourceKind === undefined) {
    throw new Error(`unsupported Pi package source: ${entry.source}`);
  }

  const packageName = sourceKind === "npm" ? npmPackageName(entry.source) : undefined;
  const git = sourceKind === "git" ? parseGitSource(entry.source) : undefined;
  if (
    (sourceKind === "npm" && packageName === undefined) ||
    (sourceKind === "git" && git === undefined)
  ) {
    throw new Error(`invalid Pi package source: ${entry.source}`);
  }

  return Object.freeze({
    ...entry,
    sourceKind,
    identity: normalizePackageIdentity(entry.source),
    configuredSource: configuredSource(entry),
    ...(packageName === undefined ? {} : { packageName }),
    ...(git === undefined ? {} : { git }),
  });
}

export function parseDeputyDevManifest(input: unknown): DeputyDevManifest {
  return deputyDevManifestSchema.parse(input);
}

export function normalizeManifestPackages(input: unknown): readonly NormalizedPiPackage[] {
  const manifest = parseDeputyDevManifest(input);
  return Object.freeze(manifest.pi.packages.map(normalizePiPackage));
}

export function hashDeputyDevManifest(manifest: DeputyDevManifest): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(manifest));
  return hasher.digest("hex");
}

export function resolveInstalledIdentityPath(identity: string, piAgentDirectory: string): string {
  const normalizedIdentity = normalizePackageIdentity(identity);
  if (normalizedIdentity !== identity) {
    throw new Error(`package identity is not canonical: ${identity}`);
  }
  const sourceKind = identity.startsWith("npm:") ? "npm" : "git";
  const npmName = sourceKind === "npm" ? npmPackageName(identity) : undefined;
  const git = sourceKind === "git" ? parseGitSource(identity) : undefined;
  const root =
    sourceKind === "npm"
      ? resolve(piAgentDirectory, "npm", "node_modules")
      : resolve(piAgentDirectory, "git");
  const installedPath =
    sourceKind === "npm"
      ? resolve(root, npmName as string)
      : resolve(root, git?.host as string, git?.path as string);
  if (!installedPath.startsWith(`${root}${sep}`)) {
    throw new Error(`resolved Pi package path escapes its managed root: ${installedPath}`);
  }
  return installedPath;
}

export function resolveInstalledPackagePath(
  packageEntry: NormalizedPiPackage,
  piAgentDirectory: string,
): string {
  const installedPath = resolveInstalledIdentityPath(packageEntry.identity, piAgentDirectory);
  return installedPath;
}
