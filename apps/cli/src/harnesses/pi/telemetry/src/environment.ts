export interface ResourceEnvironment {
  readonly extensionVersion: string;
  readonly piVersion?: string;
  readonly cliVersion?: string;
  readonly osType: string;
  readonly hostArch: string;
  readonly runtimeName: string;
  readonly runtimeVersion: string;
}

export type PiModuleImporter = () => Promise<{ VERSION?: unknown }>;

export const PI_ORG_TELEMETRY_VERSION = "0.5.0-deputydev.1";

const OS_TYPES: Readonly<Record<string, string>> = {
  win32: "windows",
  sunos: "solaris",
};

const HOST_ARCHS: Readonly<Record<string, string>> = {
  x64: "amd64",
  ia32: "x86",
  arm: "arm32",
};

/**
 * The extension is bundled into the DeputyDev executable and materialized as a
 * standalone ESM asset, so no adjacent package.json exists at runtime.
 */
export function readExtensionVersion(): string {
  return PI_ORG_TELEMETRY_VERSION;
}

/**
 * Read pi's version through a lazy dynamic import so the extension never statically evaluates
 * pi's module graph. Returns undefined when pi cannot be imported.
 */
export async function readPiVersion(
  importer: PiModuleImporter = () => import("@earendil-works/pi-coding-agent"),
): Promise<string | undefined> {
  try {
    const module = await importer();
    return typeof module.VERSION === "string" && module.VERSION ? module.VERSION : undefined;
  } catch {
    return undefined;
  }
}

export function describeEnvironment(
  piVersion?: string,
  extensionVersion: string = readExtensionVersion(),
  platform: string = process.platform,
  arch: string = process.arch,
  versions: NodeJS.ProcessVersions = process.versions,
): ResourceEnvironment {
  const bun = Reflect.get(versions, "bun") as string | undefined;
  return {
    extensionVersion,
    ...(piVersion ? { piVersion } : {}),
    ...(process.env["PI_DEPUTYDEV_CLI_VERSION"] &&
    /^[a-zA-Z0-9._+-]{1,80}$/.test(process.env["PI_DEPUTYDEV_CLI_VERSION"])
      ? { cliVersion: process.env["PI_DEPUTYDEV_CLI_VERSION"] }
      : {}),
    osType: OS_TYPES[platform] ?? platform,
    hostArch: HOST_ARCHS[arch] ?? arch,
    runtimeName: bun ? "bun" : "node",
    runtimeVersion: bun ?? versions.node,
  };
}
