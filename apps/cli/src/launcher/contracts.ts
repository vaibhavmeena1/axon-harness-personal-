import type { AxonPaths } from "../product/paths.ts";

export type StableHarnessId = "pi";

export interface LaunchContext {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly paths: AxonPaths;
}

export interface HarnessLaunchContext extends LaunchContext {
  readonly registration: HarnessRegistration;
  readonly executable: string;
}

export interface LaunchSpec {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Explicit invocation offline state, not a telemetry environment preference. */
  readonly offline?: boolean;
  /** Release per-session resources before propagating the child's exit status. */
  readonly dispose?: () => void;
}

export interface DoctorFinding {
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly remediation?: string;
}

export interface ExecutableResolutionOptions {
  /** Forwarded harness arguments; lets an adapter skip provisioning for administration. */
  readonly userArguments: readonly string[];
  /** False for diagnostics: locate an executable but never download one. */
  readonly allowInstall: boolean;
}

export interface HarnessAdapter {
  readonly id: StableHarnessId;
  /** Optional adapter-owned resolution (bootstrap installs, managed runtimes). */
  resolveExecutable?(
    context: LaunchContext,
    registration: HarnessRegistration,
    options: ExecutableResolutionOptions,
  ): Promise<string>;
  /** Optional harness-specific version probe used by doctor. */
  probeVersion?(context: LaunchContext, executable: string): Promise<string | undefined>;
  /** Exact harness version for this launch; source development may override the embedded pin. */
  exactVersion?(context: LaunchContext): string;
  /** Oldest harness version the embedded resources are known to work with. */
  readonly minimumVersion?: string;
  prepare(context: HarnessLaunchContext, userArguments: readonly string[]): Promise<void>;
  buildLaunchSpec(
    context: HarnessLaunchContext,
    userArguments: readonly string[],
  ): Promise<LaunchSpec>;
  doctor(context: LaunchContext): Promise<readonly DoctorFinding[]>;
}

export interface HarnessRegistration {
  readonly id: StableHarnessId;
  readonly executableCandidates: readonly string[];
  readonly executableOverrideVariable: string;
}
