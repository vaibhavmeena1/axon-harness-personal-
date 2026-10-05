import { z } from "zod";

export const MAX_RAW_BYTES = 100 * 1024 * 1024;
export const MAX_STORED_BYTES = 101 * 1024 * 1024;
export const MAX_DISPLAY_NAME_LENGTH = 256;

/** Display metadata only; never alter the native archive. */
export function normalizeDisplayName(name: string): string | null {
  const singleLine = name.replace(/[\p{Cc}\p{Cs}\u2028\u2029]/gu, " ").trim();
  let bounded = "";
  let length = 0;
  for (const character of singleLine) {
    if (length++ === MAX_DISPLAY_NAME_LENGTH) break;
    bounded += character;
  }
  return bounded.trimEnd() || null;
}

export const displayNameSchema = z
  .string()
  .refine((name) => normalizeDisplayName(name) === name)
  .nullable();
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const resumeSchema = z
  .strictObject({
    leaf_known: z.boolean(),
    selected_leaf_id: z.string().min(1).max(256).nullable(),
  })
  .refine((value) => value.leaf_known || value.selected_leaf_id === null);
export type PiResume = z.infer<typeof resumeSchema>;
export const snapshotSchema = z
  .strictObject({
    display_name: displayNameSchema,
    raw_sha256: hashSchema,
    stored_sha256: hashSchema,
    raw_size_bytes: z.number().int().positive().max(MAX_RAW_BYTES),
    stored_size_bytes: z.number().int().positive().max(MAX_STORED_BYTES),
    encoding: z.enum(["identity", "gzip"]),
    session_format_version: z.string().min(1).max(128),
    resume_metadata: z.record(z.string(), z.unknown()),
  })
  .refine(
    (s) =>
      JSON.stringify(s.resume_metadata).length <= 4096 &&
      (s.encoding !== "identity" ||
        (s.raw_sha256 === s.stored_sha256 && s.raw_size_bytes === s.stored_size_bytes)),
  );
export type Snapshot = z.infer<typeof snapshotSchema>;
export const sessionSchema = z.object({
  id: z.uuid(),
  display_name: displayNameSchema,
  harness: z.string(),
  harness_session_id: z.string().nullable(),
  session_format: z.string(),
  device_id: z.uuid(),
  client_session_key: z.uuid(),
  update_token: z.uuid(),
  last_backup_at: z.string().nullable(),
  updated_at: z.string(),
  snapshot: snapshotSchema.nullable(),
});
export type RemoteSession = z.infer<typeof sessionSchema>;
export const downloadSchema = z.object({
  session: sessionSchema,
  object_id: z.string().min(1).max(128),
  url: z.string(),
  expires_in: z.number(),
});
export const listSchema = z.object({
  sessions: z.array(sessionSchema),
  next: z.object({ before: z.string(), before_id: z.uuid() }).nullable(),
});
export type CaptureReason = "session_start" | "session_shutdown" | "manual";

export function assertPiAdapter(
  session: Pick<RemoteSession, "harness" | "session_format" | "snapshot">,
): PiResume {
  if (
    session.harness !== "pi" ||
    session.session_format !== "pi-jsonl" ||
    session.snapshot?.session_format_version !== "3"
  ) {
    throw new Error("Unsupported session harness, format or version");
  }
  return resumeSchema.parse(session.snapshot.resume_metadata);
}
