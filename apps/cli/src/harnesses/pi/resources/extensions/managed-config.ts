import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REFRESH_TIMEOUT_MS = 2500;
const WARNING = "Axon could not refresh Pi defaults; keeping the current settings.";

/** Refresh before Pi rereads settings and reruns provider factories, not after session_start. */
export default function managedConfig(pi: ExtensionAPI): void {
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "reload" || process.env["PI_AXON_CONFIG_REFRESH_ENABLED"] !== "true")
      return;
    const origin = process.env["PI_AXON_AUTH_RELAY_URL"];
    const capability = process.env["PI_AXON_AUTH_RELAY_KEY"];
    if (!origin || !capability) return;
    try {
      const url = new URL(origin);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.pathname !== "/" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid managed relay origin");
      const response = await fetch(new URL("/_axon/pi-defaults/refresh", url), {
        method: "POST",
        headers: { authorization: `Bearer ${capability}` },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("Managed config refresh failed");
    } catch {
      // Never log the response, credential, upstream error, or request URL.
      if (ctx.hasUI) ctx.ui.notify(WARNING, "warning");
      else process.stderr.write(`${WARNING}\n`);
    }
  });
}
