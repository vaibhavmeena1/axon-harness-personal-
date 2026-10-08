export type EnvironmentVariableOwner =
  | "public"
  | "public-launcher"
  | "build-tooling"
  | "internal-updater";

export interface EnvironmentVariableDefinition {
  readonly owner: EnvironmentVariableOwner;
  readonly consumers: readonly string[];
  readonly mayReachHarness: boolean;
  readonly safeToPrint: boolean;
}

export type EnvironmentOverrides = Readonly<Record<string, string | undefined>>;

export const AXON_ENVIRONMENT_REGISTRY = Object.freeze({
  AXON_HOME: {
    owner: "public",
    consumers: ["launcher", "updater"],
    mayReachHarness: false,
    safeToPrint: true,
  },
  AXON_NO_UPDATE: {
    owner: "public",
    consumers: ["updater"],
    mayReachHarness: false,
    safeToPrint: true,
  },
  AXON_PIN: {
    owner: "public",
    consumers: ["updater"],
    mayReachHarness: false,
    safeToPrint: true,
  },
  AXON_ALLOW_CI_UPDATE: {
    owner: "public",
    consumers: ["updater"],
    mayReachHarness: false,
    safeToPrint: true,
  },
  AXON_DEBUG: {
    owner: "public-launcher",
    consumers: ["launcher"],
    mayReachHarness: false,
    safeToPrint: true,
  },
  AXON_INTERNAL_NO_UPDATE: {
    owner: "internal-updater",
    consumers: ["updater"],
    mayReachHarness: false,
    safeToPrint: false,
  },
  AXON_SWAPPED: {
    owner: "internal-updater",
    consumers: ["updater"],
    mayReachHarness: false,
    safeToPrint: false,
  },
  AXON_SERVICE_ORIGIN: {
    owner: "build-tooling",
    consumers: ["local build tooling"],
    mayReachHarness: false,
    safeToPrint: true,
  },
  AXON_PI_BIN: {
    owner: "public-launcher",
    consumers: ["Pi pin validation (rejected)"],
    mayReachHarness: false,
    safeToPrint: true,
  },
  AXON_PI_VERSION: {
    owner: "public-launcher",
    consumers: ["Pi source development override; built CLI pin validation"],
    mayReachHarness: false,
    safeToPrint: true,
  },
} satisfies Readonly<Record<string, EnvironmentVariableDefinition>>);

export function createHarnessEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
  ...overrides: readonly EnvironmentOverrides[]
): NodeJS.ProcessEnv {
  const harnessEnvironment: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(inheritedEnvironment)) {
    if (value === undefined) {
      continue;
    }

    if (!name.startsWith("AXON_")) {
      harnessEnvironment[name] = value;
      continue;
    }

    const definition = AXON_ENVIRONMENT_REGISTRY[name as keyof typeof AXON_ENVIRONMENT_REGISTRY] as
      | EnvironmentVariableDefinition
      | undefined;

    if (definition?.mayReachHarness) {
      harnessEnvironment[name] = value;
    }
  }

  for (const layer of overrides) {
    for (const [name, value] of Object.entries(layer)) {
      if (value === undefined) {
        delete harnessEnvironment[name];
      } else {
        harnessEnvironment[name] = value;
      }
    }
  }

  return harnessEnvironment;
}
