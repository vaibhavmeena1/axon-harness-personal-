import compactionExtensionAsset from "../harnesses/pi/resources/extensions/compaction.ts" with {
  type: "file",
};
import deputyDevExtensionAsset from "../harnesses/pi/resources/extensions/deputydev.ts" with {
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

import webSearchExtensionAsset from "../harnesses/pi/resources/extensions/web-search.ts" with {
  type: "file",
};

import {
  type PiResourceManifestEntry,
  parseDeputyDevManifest,
} from "../harnesses/pi/setup/packages/manifest.ts";

const SESSION_BACKUP_RESOURCE = Object.freeze({
  id: "session-backup",
  type: "extension",
  destination: "pi/extensions/session-backup.mjs",
}) satisfies PiResourceManifestEntry;

const DEPUTYDEV_CORE_RESOURCE = Object.freeze({
  id: "deputydev-core",
  type: "extension",
  destination: "pi/extensions/deputydev.ts",
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

export const DEPUTYDEV_MANIFEST = parseDeputyDevManifest({
  schemaVersion: 1,
  revision: "9",
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
        versionPolicy: { kind: "exact", version: "4.1.0" },
        install: { action: "pi.install" },
      },
    ],
    resources: [
      DEPUTYDEV_CORE_RESOURCE,
      MODEL_RECOMMENDER_RESOURCE,
      SESSION_BACKUP_RESOURCE,
      // Close telemetry after backup shutdown has emitted its final outcomes.
      PI_ORG_TELEMETRY_RESOURCE,
      WEB_SEARCH_RESOURCE,
      COMPACTION_RESOURCE,
    ],
  },
});

export interface EmbeddedPiResource extends PiResourceManifestEntry {
  readonly sourcePath: string;
}

export const EMBEDDED_PI_RESOURCES = Object.freeze([
  Object.freeze({
    ...DEPUTYDEV_CORE_RESOURCE,
    // TypeScript resolves the source module while Bun's `file` loader returns its asset path.
    sourcePath: deputyDevExtensionAsset as unknown as string,
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
    ...COMPACTION_RESOURCE,
    sourcePath: compactionExtensionAsset as unknown as string,
  }),
] as const satisfies readonly EmbeddedPiResource[]);
