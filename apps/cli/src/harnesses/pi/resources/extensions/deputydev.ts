import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "deputydev-status";

export default function deputyDevExtension(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { message?: unknown };
    const message = typeof data.message === "string" ? data.message : "DeputyDev is active";
    return new Text(theme.fg("accent", message), 1, 0);
  });

  pi.registerCommand("deputydev-status", {
    description: "Show the active DeputyDev integration status",
    handler: async () => {
      pi.appendEntry(ENTRY_TYPE, {
        message: "DeputyDev-managed Pi resources are active",
      });
    },
  });
}
