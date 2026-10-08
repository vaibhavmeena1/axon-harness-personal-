import { constants, createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { resumeSchema, type Snapshot } from "./contracts.ts";
import { assertInside } from "./files.ts";
import { validatePiJsonl } from "./pi-jsonl.ts";
import { verifyArchive } from "./restore.ts";

/** Recover display metadata from an immutable private copy, never the live session file. */
export async function recoverQueuedDisplayName(
  directory: string,
  file: string,
  snapshot: Snapshot,
  nativeId: string,
): Promise<string | null> {
  if (snapshot.session_format_version !== "3") throw new Error("Unsupported queued format");
  const resume = resumeSchema.parse(snapshot.resume_metadata);
  const source = join(directory, file);
  await assertInside(directory, source);
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let temporary: string | undefined;
  try {
    const info = await input.stat();
    if (!info.isFile() || info.size !== snapshot.stored_size_bytes) {
      throw new Error("Invalid queued archive");
    }
    temporary = await mkdtemp(join(directory, "metadata-repair-"));
    const stored = join(temporary, "payload");
    const raw = join(temporary, "original.jsonl");
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        callback(
          size > snapshot.stored_size_bytes ? new Error("Queued archive changed") : null,
          chunk,
        );
      },
    });
    await pipeline(
      input.createReadStream({ autoClose: false }),
      limit,
      createWriteStream(stored, { flags: "wx", mode: 0o600 }),
    );
    // Restore's verifier checks both hashes, declared sizes and bounded decompression.
    await verifyArchive(stored, raw, snapshot);
    const validated = await validatePiJsonl(raw, nativeId, resume);
    return validated.displayName;
  } finally {
    try {
      await input.close();
    } finally {
      if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
    }
  }
}
