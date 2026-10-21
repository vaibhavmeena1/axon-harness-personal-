import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { loadEncryptedSession } from "../cli/auth/session.ts";
import { withFileLock } from "../launcher/file-lock.ts";
import { SERVICE_ENDPOINTS } from "../product/endpoints.ts";
import type { AxonPaths } from "../product/paths.ts";
import {
  emitProductEvent,
  observeProductEvent,
  type ProductEvent,
  type ProductEventObserver,
  productFailureReason,
} from "../telemetry/product-events.ts";
import { type BackupApi, BackupApiError, storageUrl } from "./api.ts";
import {
  type CaptureReason,
  MAX_STORED_BYTES,
  type PiResume,
  type Snapshot,
  sessionSchema,
  snapshotSchema,
} from "./contracts.ts";
import { assertInside, atomicJson, fileIntegrity, privateDirectory, readJson } from "./files.ts";
import { capturePiSession } from "./pi-jsonl.ts";
import { recoverQueuedDisplayName } from "./queue-metadata.ts";

export const BACKUP_PRIVACY_NOTICE =
  "Session names or first-message excerpts are stored separately as private listing metadata. Session backups include the complete transcript: source code, pasted secrets, terminal output, prompts, tool arguments/results, thinking and embedded images. They do not back up your checkout or external files. Only the latest committed checkpoint is recoverable. Pending-only snapshots can be lost with this machine. Previously issued signed URLs remain valid for up to five minutes after deletion.";
export class BackupLocalSettingsError extends Error {
  constructor() {
    super(
      "Local backup settings are invalid, unsafe or unreadable; existing snapshots were retained",
    );
  }
}

export class BackupPolicyError extends Error {
  constructor(reason: "account changed" | "backend origin changed") {
    super(`Backup paused: ${reason}`);
  }
}

const QUEUE_PAUSED =
  "Backup paused: local queue is incompatible, corrupt, unsafe or busy; files retained. Run /axon-backups status";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
// Local state binds queues to an account; it cannot enable or disable backups.
const settingsSchema = z.object({
  owner: z.string().regex(/^[1-9][0-9]*$/),
  origin: z.string(),
  credentialHash: z.string().length(64),
});
const queuedSchema = z.strictObject({
  file: z.string().regex(/^[a-f0-9-]+\.jsonl\.gz$/),
  snapshot: snapshotSchema,
  requestId: z.uuid(),
  expectedToken: z.uuid().optional(),
});
const streamSchema = z.strictObject({
  clientKey: z.uuid(),
  deviceId: z.uuid(),
  nativeId: z.string().min(1).max(256),
  owner: z.string(),
  origin: z.string(),
  remoteId: z.uuid().optional(),
  token: z.uuid().optional(),
  lastCommitted: z.string().optional(),
  lastDigest: z.string().optional(),
  pending: queuedSchema.optional(),
  next: queuedSchema.optional(),
  error: z.string().optional(),
});
type StreamState = z.infer<typeof streamSchema>;
const uploadSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("upload_required"),
    upload: z.object({ url: z.string(), headers: z.record(z.string(), z.string()) }),
  }),
  z.object({ status: z.enum(["committed", "already_current"]), session: sessionSchema }),
]);

function contentKey(snapshot: Snapshot): string {
  return digest(
    JSON.stringify([
      snapshot.display_name,
      snapshot.raw_sha256,
      snapshot.raw_size_bytes,
      snapshot.session_format_version,
      snapshot.resume_metadata,
    ]),
  );
}

export class SessionBackups {
  readonly root: string;
  constructor(
    readonly paths: AxonPaths,
    readonly api: BackupApi,
    private readonly observer: ProductEventObserver = emitProductEvent,
  ) {
    // Separate ID domains: never interpret an old membership queue as a user queue,
    // even when the numeric IDs happen to be identical. Old files remain untouched.
    this.root = join(paths.home, "session-backups", "users");
  }

  private observed(event: Omit<ProductEvent, "category">): void {
    observeProductEvent(this.observer, { category: "backup", ...event });
  }

  async initialize(): Promise<void> {
    await privateDirectory(this.paths.home);
    await privateDirectory(join(this.paths.home, "session-backups"));
    await privateDirectory(this.root);
  }

  async settings() {
    try {
      await this.initialize();
      const raw = await readJson(join(this.root, "settings.json"));
      return raw === undefined ? undefined : settingsSchema.parse(raw);
    } catch {
      throw new BackupLocalSettingsError();
    }
  }

  /** Caller holds sync.lock; only an unsubmitted next snapshot may change declarations. */
  private async readStreamState(
    directory: string,
    owner: string,
  ): Promise<StreamState | undefined> {
    const path = join(directory, "state.json");
    const saved = await readJson(path);
    if (saved === undefined) return undefined;
    await assertInside(this.root, path);
    const current = streamSchema.safeParse(saved);
    if (current.success) {
      this.assertScope(current.data, owner);
      return current.data;
    }
    if (
      !isObject(saved) ||
      !isObject(saved["next"]) ||
      !isObject(saved["next"]["snapshot"]) ||
      Object.hasOwn(saved["next"]["snapshot"], "display_name") ||
      Object.hasOwn(saved["next"], "expectedToken")
    ) {
      throw new Error("Incompatible local backup queue");
    }
    // Validate every other field first, including any pending request. Never rewrite a
    // pending declaration: it may already have reached the server under its request ID.
    const state = streamSchema.parse({
      ...saved,
      next: { ...saved["next"], snapshot: { ...saved["next"]["snapshot"], display_name: null } },
    });
    this.assertScope(state, owner);
    const next = state.next;
    if (!next) throw new Error("Missing queued snapshot");
    try {
      next.snapshot.display_name = await recoverQueuedDisplayName(
        directory,
        next.file,
        next.snapshot,
        state.nativeId,
      );
      await atomicJson(path, state);
    } catch {
      throw new Error("Could not safely repair local backup metadata");
    }
    return state;
  }

  async prepare(signal?: AbortSignal) {
    const policy = await this.api.policy(signal);
    if (!policy.enabled) return undefined;
    await this.initialize();
    return withFileLock(join(this.root, "settings.lock"), async () => {
      const existing = await this.settings();
      if (existing) {
        if (existing.origin !== this.api.origin)
          throw new BackupPolicyError("backend origin changed");
        if (existing.owner !== policy.owner_user_id) throw new BackupPolicyError("account changed");
        return existing; // Never move a queue to another account/origin.
      }
      const binding = {
        owner: policy.owner_user_id,
        origin: this.api.origin,
        credentialHash: this.api.credentialFingerprint(),
      };
      await atomicJson(join(this.root, "settings.json"), binding);
      return binding;
    });
  }

  private async rememberCredential(owner: string): Promise<void> {
    await withFileLock(join(this.root, "settings.lock"), async () => {
      const settings = await this.settings();
      if (settings && settings.owner === owner && settings.origin === this.api.origin) {
        await atomicJson(join(this.root, "settings.json"), {
          ...settings,
          credentialHash: this.api.credentialFingerprint(),
        });
      }
    });
  }

  async retry(): Promise<number> {
    const settings = await this.prepare();
    if (!settings || settings.origin !== this.api.origin)
      throw new Error("Verify the original backup account before retrying");
    const scope = this.scope(settings.owner);
    await privateDirectory(scope);
    let skipped = 0;
    for (const entry of await readdir(scope, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const directory = join(scope, entry.name);
      try {
        await assertInside(this.root, join(directory, "state.json"));
        await withFileLock(
          join(directory, "sync.lock"),
          async () => {
            const state = await this.readStreamState(directory, settings.owner);
            if (!state) return;
            delete state.error;
            await atomicJson(join(directory, "state.json"), state);
          },
          { timeoutMs: 100 },
        );
      } catch (error) {
        // Unrecoverable streams remain untouched/paused; do not prevent healthy retries.
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) skipped++;
      }
    }
    return skipped;
  }

  async recordLeaf(source: string | undefined, nativeId: string, resume: PiResume): Promise<void> {
    const settings = await this.settings();
    const token = await loadEncryptedSession(this.paths);
    if (
      !source ||
      !settings ||
      settings.origin !== this.api.origin ||
      !token ||
      digest(token) !== settings.credentialHash
    )
      return;
    const scope = this.scope(settings.owner);
    await privateDirectory(scope);
    const directory = join(scope, digest(`${source}\n${nativeId}`));
    await privateDirectory(directory);
    await atomicJson(join(directory, "selected-leaf.json"), resume);
  }

  private scope(owner: string): string {
    return join(this.root, digest(`${this.api.origin}\n${owner}`));
  }

  async device(): Promise<string> {
    await this.initialize();
    return withFileLock(join(this.root, "device.lock"), async () => {
      const saved = await readJson(join(this.root, "device.json"));
      if (saved !== undefined) return z.object({ id: z.uuid() }).parse(saved).id;
      const id = crypto.randomUUID();
      await atomicJson(join(this.root, "device.json"), { id });
      return id;
    });
  }

  /** Capture while the lifecycle context is valid; this method only retains plain data. */
  async boundary(
    source: string | undefined,
    nativeId: string,
    resume: PiResume,
    reason: CaptureReason,
    cancellation?: AbortSignal,
  ): Promise<string> {
    const deadline = AbortSignal.timeout(15_000);
    const signal = cancellation ? AbortSignal.any([deadline, cancellation]) : deadline;
    if (!(await loadEncryptedSession(this.paths))) {
      this.observed({ stage: "capture", outcome: "skipped", reason: "login_required" });
      return "Backup paused: login required";
    }
    let settings: z.infer<typeof settingsSchema> | undefined;
    try {
      settings = await this.prepare(signal);
    } catch (error) {
      if (error instanceof BackupLocalSettingsError) throw error;
      if (error instanceof BackupPolicyError) return error.message;
      this.observed({ stage: "capture", outcome: "skipped", reason: productFailureReason(error) });
      return "Backup paused: backend policy unavailable; existing snapshots retained";
    }
    if (!settings) {
      this.observed({ stage: "capture", outcome: "skipped", reason: "policy_disabled" });
      return "Backups disabled by administrator";
    }
    if (settings.origin !== this.api.origin) {
      this.observed({ stage: "capture", outcome: "skipped", reason: "origin_changed" });
      return "Backup paused: backend origin changed";
    }
    const token = await loadEncryptedSession(this.paths);
    if (!token) {
      this.observed({ stage: "capture", outcome: "skipped", reason: "login_required" });
      return "Backup paused: login required";
    }
    // Login may change after policy verification but before local capture starts.
    if (digest(token) !== this.api.credentialFingerprint()) return "Backup paused: account changed";
    if (digest(token) !== settings.credentialHash) await this.rememberCredential(settings.owner);
    const scope = this.scope(settings.owner);
    await privateDirectory(scope);
    let message = "No persisted session to back up";
    if (!source) this.observed({ stage: "capture", outcome: "skipped", reason: "no_session" });
    if (source) {
      const directory = join(scope, digest(`${source}\n${nativeId}`));
      await privateDirectory(directory);
      message = await withFileLock(
        join(directory, "sync.lock"),
        async () => {
          const path = join(directory, "state.json");
          let saved: StreamState | undefined;
          try {
            saved = await this.readStreamState(directory, settings.owner);
          } catch {
            this.observed({ stage: "capture", outcome: "failed", reason: "validation" });
            return QUEUE_PAUSED;
          }
          const state: StreamState = saved ?? {
            clientKey: crypto.randomUUID(),
            deviceId: await this.device(),
            nativeId,
            owner: settings.owner,
            origin: settings.origin,
          };
          let capture: Awaited<ReturnType<typeof capturePiSession>>;
          const captureStartedAt = Date.now();
          try {
            capture = await capturePiSession(
              this.paths.piSessions,
              source,
              directory,
              nativeId,
              resume,
            );
          } catch (error) {
            this.observed({
              stage: "capture",
              outcome: "failed",
              reason: "validation",
              durationMs: Date.now() - captureStartedAt,
            });
            const transient =
              error instanceof Error && /Incomplete|changed while/.test(error.message);
            if (!transient)
              state.error = "capture invalid, oversized or unsafe; repair it and explicitly retry";
            await atomicJson(path, state);
            return transient
              ? "Incomplete or changing checkpoint; retry at the next boundary (not backed up yet)"
              : `Backup paused: ${state.error}`;
          }
          if (capture) {
            this.observed({
              stage: "capture",
              outcome: "success",
              bytes: capture.snapshot.raw_size_bytes,
              durationMs: Date.now() - captureStartedAt,
            });
            const key = contentKey(capture.snapshot);
            if (
              key === state.lastDigest ||
              (state.pending && key === contentKey(state.pending.snapshot)) ||
              (state.next && key === contentKey(state.next.snapshot))
            ) {
              await rm(capture.file, { force: true });
            } else {
              const previous = state.next;
              state.next = {
                file: basename(capture.file),
                snapshot: capture.snapshot,
                requestId: crypto.randomUUID(),
              };
              // Commit new immutable queue pointer before removing superseded local data.
              await atomicJson(path, state);
              if (previous) await rm(join(directory, previous.file), { force: true });
            }
            await rm(capture.rawFile, { force: true });
          }
          await atomicJson(path, state);
          return this.sync(directory, state, reason, signal);
        },
        { timeoutMs: 100 },
      );
    }
    if (reason !== "session_shutdown" && !signal.aborted)
      await this.retryOthers(scope, settings.owner, signal);
    return message;
  }

  private assertScope(state: StreamState, owner: string): void {
    if (state.owner !== owner || state.origin !== this.api.origin)
      throw new Error("Pending snapshot belongs to a different account or backend");
  }

  private async register(state: StreamState, signal: AbortSignal) {
    const remote = sessionSchema.parse(
      await this.api.request(
        SERVICE_ENDPOINTS.sessions.base,
        "POST",
        {
          client_session_key: state.clientKey,
          device_id: state.deviceId,
          harness: "pi",
          harness_session_id: state.nativeId,
          session_format: "pi-jsonl",
        },
        signal,
      ),
    );
    state.remoteId = remote.id;
    return remote;
  }

  private async sync(
    directory: string,
    state: StreamState,
    reason: CaptureReason,
    signal: AbortSignal,
  ): Promise<string> {
    const path = join(directory, "state.json");
    const commitStartedAt = Date.now();
    if (state.error) return `Backup paused: ${state.error}`;
    if (!state.pending && !state.next)
      return state.lastCommitted
        ? `Backup confirmed ${state.lastCommitted}`
        : "No session content to back up";
    try {
      if ((await this.api.owner(signal)) !== state.owner) return "Backup paused: account changed";
      await this.rememberCredential(state.owner);
      const binding = await this.settings();
      if (!binding || binding.owner !== state.owner || binding.origin !== this.api.origin)
        return "Backup paused: account binding changed";
      const remote = await this.register(state, signal);
      if (!state.pending) {
        if (state.token && state.token !== remote.update_token) throw new BackupApiError(409);
        state.token = remote.update_token;
        state.pending = state.next;
        delete state.next;
        if (state.pending) state.pending.expectedToken = state.token;
        await atomicJson(path, state);
      }
      const pending = state.pending;
      if (!pending) return "No pending snapshot";
      if (!pending.expectedToken) {
        pending.expectedToken = remote.update_token;
        await atomicJson(path, state);
      }
      const request = {
        request_id: pending.requestId,
        expected_token: pending.expectedToken,
        snapshot: pending.snapshot,
        capture_reason: reason,
      };
      let response: z.infer<typeof uploadSchema>;
      try {
        response = uploadSchema.parse(
          await this.api.request(this.api.endpoint("upload", remote.id), "POST", request, signal),
        );
      } catch (error) {
        if (!(error instanceof BackupApiError) || error.status !== 409) throw error;
        // Lost commit response or expired reservation: explicitly reconcile before a new UUID.
        const latest = await this.register(state, signal);
        if (latest.snapshot && contentKey(latest.snapshot) === contentKey(pending.snapshot)) {
          response = { status: "already_current" as const, session: latest };
        } else if (latest.update_token === pending.expectedToken) {
          // Reservation may still be live: do not discard it on an ambiguous conflict.
          try {
            response = uploadSchema.parse(
              await this.api.request(
                this.api.endpoint("finalize", remote.id),
                "POST",
                { request_id: pending.requestId },
                signal,
              ),
            );
          } catch (finalError) {
            if (!(finalError instanceof BackupApiError) || finalError.status !== 409)
              throw finalError;
            pending.requestId = crypto.randomUUID();
            await atomicJson(path, state);
            return "Reservation expired; reconciled snapshot will retry at the next boundary";
          }
        } else throw error;
      }
      if (response.status === "upload_required") {
        const integrity = await fileIntegrity(join(directory, pending.file), MAX_STORED_BYTES);
        if (
          integrity.hash !== pending.snapshot.stored_sha256 ||
          integrity.size !== pending.snapshot.stored_size_bytes
        )
          throw new BackupApiError(422);
        if (
          Object.keys(response.upload.headers).some(
            (name) => name.toLowerCase() === "authorization",
          ) ||
          response.upload.headers["If-None-Match"] !== "*"
        )
          throw new Error("Invalid create-only storage headers");
        const currentBinding = await this.settings();
        if (
          !currentBinding ||
          currentBinding.owner !== state.owner ||
          currentBinding.origin !== this.api.origin
        )
          return "Backup paused: account binding changed";
        // Recheck administrator policy and ownership immediately before object transfer.
        if ((await this.api.owner(signal)) !== state.owner) return "Backup paused: account changed";
        await this.rememberCredential(state.owner);
        const credential = await loadEncryptedSession(this.paths);
        if (!credential || digest(credential) !== this.api.credentialFingerprint())
          throw new Error("Account changed before upload; snapshot remains paused");
        const bytes = createReadStream(join(directory, pending.file));
        let put: Response;
        const uploadStartedAt = Date.now();
        try {
          put = await this.api.fetcher(storageUrl(response.upload.url), {
            method: "PUT",
            headers: response.upload.headers,
            redirect: "error",
            signal,
            body: Readable.toWeb(bytes) as ReadableStream<Uint8Array>,
            duplex: "half",
          } as RequestInit);
          this.observed({
            stage: "upload",
            outcome: put.ok || put.status === 412 ? "success" : "failed",
            bytes: integrity.size,
            durationMs: Date.now() - uploadStartedAt,
            ...(put.ok || put.status === 412
              ? {}
              : { reason: put.status >= 500 ? "http_5xx" : "http_4xx" }),
          });
        } catch (error) {
          this.observed({
            stage: "upload",
            outcome: signal.aborted ? "cancelled" : "failed",
            reason: signal.aborted ? "cancelled" : productFailureReason(error),
            durationMs: Date.now() - uploadStartedAt,
          });
          throw error;
        } finally {
          bytes.destroy();
        }
        await put.body?.cancel();
        if (!put.ok && put.status !== 412)
          throw new Error("Object upload failed; snapshot remains pending");
        response = uploadSchema.parse(
          await this.api.request(
            this.api.endpoint("finalize", remote.id),
            "POST",
            { request_id: pending.requestId },
            signal,
          ),
        );
      }
      if (response.status === "upload_required") throw new Error("Backup was not committed");
      state.token = response.session.update_token;
      state.lastCommitted = response.session.last_backup_at ?? undefined;
      state.lastDigest = contentKey(pending.snapshot);
      delete state.pending;
      await atomicJson(path, state);
      await rm(join(directory, pending.file), { force: true });
      this.observed({
        stage: "commit",
        outcome: "success",
        bytes: pending.snapshot.stored_size_bytes,
        durationMs: Date.now() - commitStartedAt,
      });
      // Do not block Pi on a second full upload. The coalesced latest snapshot retries next time.
      return state.next ? "Backup committed; newer checkpoint pending" : "Backup committed";
    } catch (error) {
      this.observed({
        stage: "commit",
        outcome:
          error instanceof BackupApiError && [401, 403, 409, 422].includes(error.status)
            ? "failed"
            : signal.aborted
              ? "cancelled"
              : "pending",
        reason: signal.aborted ? "cancelled" : productFailureReason(error),
        durationMs: Date.now() - commitStartedAt,
      });
      if (error instanceof BackupApiError && [401, 403, 409, 422].includes(error.status)) {
        state.error =
          error.status === 409
            ? "remote stream changed; create a local fork"
            : `access or validation failure (HTTP ${error.status}); review before retrying`;
      }
      await atomicJson(path, state);
      return state.error
        ? `Backup paused: ${state.error}`
        : "Snapshot pending (offline, unavailable or timed out); not backed up yet";
    }
  }

  private async retryOthers(scope: string, owner: string, signal: AbortSignal): Promise<void> {
    for (const entry of await readdir(scope, { withFileTypes: true })) {
      if (signal.aborted) break;
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const directory = join(scope, entry.name);
      try {
        await assertInside(this.root, join(directory, "state.json"));
        await withFileLock(
          join(directory, "sync.lock"),
          async () => {
            const state = await this.readStreamState(directory, owner);
            if (!state) return;
            await this.sync(directory, state, "session_start", signal);
          },
          { timeoutMs: 100 },
        );
      } catch {
        /* Startup reconciliation is best-effort, never a Pi turn error. */
      }
    }
  }

  async status(): Promise<string> {
    const settings = await this.prepare();
    if (!settings) return "Backups disabled by administrator";
    if (settings.origin !== this.api.origin) return "Backup paused: backend origin changed";
    const scope = this.scope(settings.owner);
    let pending = 0;
    let paused = 0;
    let latest = "none";
    let issues = 0;
    try {
      const scopeInfo = await lstat(scope);
      if (!scopeInfo.isDirectory() || scopeInfo.isSymbolicLink())
        throw new BackupLocalSettingsError();
      for (const entry of await readdir(scope, { withFileTypes: true })) {
        if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const directory = join(scope, entry.name);
        try {
          // Check parents before creating a lock, so a symlink cannot redirect writes.
          await assertInside(this.root, join(directory, "state.json"));
          const state = await withFileLock(
            join(directory, "sync.lock"),
            () => this.readStreamState(directory, settings.owner),
            { timeoutMs: 100 },
          );
          if (!state) continue;
          if (state.pending || state.next) pending++;
          if (state.error) paused++;
          if (state.lastCommitted && (latest === "none" || state.lastCommitted > latest))
            latest = state.lastCommitted;
        } catch (error) {
          // Leaf-only directories have no queue yet. Other failures pause only that stream.
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          paused++;
          issues++;
        }
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new BackupLocalSettingsError();
      }
    }
    return (
      `Backups enabled; last confirmed: ${latest}; pending streams: ${pending}; paused: ${paused}` +
      (issues
        ? `; local queue issues: ${issues} (incompatible, corrupt, unsafe or busy; files retained)`
        : "")
    );
  }
}
