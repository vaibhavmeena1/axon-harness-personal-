import type { DoctorFinding, LaunchContext } from "../../../../launcher/contracts.ts";
import { PRODUCT_IDENTITY } from "../../../../product/identity.ts";
import { AXON_MANIFEST } from "../../../../product/manifest.ts";
import { inspectInstalledPackage } from "./inspect.ts";
import { type AxonManifest, normalizePiPackage } from "./manifest.ts";
import { findPackageSetting, piSettingsPath, readPiSettings } from "./settings.ts";
import { readPiPackageState } from "./state.ts";
import { canUseExactFallback } from "./sync.ts";

export async function inspectPiPackages(
  context: LaunchContext,
  manifest: AxonManifest = AXON_MANIFEST,
): Promise<readonly DoctorFinding[]> {
  const packages = manifest.pi.packages.map(normalizePiPackage);
  if (packages.length === 0) {
    return [{ level: "info", message: "pi: no required community packages configured" }];
  }

  try {
    const [settings, state] = await Promise.all([
      readPiSettings(piSettingsPath(context.paths.pi)),
      readPiPackageState(context.paths.piPackageState),
    ]);
    const findings: DoctorFinding[] = [];

    for (const packageEntry of packages) {
      const inspection = await inspectInstalledPackage(packageEntry, context.paths.pi);
      const setting = findPackageSetting(settings, packageEntry.identity);
      if (inspection.satisfiesPolicy && setting === packageEntry.configuredSource) {
        const installed = inspection.installedVersion ?? inspection.installedCommit ?? "verified";
        findings.push({
          level: "info",
          message: `pi package ${packageEntry.id}: ${installed} (${packageEntry.versionPolicy.kind})`,
        });
        continue;
      }

      // The same rule the launcher applies: only a verified, non-revoked exact
      // version recorded by Axon may keep running in place of the policy version.
      const fallbackMatches = canUseExactFallback(
        packageEntry,
        inspection,
        state.packages[packageEntry.identity],
      );
      findings.push({
        level: fallbackMatches ? "warning" : "error",
        message: `pi package ${packageEntry.id}: ${
          fallbackMatches
            ? `using last verified version ${inspection.installedVersion ?? inspection.installedCommit}`
            : (inspection.reason ?? "settings repair required")
        }`,
        remediation: `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages.`,
      });
    }

    return findings;
  } catch (error) {
    return [
      {
        level: "error",
        message: `pi package diagnostics failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        remediation: `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages.`,
      },
    ];
  }
}
