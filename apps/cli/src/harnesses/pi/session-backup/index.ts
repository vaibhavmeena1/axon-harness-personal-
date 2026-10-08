import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveDeputyDevPaths } from "../../../product/paths.ts";
import { BackupApi, BackupApiError } from "../../../sessions/api.ts";
import {
  BACKUP_PRIVACY_NOTICE,
  BackupLocalSettingsError,
  SessionBackups,
} from "../../../sessions/backup.ts";
import type { CaptureReason } from "../../../sessions/contracts.ts";
import { PRODUCT_EVENT_CHANNEL } from "../../../telemetry/product-events.ts";

export function backupWarning(error: unknown): string {
  if (error instanceof BackupLocalSettingsError) return error.message;
  if (error instanceof BackupApiError) {
    if (error.status === 401) return "Backup login required; sign in to DeputyDev and retry";
    if (error.status === 403)
      return "Backup access denied; verify the signed-in account and permissions";
    if (error.status === 503)
      return "Backup service is disabled or unavailable; check backend private storage configuration";
    return `Backup service returned HTTP ${error.status}; retry later. Existing snapshots were retained`;
  }
  // Unknown errors can contain private names, paths or credentials; never display their text.
  return "Backup action failed; check connectivity and retry. Existing snapshots were retained";
}

export default function sessionBackupExtension(pi: ExtensionAPI): void {
  const origin = process.env["PI_DEPUTYDEV_BACKUP_SERVICE_ORIGIN"];
  const home = process.env["PI_DEPUTYDEV_BACKUP_HOME"];
  if (!origin || !home) return; // Managed launches supply both values, not ambient overrides.
  const paths = resolveDeputyDevPaths({ DEPUTYDEV_HOME: home });
  const backups = new SessionBackups(paths, new BackupApi(paths, origin), (event) =>
    pi.events.emit(PRODUCT_EVENT_CHANNEL, event),
  );
  let work: Promise<unknown> = Promise.resolve();
  const requests = new Set<AbortController>();
  let lastStatus = "Backups disabled (opt-in required)";

  function capture(ctx: ExtensionContext, reason: CaptureReason): Promise<unknown> {
    // Capture all context-bound values synchronously. Background work never retains ctx.
    const path = ctx.sessionManager.getSessionFile();
    const id = ctx.sessionManager.getSessionId();
    const leaf = ctx.sessionManager.getLeafId();
    const resume = { leaf_known: true, selected_leaf_id: leaf };
    // Shutdown must not wait out an older startup transfer before staging its outgoing checkpoint.
    if (reason === "session_shutdown") for (const request of requests) request.abort();
    const cancellation = new AbortController();
    requests.add(cancellation);
    work = work
      .catch(() => undefined)
      .then(async () => {
        try {
          lastStatus = await backups.boundary(path, id, resume, reason, cancellation.signal);
        } catch {
          try {
            pi.events.emit(PRODUCT_EVENT_CHANNEL, {
              category: "backup",
              stage: "capture",
              outcome: "failed",
              reason: "unsafe_storage",
            });
          } catch {
            /* Best effort. */
          }
          lastStatus =
            "Backup capture failed (invalid, oversized, unsafe or busy); Pi remains usable";
        } finally {
          requests.delete(cancellation);
        }
      });
    return work;
  }

  pi.on("session_start", (_event, ctx) => {
    // No awaited large transfer at startup; private staging and requests are best-effort.
    void capture(ctx, "session_start");
    if (ctx.hasUI)
      ctx.ui.setStatus("deputydev-backup", "Session backups: /deputydev-backups status");
  });
  pi.on("session_shutdown", (_event, ctx) =>
    capture(ctx, "session_shutdown").then(() => undefined),
  );
  pi.on("session_tree", (_event, ctx) => {
    // Persist only tiny local selection metadata; no transcript capture or network request.
    const path = ctx.sessionManager.getSessionFile();
    const id = ctx.sessionManager.getSessionId();
    const leaf = ctx.sessionManager.getLeafId();
    return backups
      .recordLeaf(path, id, { leaf_known: true, selected_leaf_id: leaf })
      .catch(() => undefined);
  });

  pi.registerCommand("deputydev-backup-now", {
    description: "Capture this managed session and attempt a committed backup",
    handler: async (_args, ctx) => {
      await capture(ctx, "manual");
      if (ctx.hasUI) {
        ctx.ui.notify(lastStatus, lastStatus.startsWith("Backup committed") ? "info" : "warning");
        ctx.ui.setStatus("deputydev-backup", lastStatus);
      }
    },
  });
  pi.registerCommand("deputydev-backups", {
    description:
      "Session backup consent, pause/disable and status (enable | disable | retry | status)",
    handler: async (args, ctx) => {
      try {
        if (args.trim() === "enable") {
          if (
            !ctx.hasUI ||
            !(await ctx.ui.confirm("Enable sensitive session backups?", BACKUP_PRIVACY_NOTICE))
          )
            return;
          await backups.enable();
        } else if (["disable", "pause"].includes(args.trim())) await backups.disable();
        else if (args.trim() === "retry") await backups.retry();
        lastStatus = await backups.status();
        if (ctx.hasUI) {
          ctx.ui.notify(
            lastStatus,
            lastStatus.includes("local queue issues:") ? "warning" : "info",
          );
          ctx.ui.setStatus("deputydev-backup", lastStatus);
        }
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(backupWarning(error), "warning");
      }
    },
  });
}
