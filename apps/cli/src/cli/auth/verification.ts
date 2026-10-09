import { BUILD_INFO } from "../../build-info.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { emitProductEvent } from "../../telemetry/product-events.ts";

export type SessionVerificationStatus = "VERIFIED" | "NOT_VERIFIED" | "EXPIRED";

export async function verifyEncryptedSession(
  encryptedSession: string,
): Promise<SessionVerificationStatus> {
  const startedAt = Date.now();
  try {
    const response = await fetch(
      new URL("/api/v1/auth/verify-auth-token", BUILD_INFO.serviceOrigin),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${encryptedSession}` },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status === 401 || response.status === 403) {
      emitProductEvent({
        category: "auth",
        stage: "verify",
        outcome: "failed",
        reason: "invalid_session",
        durationMs: Date.now() - startedAt,
      });
      return "NOT_VERIFIED";
    }
    if (!response.ok) throw new Error("Verification service is unavailable");
    const payload: unknown = await response.json();
    const status = (payload as { status?: unknown } | null)?.status;
    if (status !== "VERIFIED" && status !== "NOT_VERIFIED" && status !== "EXPIRED") {
      throw new Error("Invalid verification response");
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
  } catch {
    emitProductEvent({
      category: "auth",
      stage: "verify",
      outcome: "failed",
      reason: "unavailable",
      durationMs: Date.now() - startedAt,
    });
    // An outage is not an invalid credential: do not ask users to log in repeatedly.
    throw new LauncherError(
      "Could not verify your Axon session",
      LAUNCHER_EXIT_STATUS.profileFailure,
      { remediation: "Check connectivity and the auth service, then retry." },
    );
  }
}
