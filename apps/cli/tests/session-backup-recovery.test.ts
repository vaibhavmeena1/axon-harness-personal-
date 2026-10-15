import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { saveEncryptedSession } from "../src/cli/auth/session.ts";
import sessionBackupExtension, { backupWarning } from "../src/harnesses/pi/session-backup/index.ts";
import { withFileLock } from "../src/launcher/file-lock.ts";
import { type AxonPaths, resolveAxonPaths } from "../src/product/paths.ts";
import { BackupApi, BackupApiError } from "../src/sessions/api.ts";
import { BackupLocalSettingsError, SessionBackups } from "../src/sessions/backup.ts";
import { atomicJson, privateDirectory } from "../src/sessions/files.ts";

const origin = "https://backend.example.test";
const nativeId = "synthetic-recovery-session";
const timestamp = "2026-01-01T00:00:00.000Z";
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
let root: string;
let paths: AxonPaths;
let backups: SessionBackups;
let scope: string;
let calls: string[];
let policyEnabled: boolean;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dd-backup-recovery-"));
  paths = resolveAxonPaths({ AXON_HOME: root, HOME: root });
  await saveEncryptedSession(paths, "synthetic-token");
  calls = [];
  policyEnabled = true;
  const fetcher = (async (input: string | URL | Request) => {
    calls.push(new URL(String(input)).pathname);
    return Response.json({ enabled: policyEnabled, owner_user_team_id: "1" });
  }) as typeof fetch;
  backups = new SessionBackups(paths, new BackupApi(paths, origin, fetcher), () => {});
  await atomicJson(join(backups.root, "settings.json"), {
    enabled: true,
    owner: "1",
    origin,
    credentialHash: digest("synthetic-token"),
  });
  scope = join(backups.root, digest(`${origin}\n1`));
  await privateDirectory(scope);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function queue(names: readonly string[] = ["Archive title"]) {
  const directory = join(scope, digest(crypto.randomUUID()));
  await privateDirectory(directory);
  const bytes = Buffer.from(
    `${[
      { type: "session", version: 3, id: nativeId, timestamp, cwd: "/synthetic" },
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp,
        message: { role: "user", content: "synthetic", timestamp: 1 },
      },
      ...names.map((name, i) => ({
        type: "session_info",
        id: `name-${i}`,
        parentId: "user",
        timestamp,
        name,
      })),
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
  const compressed = gzipSync(bytes);
  const file = `${crypto.randomUUID()}.jsonl.gz`;
  await writeFile(join(directory, file), compressed, { mode: 0o600 });
  // This is the old unsubmitted declaration, intentionally missing display_name.
  const state = {
    clientKey: crypto.randomUUID(),
    deviceId: crypto.randomUUID(),
    nativeId,
    owner: "1",
    origin,
    next: {
      file,
      requestId: crypto.randomUUID(),
      snapshot: {
        raw_sha256: digest(bytes),
        stored_sha256: digest(compressed),
        raw_size_bytes: bytes.length,
        stored_size_bytes: compressed.length,
        encoding: "gzip",
        session_format_version: "3",
        resume_metadata: { leaf_known: true, selected_leaf_id: "user" },
      },
    },
  };
  const path = join(directory, "state.json");
  await atomicJson(path, state);
  return { directory, path, state, bytes, compressed, file: join(directory, file) };
}

async function expectUntouched(item: Awaited<ReturnType<typeof queue>>, content: string) {
  expect(await readFile(item.path, "utf8")).toBe(content);
  expect(await readFile(item.file)).toEqual(item.compressed);
  expect((await readdir(item.directory)).sort()).toEqual(
    [item.state.next.file, "state.json"].sort(),
  );
}

describe("local backup queue recovery", () => {
  test.each([
    { names: ["Old", "  Last\nname  "], expected: "Last name" },
    { names: [], expected: "synthetic" },
    { names: ["Old", ""], expected: "synthetic" },
  ])(
    "status repairs unsubmitted metadata from exact archived bytes: %j",
    async ({ names, expected }) => {
      const item = await queue(names);
      const status = await backups.status();
      expect(status).toContain("pending streams: 1; paused: 0");
      expect(status).not.toContain("local queue issues");
      const repaired = JSON.parse(await readFile(item.path, "utf8"));
      expect(repaired).toEqual({
        ...item.state,
        next: {
          ...item.state.next,
          snapshot: { ...item.state.next.snapshot, display_name: expected },
        },
      });
      expect(await readFile(item.file)).toEqual(item.compressed);
      expect(calls.every((path) => path === "/api/v1/sessions/status")).toBe(true); // Policy checks only; no uploads.
      const content = await readFile(item.path, "utf8");
      await backups.status();
      await expectUntouched(item, content);
    },
  );

  test("one corrupt stream does not hide healthy pending or confirmed backup status", async () => {
    const healthy = await queue();
    await atomicJson(healthy.path, {
      ...healthy.state,
      next: {
        ...healthy.state.next,
        snapshot: { ...healthy.state.next.snapshot, display_name: "Archive title" },
      },
      lastCommitted: timestamp,
    });
    const broken = await queue();
    await writeFile(broken.path, "{malformed-private-data");
    const status = await backups.status();
    expect(status).toContain(`last confirmed: ${timestamp}`);
    expect(status).toContain("pending streams: 1; paused: 1; local queue issues: 1");
    expect(status).not.toContain("malformed-private-data");
    await expectUntouched(broken, "{malformed-private-data");
    expect(calls.every((path) => path === "/api/v1/sessions/status")).toBe(true); // Policy checks only; no uploads.
  });

  test("does not rewrite uncertain pending declarations or already-tokened next requests", async () => {
    for (const kind of ["pending", "tokened-next"] as const) {
      const item = await queue();
      const queued = { ...item.state.next, expectedToken: crypto.randomUUID() };
      const { next: _next, ...base } = item.state;
      await atomicJson(item.path, { ...base, [kind === "pending" ? "pending" : "next"]: queued });
      const content = await readFile(item.path, "utf8");
      expect(await backups.status()).toContain("local queue issues:");
      await expectUntouched(item, content);
    }
    expect(calls.every((path) => path === "/api/v1/sessions/status")).toBe(true); // Policy checks only; no uploads.
  });

  test.each([
    "stored-hash",
    "raw-hash",
    "identity",
    "leaf",
    "version",
    "decompression-limit",
    "other-field",
  ])("failed verification leaves queue and payload untouched: %s", async (failure) => {
    const item = await queue();
    if (failure === "stored-hash") item.state.next.snapshot.stored_sha256 = "0".repeat(64);
    if (failure === "raw-hash") item.state.next.snapshot.raw_sha256 = "0".repeat(64);
    if (failure === "identity") item.state.nativeId = "different-session";
    if (failure === "leaf") item.state.next.snapshot.resume_metadata.selected_leaf_id = "unknown";
    if (failure === "version") item.state.next.snapshot.session_format_version = "4";
    if (failure === "decompression-limit") item.state.next.snapshot.raw_size_bytes = 1;
    if (failure === "other-field") Reflect.deleteProperty(item.state.next.snapshot, "raw_sha256");
    await atomicJson(item.path, item.state);
    const content = await readFile(item.path, "utf8");
    expect(await backups.status()).toContain("paused: 1; local queue issues: 1");
    await expectUntouched(item, content);
    expect(calls.every((path) => path === "/api/v1/sessions/status")).toBe(true); // Policy checks only; no uploads.
  });

  test("missing or symlinked archives remain paused without losing pointers or touching targets", async () => {
    const item = await queue();
    await rm(item.file);
    const content = await readFile(item.path, "utf8");
    expect(await backups.status()).toContain("local queue issues: 1");
    expect(await readFile(item.path, "utf8")).toBe(content);
    const target = join(root, "external-payload");
    await writeFile(target, item.compressed);
    await symlink(target, item.file);
    expect(await backups.status()).toContain("local queue issues: 1");
    expect(await readFile(target)).toEqual(item.compressed);
    await expectUntouched(item, content);
  });

  test("owner/origin mismatch and symlinked queue directories never get repaired", async () => {
    for (const field of ["owner", "origin"] as const) {
      const item = await queue();
      item.state[field] = "different";
      await atomicJson(item.path, item.state);
      const content = await readFile(item.path, "utf8");
      expect(await backups.status()).toContain("local queue issues:");
      await expectUntouched(item, content);
    }
    const item = await queue();
    const target = join(root, "external-stream");
    await mkdir(target);
    await writeFile(join(target, "state.json"), JSON.stringify(item.state));
    const linked = join(scope, digest("symlinked-queue"));
    await symlink(target, linked);
    expect(await backups.status()).toContain("local queue issues: 3");
    expect(await readdir(target)).toEqual(["state.json"]);
    expect(calls.every((path) => path === "/api/v1/sessions/status")).toBe(true); // Policy checks only; no uploads.
  });

  test("busy queues are reported, and retry repairs only compatible streams", async () => {
    const item = await queue();
    const content = await readFile(item.path, "utf8");
    await withFileLock(join(item.directory, "sync.lock"), async () => {
      expect(await backups.status()).toContain("local queue issues: 1");
      expect(await readFile(item.path, "utf8")).toBe(content);
    });
    const bad = await queue();
    await writeFile(bad.path, "{corrupt");
    expect(await backups.retry()).toBe(1);
    expect(JSON.parse(await readFile(item.path, "utf8")).next.snapshot.display_name).toBe(
      "Archive title",
    );
    await expectUntouched(bad, "{corrupt");
    expect(calls).toEqual(["/api/v1/sessions/status", "/api/v1/sessions/status"]);
  });

  test("leaf-only directories are not errors and disabled backups do not migrate queues", async () => {
    const leafOnly = join(scope, digest("leaf-only"));
    await privateDirectory(leafOnly);
    await atomicJson(join(leafOnly, "selected-leaf.json"), {
      leaf_known: true,
      selected_leaf_id: "user",
    });
    expect(await backups.status()).toContain("pending streams: 0; paused: 0");
    const item = await queue();
    const content = await readFile(item.path, "utf8");
    policyEnabled = false;
    expect(await backups.status()).toContain("disabled");
    await expectUntouched(item, content);
  });

  test("lifecycle retry repairs an older queued snapshot without capturing or uploading live content", async () => {
    const item = await queue();
    // The fixture backend rejects registration: repaired content must stay queued, not be lost.
    expect(
      await backups.boundary(
        undefined,
        nativeId,
        { leaf_known: false, selected_leaf_id: null },
        "session_start",
      ),
    ).toContain("No persisted session");
    const state = JSON.parse(await readFile(item.path, "utf8"));
    expect(state.next.snapshot.display_name).toBe("Archive title");
    expect(await readFile(item.file)).toEqual(item.compressed);
    expect(calls).toEqual([
      "/api/v1/sessions/status",
      "/api/v1/sessions/status",
      "/api/v1/sessions",
    ]);
  });
});

describe("backup diagnostics", () => {
  test("local settings failures and backend auth/storage failures have distinct safe messages", async () => {
    await writeFile(join(backups.root, "settings.json"), "{private-invalid-settings");
    await expect(backups.status()).rejects.toBeInstanceOf(BackupLocalSettingsError);
    expect(backupWarning(new BackupLocalSettingsError())).toContain("Local backup settings");
    expect(backupWarning(new BackupApiError(401))).toContain("login required");
    expect(backupWarning(new BackupApiError(403))).toContain("access denied");
    expect(backupWarning(new BackupApiError(503))).toContain("service is disabled or unavailable");
    expect(backupWarning(new Error("private-name /private/path secret-token"))).not.toMatch(
      /private-name|private\/path|secret-token/,
    );
  });

  test("slash status reports a local queue warning rather than blaming login/storage", async () => {
    const item = await queue();
    await writeFile(item.path, "{broken");
    const oldOrigin = process.env["PI_AXON_BACKUP_SERVICE_ORIGIN"];
    const oldHome = process.env["PI_AXON_BACKUP_HOME"];
    const oldUserHome = process.env["HOME"];
    process.env["HOME"] = root;
    process.env["PI_AXON_BACKUP_SERVICE_ORIGIN"] = origin;
    process.env["PI_AXON_BACKUP_HOME"] = root;
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (
      _input: string | URL | Request,
    ) => Response.json({ enabled: true, owner_user_team_id: "1" })) as typeof fetch);
    const notices: { message: string; level: string }[] = [];
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    try {
      sessionBackupExtension({
        events: { emit: () => {} },
        on: () => {},
        registerCommand: (name: string, command: { handler: typeof handler }) => {
          if (name === "axon-backups") handler = command.handler;
        },
      } as unknown as ExtensionAPI);
      if (!handler) throw new Error("Missing backup command");
      await handler("status", {
        hasUI: true,
        ui: {
          notify: (message: string, level: string) => notices.push({ message, level }),
          setStatus: () => {},
        },
      } as unknown as ExtensionCommandContext);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.level).toBe("warning");
      expect(notices[0]?.message).toContain("local queue issues: 1");
      expect(notices[0]?.message).not.toContain("check login");
      expect(calls.every((path) => path === "/api/v1/sessions/status")).toBe(true); // Policy checks only; no uploads.
    } finally {
      fetcher.mockRestore();
      if (oldUserHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = oldUserHome;
      if (oldOrigin === undefined) delete process.env["PI_AXON_BACKUP_SERVICE_ORIGIN"];
      else process.env["PI_AXON_BACKUP_SERVICE_ORIGIN"] = oldOrigin;
      if (oldHome === undefined) delete process.env["PI_AXON_BACKUP_HOME"];
      else process.env["PI_AXON_BACKUP_HOME"] = oldHome;
    }
  });

  test("generated native extension repairs the same queue during slash status", async () => {
    const item = await queue();
    const bundle = resolve(
      import.meta.dir,
      "../src/harnesses/pi/resources/extensions/session-backup.mjs",
    );
    const script = `
      globalThis.fetch = async () => Response.json({ enabled: true, owner_user_team_id: "1" });
      const { default: factory } = await import(${JSON.stringify(bundle)});
      const commands = new Map(); const notices = [];
      factory({ on() {}, events: { emit() {} }, registerCommand(name, command) { commands.set(name, command); } });
      await commands.get("axon-backups").handler("status", { hasUI: true, ui: { notify(message, level) { notices.push({ message, level }); }, setStatus() {} } });
      console.log(JSON.stringify(notices));
    `;
    const child = Bun.spawn(["node", "--input-type=module", "-e", script], {
      env: {
        ...process.env,
        HOME: root,
        PI_AXON_BACKUP_SERVICE_ORIGIN: origin,
        PI_AXON_BACKUP_HOME: root,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)[0]).toEqual({
      message: "Backups enabled; last confirmed: none; pending streams: 1; paused: 0",
      level: "info",
    });
    expect(JSON.parse(await readFile(item.path, "utf8")).next.snapshot.display_name).toBe(
      "Archive title",
    );
    expect(await readFile(item.file)).toEqual(item.compressed);
  });
});
