import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { z } from "zod";

import {
  MAX_RAW_BYTES,
  MAX_STORED_BYTES,
  normalizeDisplayName,
  type PiResume,
  resumeSchema,
  type Snapshot,
} from "./contracts.ts";
import { assertInside, fileIntegrity, syncDirectory } from "./files.ts";

const headerSchema = z.object({
  type: z.literal("session"),
  version: z.literal(3),
  id: z.string().min(1).max(256),
  cwd: z.string(),
  timestamp: z.string(),
});
const entrySchema = z
  .object({
    type: z.enum([
      "message",
      "model_change",
      "thinking_level_change",
      "compaction",
      "branch_summary",
      "custom",
      "custom_message",
      "label",
      "session_info",
      "context_edit",
      "usage",
    ]),
    id: z.string().min(1).max(256),
    parentId: z.string().nullable(),
    timestamp: z.string(),
  })
  .passthrough();

function validateEntryPayload(entry: Record<string, unknown>): void {
  const fields: Record<string, readonly string[]> = {
    custom: ["customType"],
    custom_message: ["customType"],
    model_change: ["provider", "modelId"],
    thinking_level_change: ["thinkingLevel"],
    branch_summary: ["fromId", "summary"],
    session_info: ["name"],
    usage: ["kind", "provider", "model"],
    context_edit: ["targetId"],
    label: ["targetId"],
  };
  if ((fields[String(entry["type"])] ?? []).some((field) => typeof entry[field] !== "string"))
    throw new Error("Invalid Pi entry payload");
  if (entry["type"] !== "message") return;
  const message = entry["message"] as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object" || typeof message["role"] !== "string")
    throw new Error("Invalid Pi message");
  const content = message["content"];
  if (
    ["user", "system", "custom"].includes(message["role"]) &&
    typeof content !== "string" &&
    !Array.isArray(content)
  )
    throw new Error("Invalid Pi message content");
  if (["assistant", "toolResult"].includes(message["role"]) && !Array.isArray(content))
    throw new Error("Invalid Pi message content");
}

/** JSONL separates records with LF, not Unicode separators inside JSON strings. */
async function* jsonlLines(input: AsyncIterable<Buffer>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  function decode(chunk?: Buffer): string {
    try {
      return decoder.decode(chunk, { stream: chunk !== undefined });
    } catch {
      throw new Error("Invalid UTF-8 session archive");
    }
  }
  for await (const chunk of input) {
    const parts = decode(chunk).split("\n");
    for (let i = 0; i < parts.length; i++) {
      fragments.push(parts[i] ?? "");
      if (i < parts.length - 1) {
        yield fragments.join("");
        fragments.length = 0;
      }
    }
  }
  fragments.push(decode());
  const tail = fragments.join("");
  if (tail) yield tail;
}

export async function validatePiJsonl(
  path: string,
  nativeId: string | null,
  resume: PiResume,
): Promise<{ nativeId: string; entries: number; displayName: string | null }> {
  resumeSchema.parse(resume);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RAW_BYTES || info.size === 0)
    throw new Error("Invalid or oversized Pi archive");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, info.size - 1);
    if (last[0] !== 10)
      throw new Error("Incomplete JSONL checkpoint; retry after writing finishes");
  } finally {
    await handle.close();
  }
  let displayName: string | null = null;
  const ids = new Set<string>();
  const refs: string[] = [];
  let header: z.infer<typeof headerSchema> | undefined;
  const streamHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stream = streamHandle.createReadStream({ autoClose: false });
  const lines = jsonlLines(stream);
  try {
    for await (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error("Malformed Pi JSONL record");
      }
      if (!header) {
        const result = headerSchema.safeParse(parsed);
        if (!result.success || (nativeId !== null && result.data.id !== nativeId))
          throw new Error("Invalid Pi header or session identity");
        header = result.data;
        continue;
      }
      const result = entrySchema.safeParse(parsed);
      if (!result.success) throw new Error("Invalid Pi session entry");
      const entry = result.data;
      if (ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId)))
        throw new Error("Invalid Pi session tree");
      validateEntryPayload(entry);
      if (entry.type === "session_info")
        displayName = normalizeDisplayName(entry["name"] as string);
      if (entry.type === "compaction") {
        if (typeof entry["firstKeptEntryId"] !== "string" || typeof entry["summary"] !== "string")
          throw new Error("Invalid Pi compaction");
        refs.push(entry["firstKeptEntryId"]);
      }
      ids.add(entry.id);
    }
  } finally {
    stream.destroy();
    await streamHandle.close();
  }
  if (!header || !ids.size || refs.some((id) => !ids.has(id)))
    throw new Error("Empty or invalid Pi session");
  if (resume.leaf_known && resume.selected_leaf_id !== null && !ids.has(resume.selected_leaf_id))
    throw new Error("Selected leaf is absent from captured tree");
  return { nativeId: header.id, entries: ids.size, displayName };
}

export interface CapturedSnapshot {
  file: string;
  rawFile: string;
  snapshot: Snapshot;
  nativeId: string;
}

/** Immutable observed-boundary copy. Never reserialize transcript entries. */
export async function capturePiSession(
  root: string,
  source: string,
  directory: string,
  nativeId: string,
  resume: PiResume,
): Promise<CapturedSnapshot | undefined> {
  try {
    await assertInside(root, source);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const rawFile = join(directory, `${crypto.randomUUID()}.jsonl`);
    const file = `${rawFile}.gz`;
    let keep = false;
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await input.stat();
      if (!before.isFile() || before.size > MAX_RAW_BYTES)
        throw new Error("Session exceeds 100 MiB or is not a regular file");
      const output = await open(rawFile, "wx", 0o600);
      try {
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (offset < before.size) {
          const { bytesRead } = await input.read(
            buffer,
            0,
            Math.min(buffer.length, before.size - offset),
            offset,
          );
          if (!bytesRead) break;
          await output.write(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
        await output.sync();
      } finally {
        await output.close();
      }
      const after = await input.stat();
      const named = await lstat(source);
      if (
        before.ino !== named.ino ||
        before.dev !== named.dev ||
        named.isSymbolicLink() ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        continue;
      // Header-only persisted sessions do not need backups.
      const previewStream = createReadStream(rawFile);
      const preview = jsonlLines(previewStream);
      let count = 0;
      try {
        for await (const _line of preview) {
          if (++count > 1) break;
        }
      } finally {
        previewStream.destroy();
      }
      if (count < 2) return undefined;
      const validated = await validatePiJsonl(rawFile, nativeId, resume);
      const raw = await fileIntegrity(rawFile, MAX_RAW_BYTES);
      await pipeline(
        createReadStream(rawFile),
        createGzip(),
        createWriteStream(file, { flags: "wx", mode: 0o600 }),
      );
      const compressed = await fileIntegrity(file, MAX_STORED_BYTES);
      const stored = await open(file, "r");
      try {
        await stored.sync();
      } finally {
        await stored.close();
      }
      await syncDirectory(directory);
      keep = true;
      return {
        file,
        rawFile,
        nativeId,
        snapshot: {
          display_name: validated.displayName,
          raw_sha256: raw.hash,
          raw_size_bytes: raw.size,
          stored_sha256: compressed.hash,
          stored_size_bytes: compressed.size,
          encoding: "gzip",
          session_format_version: "3",
          resume_metadata: resume,
        },
      };
    } finally {
      await input.close();
      if (!keep) {
        await rm(rawFile, { force: true });
        await rm(file, { force: true });
      }
    }
  }
  throw new Error("Session changed while capturing; retry at the next lifecycle boundary");
}
