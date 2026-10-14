import axonExtensionAsset from "../harnesses/pi/resources/extensions/axon.ts" with { type: "file" };
import compactionExtensionAsset from "../harnesses/pi/resources/extensions/compaction.ts" with {
  type: "file",
};
import gitAiExtensionAsset from "../harnesses/pi/resources/extensions/git-ai.ts" with {
  type: "file",
};
import managedConfigExtensionAsset from "../harnesses/pi/resources/extensions/managed-config.ts" with {
  type: "file",
};
import modelRecommenderExtensionAsset from "../harnesses/pi/resources/extensions/model-recommender.ts" with {
  type: "file",
};
import piOrgTelemetryExtensionAsset from "../harnesses/pi/resources/extensions/pi-org-telemetry.mjs" with {
  type: "file",
};
import sessionBackupExtensionAsset from "../harnesses/pi/resources/extensions/session-backup.mjs" with {
  type: "file",
};

import terminalPermissionsExtensionAsset from "../harnesses/pi/resources/extensions/terminal-permissions.ts" with {
  type: "file",
};
import webSearchExtensionAsset from "../harnesses/pi/resources/extensions/web-search.ts" with {
  type: "file",
};
import axonDarkThemeAsset from "../harnesses/pi/resources/themes/axon-dark.json" with {
  type: "file",
};
import axonLightThemeAsset from "../harnesses/pi/resources/themes/axon-light.json" with {
  type: "file",
};

import {
  type PiResourceManifestEntry,
  parseAxonManifest,
} from "../harnesses/pi/setup/packages/manifest.ts";

const GIT_AI_RESOURCE = Object.freeze({
  id: "git-ai",
  type: "extension",
  destination: "pi/extensions/git-ai.ts",
}) satisfies PiResourceManifestEntry;

const SESSION_BACKUP_RESOURCE = Object.freeze({
  id: "session-backup",
  type: "extension",
  destination: "pi/extensions/session-backup.mjs",
}) satisfies PiResourceManifestEntry;

const MANAGED_CONFIG_RESOURCE = Object.freeze({
  id: "managed-config",
  type: "extension",
  destination: "pi/extensions/managed-config.ts",
}) satisfies PiResourceManifestEntry;

const AXON_CORE_RESOURCE = Object.freeze({
  id: "axon-core",
  type: "extension",
  destination: "pi/extensions/axon.ts",
}) satisfies PiResourceManifestEntry;

const PI_ORG_TELEMETRY_RESOURCE = Object.freeze({
  id: "pi-org-telemetry",
  type: "extension",
  destination: "pi/extensions/pi-org-telemetry.mjs",
}) satisfies PiResourceManifestEntry;

const MODEL_RECOMMENDER_RESOURCE = Object.freeze({
  id: "model-recommender",
  type: "extension",
  destination: "pi/extensions/model-recommender.ts",
}) satisfies PiResourceManifestEntry;

const COMPACTION_RESOURCE = Object.freeze({
  id: "compaction",
  type: "extension",
  destination: "pi/extensions/compaction.ts",
}) satisfies PiResourceManifestEntry;

const WEB_SEARCH_RESOURCE = Object.freeze({
  id: "web-search",
  type: "extension",
  destination: "pi/extensions/web-search.ts",
}) satisfies PiResourceManifestEntry;

const TERMINAL_PERMISSIONS_RESOURCE = Object.freeze({
  id: "terminal-permissions",
  type: "extension",
  destination: "pi/extensions/terminal-permissions.ts",
}) satisfies PiResourceManifestEntry;
const AXON_DARK_THEME_RESOURCE = Object.freeze({
  id: "axon-dark-theme",
  type: "theme",
  destination: "pi/themes/axon-dark.json",
}) satisfies PiResourceManifestEntry;

const AXON_LIGHT_THEME_RESOURCE = Object.freeze({
  id: "axon-light-theme",
  type: "theme",
  destination: "pi/themes/axon-light.json",
}) satisfies PiResourceManifestEntry;

export const AXON_MANIFEST = parseAxonManifest({
  schemaVersion: 1,
  revision: "14",
  pi: {
    packages: [
      {
        id: "rpiv-ask-user-question",
        source: "npm:@juicesharp/rpiv-ask-user-question",
        required: true,
        versionPolicy: { kind: "exact", version: "2.12.0" },
        install: { action: "pi.install" },
      },
      {
        id: "pi-provider-litellm",
        source: "npm:pi-provider-litellm",
        required: true,
        versionPolicy: { kind: "exact", version: "4.2.0" },
        install: { action: "pi.install" },
      },
    ],
    resources: [
      MANAGED_CONFIG_RESOURCE,
      AXON_CORE_RESOURCE,
      MODEL_RECOMMENDER_RESOURCE,
      SESSION_BACKUP_RESOURCE,
      // Close telemetry after backup shutdown has emitted its final outcomes.
      PI_ORG_TELEMETRY_RESOURCE,
      WEB_SEARCH_RESOURCE,
      GIT_AI_RESOURCE,
      COMPACTION_RESOURCE,
      // Run permission checks after the other managed tool-call handlers.
      TERMINAL_PERMISSIONS_RESOURCE,
      AXON_DARK_THEME_RESOURCE,
      AXON_LIGHT_THEME_RESOURCE,
    ],
  },
});

export interface EmbeddedPiResource extends PiResourceManifestEntry {
  readonly sourcePath: string;
}

export const EMBEDDED_PI_RESOURCES = Object.freeze([
  Object.freeze({
    ...MANAGED_CONFIG_RESOURCE,
    sourcePath: managedConfigExtensionAsset as unknown as string,
  }),
  Object.freeze({
    ...AXON_CORE_RESOURCE,
    // TypeScript resolves the source module while Bun's `file` loader returns its asset path.
    sourcePath: axonExtensionAsset as unknown as string,
  }),
  Object.freeze({
    ...PI_ORG_TELEMETRY_RESOURCE,
    sourcePath: piOrgTelemetryExtensionAsset as unknown as string,
  }),
  Object.freeze({
    ...MODEL_RECOMMENDER_RESOURCE,
    sourcePath: modelRecommenderExtensionAsset as unknown as string,
  }),
  Object.freeze({
    ...SESSION_BACKUP_RESOURCE,
    sourcePath: sessionBackupExtensionAsset as unknown as string,
  }),
  Object.freeze({
    ...WEB_SEARCH_RESOURCE,
    sourcePath: webSearchExtensionAsset as unknown as string,
  }),
  Object.freeze({
    ...GIT_AI_RESOURCE,
    sourcePath: gitAiExtensionAsset as unknown as string,
  }),
  Object.freeze({
    ...COMPACTION_RESOURCE,
    sourcePath: compactionExtensionAsset as unknown as string,
  }),
  Object.freeze({
    ...TERMINAL_PERMISSIONS_RESOURCE,
    sourcePath: terminalPermissionsExtensionAsset as unknown as string,
  }),
  Object.freeze({
    ...AXON_DARK_THEME_RESOURCE,
    sourcePath: axonDarkThemeAsset as unknown as string,
  }),
  Object.freeze({
    ...AXON_LIGHT_THEME_RESOURCE,
    sourcePath: axonLightThemeAsset as unknown as string,
  }),
] as const satisfies readonly EmbeddedPiResource[]);
