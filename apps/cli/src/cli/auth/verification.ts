import { BUILD_INFO } from "../../build-info.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../../product/endpoints.ts";
import type { AxonPaths } from "../../product/paths.ts";
import { emitProductEvent } from "../../telemetry/product-events.ts";
import { isEncryptedSession, loadEncryptedSession, refreshEncryptedSession } from "./session.ts";

export type SessionVerificationStatus = "VERIFIED" | "NOT_VERIFIED" | "EXPIRED";

/** Supplying paths opts into refresh and saves rotations before accepting the session. */
export async function verifyEncryptedSession(
  encryptedSession: string,
  paths?: AxonPaths,
): Promise<SessionVerificationStatus> {
  const startedAt = Date.now();
  try {
    // A concurrent login/refresh must be verified, never overwritten or treated as expired.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(
        resolveServiceUrl(
          BUILD_INFO.serviceOrigin,
          SERVICE_ENDPOINTS.auth.verifyToken,
          paths ? { refresh_expired: true } : undefined,
        ),
        {
          method: "POST",
          headers: { Authorization: `Bearer ${encryptedSession}` },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        },
      );
      let status: SessionVerificationStatus;
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        status = "NOT_VERIFIED";
      } else {
        if (!response.ok) throw new Error("Verification service is unavailable");
        const payload: unknown = await response.json();
        const value = (payload as { status?: unknown } | null)?.status;
        if (value !== "VERIFIED" && value !== "NOT_VERIFIED" && value !== "EXPIRED") {
          throw new Error("Invalid verification response");
        }
        status = value;
      }

      if (paths) {
        const refreshedSession = response.headers.get("x-session-refresh-token");
        if (refreshedSession !== null) {
          if (status !== "VERIFIED" || !isEncryptedSession(refreshedSession)) {
            throw new Error("Invalid session refresh response");
          }
          let saved: boolean;
          try {
            saved = await refreshEncryptedSession(paths, encryptedSession, refreshedSession);
          } catch {
            emitProductEvent({
              category: "auth",
              stage: "refresh",
              outcome: "failed",
              reason: "rotation_failed",
            });
            throw new LauncherError(
              "Your refreshed Axon session could not be saved safely",
              LAUNCHER_EXIT_STATUS.profileFailure,
              { remediation: "Check permissions on the shared authentication file, then retry." },
            );
          }
          emitProductEvent({
            category: "auth",
            stage: "refresh",
            outcome: saved ? "success" : "skipped",
            ...(saved ? {} : { reason: "conflict" }),
          });
          if (saved) encryptedSession = refreshedSession;
        }
        const currentSession = await loadEncryptedSession(paths);
        if (currentSession !== encryptedSession) {
          if (currentSession === undefined)
            throw new Error("Saved session changed during verification");
          encryptedSession = currentSession;
          continue;
        }
      }

      emitProductEvent({
        category: "auth",
        stage: "verify",
        outcome: status === "VERIFIED" ? "success" : "failed",
        ...(status === "VERIFIED"
          ? {}
          : { reason: status === "EXPIRED" ? "expired" : "invalid_session" }),
        durationMs: Date.now() - startedAt,
      });
      return status;
    }
    throw new Error("Saved session kept changing during verification");
  } catch (error) {
    emitProductEvent({
      category: "auth",
      stage: "verify",
      outcome: "failed",
      reason: "unavailable",
      durationMs: Date.now() - startedAt,
    });
    if (error instanceof LauncherError) throw error;
    // An outage is not an invalid credential: do not ask users to log in repeatedly.
    throw new LauncherError(
      "Could not verify your Axon session",
      LAUNCHER_EXIT_STATUS.profileFailure,
      { remediation: "Check connectivity and the auth service, then retry." },
    );
  }
}
