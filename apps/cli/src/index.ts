#!/usr/bin/env bun

import { dispatch } from "./cli/dispatch.ts";
import { isPiOffline } from "./harnesses/pi/setup/packages/invocation.ts";
import { bootstrapCertificates } from "./launcher/certificates.ts";
import { isTrue } from "./launcher/debug-preview.ts";
import { LauncherError } from "./launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "./launcher/exit-status.ts";
import { PRODUCT_IDENTITY } from "./product/identity.ts";
import { resolveAxonPaths } from "./product/paths.ts";
import { beginProductTelemetryInvocation, flushProductTelemetry } from "./telemetry/client.ts";

const DEBUG_ENVIRONMENT_VARIABLE = "AXON_DEBUG";

function printUnexpectedError(error: unknown): void {
  console.error(`${PRODUCT_IDENTITY.command}: unexpected launcher failure`);
  if (isTrue(process.env[DEBUG_ENVIRONMENT_VARIABLE])) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  } else {
    console.error(`Rerun with AXON_DEBUG=1 for diagnostic details.`);
  }
}

export async function main(
  argumentsVector: readonly string[] = process.argv.slice(2),
): Promise<void> {
  try {
    await bootstrapCertificates(argumentsVector);
    beginProductTelemetryInvocation();
    await dispatch(argumentsVector);
  } catch (error) {
    if (error instanceof LauncherError) {
      console.error(`${PRODUCT_IDENTITY.command}: ${error.message}`);
      if (error.remediation !== undefined) {
        console.error(`Remediation: ${error.remediation}`);
      }
      if (isTrue(process.env[DEBUG_ENVIRONMENT_VARIABLE]) && error.cause !== undefined) {
        console.error(error.cause);
      }
      process.exitCode = error.exitStatus;
      return;
    }

    printUnexpectedError(error);
    process.exitCode = LAUNCHER_EXIT_STATUS.profileFailure;
  } finally {
    await flushProductTelemetry(resolveAxonPaths(), isPiOffline(process.env, argumentsVector));
  }
}

if (import.meta.main) {
  await main();
}
