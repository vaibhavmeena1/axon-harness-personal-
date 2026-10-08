import type {
  HarnessAdapter,
  HarnessRegistration,
  StableHarnessId,
} from "../launcher/contracts.ts";

export const HARNESS_REGISTRY = Object.freeze([
  {
    id: "pi",
    executableCandidates: ["pi"],
    executableOverrideVariable: "AXON_PI_BIN",
  },
] as const satisfies readonly HarnessRegistration[]);

export function resolveHarnessRegistration(token: string): HarnessRegistration | undefined {
  return HARNESS_REGISTRY.find((registration) => registration.id === token);
}

export async function loadHarnessAdapter(id: StableHarnessId): Promise<HarnessAdapter> {
  const adapter = (await import("./pi/adapter.ts")).createPiAdapter();

  if (adapter.id !== id) {
    throw new Error(`adapter identity mismatch: expected ${id}, received ${adapter.id}`);
  }

  return adapter;
}
