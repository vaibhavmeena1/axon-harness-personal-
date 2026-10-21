import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { BUILD_INFO } from "../src/build-info.ts";
import { saveEncryptedSession } from "../src/cli/auth/session.ts";
import { runSessions } from "../src/cli/commands/sessions.ts";
import { createPiEnvironment } from "../src/harnesses/pi/environment.ts";
import sessionBackupExtension from "../src/harnesses/pi/session-backup/index.ts";
import { createHarnessEnvironment } from "../src/launcher/environment.ts";
import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../src/product/endpoints.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";
import { BackupApi } from "../src/sessions/api.ts";
import { SessionBackups } from "../src/sessions/backup.ts";
import {
  assertPiAdapter,
  MAX_RAW_BYTES,
  MAX_STORED_BYTES,
  normalizeDisplayName,
  type RemoteSession,
  type Snapshot,
  snapshotSchema,
} from "../src/sessions/contracts.ts";
import { privateDirectory } from "../src/sessions/files.ts";
import { capturePiSession, validatePiJsonl } from "../src/sessions/pi-jsonl.ts";
import { forkArchive, restoreSession, verifyArchive } from "../src/sessions/restore.ts";

const nativeId = "opaque/native-session";
const timestamp = "2026-01-01T00:00:00.000Z";
const entries: SessionEntry[] = [
  {
    type: "message",
    id: "a",
    parentId: null,
    timestamp,
    message: {
      role: "user",
      content: [
        { type: "text", text: "/historical/path" },
        { type: "image", data: "c3ludGhldGlj", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
  },
  {
    type: "model_change",
    id: "b",
    parentId: "a",
    timestamp,
    provider: "synthetic",
    modelId: "old-model",
  },
  {
    type: "message",
    id: "c",
    parentId: "b",
    timestamp,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "synthetic", thinkingSignature: "opaque-signature" },
        { type: "text", text: "synthetic", textSignature: "opaque" },
      ],
      provider: "synthetic",
      model: "old-model",
      api: "anthropic-messages",
      stopReason: "stop",
      timestamp: 2,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  },
  {
    type: "compaction",
    id: "d",
    parentId: "c",
    timestamp,
    summary: "synthetic",
    firstKeptEntryId: "c",
    tokensBefore: 100,
  },
  {
    type: "custom",
    id: "e",
    parentId: "a",
    timestamp,
    customType: "opaque-extension",
    data: { arbitrary: [1, 2, "opaque"] },
  },
];
const raw = Buffer.from(
  `${[{ type: "session", version: 3, id: nativeId, timestamp, cwd: "/old/os-user/checkout" }, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
);
const resume = { leaf_known: true, selected_leaf_id: "a" };
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const snapshot = (bytes = raw): Snapshot => ({
  display_name: null,
  raw_sha256: hash(bytes),
  stored_sha256: hash(bytes),
  raw_size_bytes: bytes.length,
  stored_size_bytes: bytes.length,
  encoding: "identity",
  session_format_version: "3",
  resume_metadata: resume,
});
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "dd-session-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function remote(): RemoteSession {
  return {
    id: crypto.randomUUID(),
    display_name: null,
    harness: "pi",
    harness_session_id: nativeId,
    session_format: "pi-jsonl",
    device_id: crypto.randomUUID(),
    client_session_key: crypto.randomUUID(),
    update_token: crypto.randomUUID(),
    last_backup_at: timestamp,
    updated_at: timestamp,
    snapshot: snapshot(),
  };
}

async function source() {
  const paths = resolveAxonPaths({ AXON_HOME: directory, HOME: directory });
  await privateDirectory(paths.pi);
  await privateDirectory(paths.piSessions);
  const file = join(paths.piSessions, "synthetic.jsonl");
  await writeFile(file, raw, { mode: 0o600 });
  return { paths, file };
}

function namedRaw(names: readonly string[]) {
  return Buffer.concat([
    raw,
    Buffer.from(
      `${names
        .map((name, i) =>
          JSON.stringify({
            type: "session_info",
            id: `name-${i}`,
            parentId: "a",
            timestamp,
            name,
          }),
        )
        .join("\n")}${names.length ? "\n" : ""}`,
    ),
  ]);
}

describe("Pi archive and pinned native restore", () => {
  test.each([
    { names: [], expected: "/historical/path" },
    { names: ["Original", "Renamed"], expected: "Renamed" },
    { names: ["Original", ""], expected: "/historical/path" },
    { names: [" \t\n\u00a0\ufeff"], expected: "/historical/path" },
    { names: ["  fix\nlogin\tflow\u2028now\x1b  "], expected: "fix login flow now" },
    { names: ["😀".repeat(257)], expected: "😀".repeat(256) },
    { names: [`${"x".repeat(255)} \nignored`], expected: "x".repeat(255) },
    { names: ["\ud800Title\udfff"], expected: "Title" },
  ])(
    "captures latest native display name without rewriting archive: %j",
    async ({ names, expected }) => {
      const { paths, file } = await source();
      const bytes = namedRaw(names);
      await writeFile(file, bytes);
      const captured = await capturePiSession(paths.piSessions, file, directory, nativeId, resume);
      if (!captured) throw new Error("Missing captured session");
      expect(captured.snapshot.display_name).toBe(expected);
      expect(await readFile(captured.rawFile)).toEqual(bytes);
      expect(await readFile(file)).toEqual(bytes);
      const latestName = names.at(-1);
      if (latestName !== undefined)
        expect(normalizeDisplayName(latestName) ?? "/historical/path").toBe(expected);
      expect(snapshotSchema.safeParse(captured.snapshot).success).toBe(true);
    },
  );
  test.each([
    { content: "  Fix\nlogin\tflow  ", expected: "Fix login flow" },
    {
      content: [
        { type: "text", text: "Fix" },
        { type: "image", data: "synthetic", mimeType: "image/png" },
        { type: "text", text: "login flow" },
      ],
      expected: "Fix login flow",
    },
    { content: [{ type: "image", data: "synthetic", mimeType: "image/png" }], expected: null },
    {
      content: [null, { type: "text", text: 123 }, { type: "image", text: "ignore" }],
      expected: null,
    },
    { content: " \t\n\ufeff", expected: null },
    { content: "😀".repeat(257), expected: "😀".repeat(256) },
  ])("first-user-message fallback is bounded and stable: %j", async ({ content, expected }) => {
    const { file } = await source();
    const records = [
      { type: "session", version: 3, id: nativeId, timestamp, cwd: "/synthetic" },
      ...["system", "assistant", "toolResult"].map((role, i) => ({
        type: "message",
        id: `skip-${i}`,
        parentId: null,
        timestamp,
        message: { role, content: [{ type: "text", text: "Not the title" }] },
      })),
      { type: "message", id: "a", parentId: null, timestamp, message: { role: "user", content } },
    ];
    const bytes = Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await writeFile(file, bytes);
    expect((await validatePiJsonl(file, nativeId, resume)).displayName).toBe(expected);
    const later = [
      {
        type: "context_edit",
        id: "edit",
        parentId: "a",
        timestamp,
        targetId: "a",
        replacement: { content: "Changed context" },
      },
      {
        type: "message",
        id: "branch",
        parentId: null,
        timestamp,
        message: { role: "user", content: "Later prompt" },
      },
    ];
    await writeFile(
      file,
      Buffer.concat([
        bytes,
        Buffer.from(`${later.map((record) => JSON.stringify(record)).join("\n")}\n`),
      ]),
    );
    expect((await validatePiJsonl(file, nativeId, resume)).displayName).toBe(
      expected ?? "Later prompt",
    );
  });
  test("first-message titles restore without adding an explicit native name", async () => {
    const { paths, file } = await source();
    const checkout = join(directory, "checkout");
    await mkdir(checkout);
    const session = remote();
    session.display_name = "/historical/path";
    session.snapshot = { ...snapshot(), display_name: session.display_name };
    const fork = await forkArchive(file, checkout, paths.piSessions, session, SessionManager);
    expect(SessionManager.open(fork).getSessionName()).toBeUndefined();
    expect(await readFile(file)).toEqual(raw);
  });
  test("display names are required, bounded and normalized", () => {
    const { display_name: _name, ...missing } = snapshot();
    expect(snapshotSchema.safeParse(missing).success).toBe(false);
    for (const display_name of ["", "x".repeat(257), " title ", "bad\nname", 123])
      expect(snapshotSchema.safeParse({ ...snapshot(), display_name }).success).toBe(false);
  });
  test("named restore preserves native names and rejects mismatched metadata", async () => {
    const { paths, file } = await source();
    const bytes = namedRaw(["Original", "Renamed"]);
    await writeFile(file, bytes);
    const checkout = join(directory, "checkout");
    await mkdir(checkout);
    const session = remote();
    session.display_name = "Renamed";
    session.snapshot = { ...snapshot(bytes), display_name: "Renamed" };
    const fork = await forkArchive(file, checkout, paths.piSessions, session, SessionManager);
    expect(SessionManager.open(fork).getSessionName()).toBe("Renamed");
    session.display_name = "Forged";
    await expect(
      forkArchive(file, checkout, paths.piSessions, session, SessionManager),
    ).rejects.toThrow("Display name");
    session.display_name = "Renamed";
    session.snapshot.display_name = "Forged";
    await expect(
      forkArchive(file, checkout, paths.piSessions, session, SessionManager),
    ).rejects.toThrow("Display name");
    expect(await readFile(file)).toEqual(bytes);
  });
  test("captures original bytes, branches, signatures and media with private permissions", async () => {
    const { paths, file } = await source();
    const staging = join(directory, "staged");
    await mkdir(staging);
    const captured = await capturePiSession(paths.piSessions, file, staging, nativeId, resume);
    expect(captured).toBeDefined();
    if (!captured) throw new Error("Missing captured session");
    expect(await readFile(captured.rawFile)).toEqual(raw);
    expect(captured.snapshot.raw_sha256).toBe(hash(raw));
    expect((await stat(captured.file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file)).toEqual(raw);
  });
  test("rejects incomplete/malformed records, unknown leaves and symlinks", async () => {
    const { paths, file } = await source();
    await expect(
      validatePiJsonl(file, nativeId, { ...resume, selected_leaf_id: "missing" }),
    ).rejects.toThrow();
    await writeFile(file, raw.subarray(0, raw.length - 1));
    await expect(validatePiJsonl(file, nativeId, resume)).rejects.toThrow("Incomplete");
    await writeFile(file, Buffer.concat([raw, Buffer.from("{broken}\n")]));
    await expect(validatePiJsonl(file, nativeId, resume)).rejects.toThrow("Malformed");
    await writeFile(
      file,
      Buffer.concat([
        raw,
        Buffer.from(
          '{"type":"custom","id":"utf8","parentId":null,"timestamp":"t","customType":"test","data":"',
        ),
        Buffer.from([255]),
        Buffer.from('"}\n'),
      ]),
    );
    await expect(validatePiJsonl(file, nativeId, resume)).rejects.toThrow("UTF-8");
    const link = join(paths.piSessions, "symlink.jsonl");
    await symlink(file, link);
    await expect(
      capturePiSession(paths.piSessions, link, directory, nativeId, resume),
    ).rejects.toThrow();
    await expect(
      capturePiSession(
        paths.piSessions,
        join(directory, "outside.jsonl"),
        directory,
        nativeId,
        resume,
      ),
    ).rejects.toThrow();
  });
  test.each([
    resume,
    { leaf_known: true, selected_leaf_id: null },
    { leaf_known: false, selected_leaf_id: null },
  ])("fork preserves complete tree and durable selection %j", async (selection) => {
    const { paths, file } = await source();
    const checkout = join(directory, "new-user-checkout");
    await mkdir(checkout);
    const session = remote();
    if (!session.snapshot) throw new Error("Missing session snapshot");
    session.snapshot.resume_metadata = selection;
    const fork = await forkArchive(file, checkout, paths.piSessions, session, SessionManager);
    const restored = SessionManager.open(fork);
    expect(restored.getSessionId()).not.toBe(nativeId);
    expect(restored.getCwd()).toBe(await realpath(checkout));
    expect(restored.getEntries().slice(0, entries.length)).toEqual(entries);
    expect(await readFile(file)).toEqual(raw);
    if (selection.leaf_known) {
      const leaf = restored.getLeafEntry();
      if (!leaf) throw new Error("Missing restored leaf entry");
      expect(leaf.parentId).toBe(selection.selected_leaf_id);
    } else expect(restored.getLeafId()).toBe("e");
    restored.appendCustomEntry("new-turn", { synthetic: true });
    expect(SessionManager.open(fork).getLeafEntry()?.type).toBe("custom");
    expect((await stat(fork)).mode & 0o777).toBe(0o600);
  });
  test.skipIf(process.env["SESSION_BACKUP_LOAD_TESTS"] !== "1")(
    "full 100 MiB single-line capture and one-byte-over rejection",
    async () => {
      const { paths, file } = await source();
      const prefix = Buffer.from(
        `${JSON.stringify({ type: "session", version: 3, id: nativeId, timestamp, cwd: "/synthetic" })}\n{"type":"custom","id":"a","parentId":null,"timestamp":"t","customType":"load","data":{"blob":"`,
      );
      const suffix = Buffer.from('"}}\n');
      const handle = await open(file, "w");
      try {
        await handle.write(prefix);
        let remaining = MAX_RAW_BYTES - prefix.length - suffix.length;
        const chunk = Buffer.alloc(64 * 1024, 97);
        while (remaining > 0) {
          const part = chunk.subarray(0, Math.min(chunk.length, remaining));
          await handle.write(part);
          remaining -= part.length;
        }
        await handle.write(suffix);
      } finally {
        await handle.close();
      }
      const captured = await capturePiSession(paths.piSessions, file, directory, nativeId, resume);
      if (!captured) throw new Error("Missing captured session");
      expect(captured.snapshot.raw_size_bytes).toBe(MAX_RAW_BYTES);
      await writeFile(file, "x", { flag: "a" });
      await expect(
        capturePiSession(paths.piSessions, file, directory, nativeId, resume),
      ).rejects.toThrow("100 MiB");
    },
    120_000,
  );
  test("raw and stored declarations accept exact limits and reject one byte over", () => {
    const maximum = {
      ...snapshot(),
      encoding: "gzip",
      raw_size_bytes: MAX_RAW_BYTES,
      stored_size_bytes: MAX_STORED_BYTES,
    };
    expect(snapshotSchema.safeParse(maximum).success).toBe(true);
    expect(
      snapshotSchema.safeParse({ ...maximum, raw_size_bytes: MAX_RAW_BYTES + 1 }).success,
    ).toBe(false);
    expect(
      snapshotSchema.safeParse({ ...maximum, stored_size_bytes: MAX_STORED_BYTES + 1 }).success,
    ).toBe(false);
  });
  test("format dispatch and bounded decompression reject unsupported/oversized archives", async () => {
    const session = remote();
    session.harness = "another";
    expect(() => assertPiAdapter(session)).toThrow("Unsupported");
    const stored = join(directory, "archive.gz");
    const compressed = gzipSync(Buffer.alloc(1024 * 1024));
    await writeFile(stored, compressed);
    const bad = {
      ...snapshot(),
      encoding: "gzip" as const,
      stored_sha256: hash(compressed),
      stored_size_bytes: compressed.length,
    };
    await expect(verifyArchive(stored, join(directory, "raw.jsonl"), bad)).rejects.toThrow(
      "declared size",
    );
  });
});

class FakeBackend {
  enabled = true;
  owner = "1";
  failFinalizeOnce = false;
  uploads = 0;
  remote = { ...remote(), snapshot: null, last_backup_at: null } as RemoteSession;
  reserved: { request_id: string; snapshot: Snapshot } | undefined;
  calls: { path: string; headers: Headers; body?: unknown }[] = [];
  fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    this.calls.push({
      path: url.pathname,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url.hostname === "objects.example.test") {
      expect(headers.has("authorization")).toBe(false);
      expect(headers.get("if-none-match")).toBe("*");
      if (!init?.body) throw new Error("Missing upload body");
      await new Response(init.body).arrayBuffer();
      this.uploads++;
      return new Response(null, { status: 200 });
    }
    if (url.pathname.endsWith("/status"))
      return Response.json({ enabled: this.enabled, owner_user_id: this.owner });
    if (url.pathname === "/api/v1/sessions") return Response.json(this.remote);
    if (url.pathname.endsWith("backup-upload")) {
      if (!init?.body) throw new Error("Missing backup request body");
      const body = JSON.parse(String(init.body)) as { request_id: string; snapshot: Snapshot };
      if (
        this.remote.snapshot?.display_name === body.snapshot.display_name &&
        this.remote.snapshot?.raw_sha256 === body.snapshot.raw_sha256 &&
        JSON.stringify(this.remote.snapshot.resume_metadata) ===
          JSON.stringify(body.snapshot.resume_metadata)
      )
        return Response.json({ status: "already_current", session: this.remote });
      this.reserved = body;
      return Response.json({
        status: "upload_required",
        upload: { url: "https://objects.example.test/upload", headers: { "If-None-Match": "*" } },
      });
    }
    if (url.pathname.endsWith("backup-finalize")) {
      if (!this.reserved) throw new Error("Missing reserved snapshot");
      this.remote.snapshot = this.reserved.snapshot;
      this.remote.display_name = this.reserved.snapshot.display_name;
      this.remote.update_token = crypto.randomUUID();
      this.remote.last_backup_at = timestamp;
      if (this.failFinalizeOnce) {
        this.failFinalizeOnce = false;
        throw new Error("synthetic response lost after commit");
      }
      return Response.json({ status: "committed", session: this.remote });
    }
    throw new Error("Unexpected fake backend path");
  }) as typeof fetch;
}

test("native backup bundle captures after final environment filtering using the managed home", async () => {
  const { paths, file } = await source();
  await writeFile(file, namedRaw(["Bundle\u2028title"]));
  await saveEncryptedSession(paths, "synthetic-token");
  const controller = new SessionBackups(
    paths,
    new BackupApi(paths, BUILD_INFO.serviceOrigin, new FakeBackend().fetcher),
  );
  await controller.prepare();
  const url = new URL(
    "../src/harnesses/pi/resources/extensions/session-backup.mjs",
    import.meta.url,
  ).href;
  const script = `
    const calls = [];
    globalThis.fetch = async (input) => {
      const path = new URL(input).pathname;
      calls.push(path);
      return path.endsWith('/status')
        ? Response.json({ enabled: true, owner_user_id: '1' })
        : Response.json({}, { status: 503 });
    };
    const { default: extension } = await import(${JSON.stringify(url)});
    const events = new Map();
    const commands = [];
    extension({ events: { emit() {} }, on(name, handler) { events.set(name, handler); }, registerCommand(name) { commands.push(name); } });
    const ctx = {
      hasUI: false,
      sessionManager: {
        getSessionFile: () => ${JSON.stringify(file)},
        getSessionId: () => ${JSON.stringify(nativeId)},
        getLeafId: () => ${JSON.stringify(resume.selected_leaf_id)},
      },
    };
    await events.get('session_shutdown')({}, ctx);
    console.log(JSON.stringify({ events: [...events.keys()], commands, calls }));
  `;
  const environment = createHarnessEnvironment(
    createPiEnvironment(
      {
        ...process.env,
        AXON_HOME: directory,
        HOME: directory,
        PI_AXON_BACKUP_SERVICE_ORIGIN: "https://untrusted.example.test",
        PI_AXON_BACKUP_HOME: "/wrong/backup-home",
      },
      paths,
    ),
  );
  expect(environment["AXON_HOME"]).toBeUndefined();
  expect(environment["PI_AXON_BACKUP_SERVICE_ORIGIN"]).toBe(BUILD_INFO.serviceOrigin);
  expect(environment["PI_AXON_BACKUP_HOME"]).toBe(paths.home);
  const child = Bun.spawn(["node", "--input-type=module", "-e", script], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const output = JSON.parse(stdout) as { events: string[]; commands: string[]; calls: string[] };
  expect(output.events).toEqual(["session_start", "session_shutdown", "session_tree"]);
  expect(output.commands).toEqual(["axon-backup-now", "axon-backups"]);
  // The source test runner may use a deployment mount (e.g. an exported production
  // build URL). The native bundle must retain it, not fall back to domain-root paths.
  expect(output.calls).toEqual(
    [
      SERVICE_ENDPOINTS.sessions.status,
      SERVICE_ENDPOINTS.sessions.status,
      SERVICE_ENDPOINTS.sessions.base,
    ].map((path) => new URL(resolveServiceUrl(BUILD_INFO.serviceOrigin, path)).pathname),
  );
  expect(await controller.status()).toContain("pending streams: 1");
  const scope = (await readdir(controller.root)).find((name) => /^[a-f0-9]{64}$/.test(name));
  if (!scope) throw new Error("Missing backup scope");
  const streams = await readdir(join(controller.root, scope));
  const stream = streams.find((name) => /^[a-f0-9]{64}$/.test(name));
  if (!stream) throw new Error("Missing backup stream");
  const state = JSON.parse(
    await readFile(join(controller.root, scope, stream, "state.json"), "utf8"),
  );
  expect(state.next.snapshot.display_name).toBe("Bundle title");
});

test("CLI exposes session operations without user enable/disable commands", async () => {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../src/index.ts"), "sessions", "--help"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toContain("status");
  expect(stdout).toContain("retry");
  expect(stdout).not.toMatch(/^\s+(enable|disable|pause)\b/m);
  expect(stdout).not.toContain("accept-sensitive-data");
});

test("CLI lists readable titles, local backup times and sizes across pages", async () => {
  const { paths } = await source();
  await saveEncryptedSession(paths, "synthetic-token");
  const named = remote();
  named.display_name = 'Fix "login" flow';
  if (!named.snapshot) throw new Error("Missing named session snapshot");
  named.snapshot.display_name = named.display_name;
  const unnamed = remote();
  const previousHome = process.env["AXON_HOME"];
  const previousUserHome = process.env["HOME"];
  process.env["HOME"] = directory;
  process.env["AXON_HOME"] = directory;
  const output = spyOn(console, "log").mockImplementation(() => {});
  const cursor = { before: timestamp, before_id: named.id };
  const requests: URL[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
  ) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname.endsWith("/status"))
      return Response.json({ enabled: true, owner_user_id: "1" });
    return url.searchParams.has("before")
      ? Response.json({ sessions: [unnamed], next: null })
      : Response.json({ sessions: [named], next: cursor });
  }) as typeof fetch);
  try {
    await runSessions("list");
    expect(output.mock.calls).toHaveLength(1);
    const listing = String(output.mock.calls[0]?.[0]);
    expect(listing).toContain(named.id);
    expect(listing).toContain(named.display_name);
    expect(listing).not.toContain(JSON.stringify(named.display_name));
    expect(listing).toContain(unnamed.id);
    expect(listing).toContain("(no title)");
    expect(listing).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(listing).toContain("KiB");
    expect(listing).not.toContain("pi-jsonl");
    expect(listing).not.toContain(timestamp);
    expect(requests.at(-1)?.searchParams.get("before")).toBe(cursor.before);
    expect(requests.at(-1)?.searchParams.get("before_id")).toBe(cursor.before_id);
  } finally {
    fetcher.mockRestore();
    output.mockRestore();
    if (previousUserHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousUserHome;
    if (previousHome === undefined) delete process.env["AXON_HOME"];
    else process.env["AXON_HOME"] = previousHome;
  }
});

describe("Owner-bound extension queue", () => {
  test("backend policy enables backups automatically and ignores a local disable flag", async () => {
    const { paths, file } = await source();
    await saveEncryptedSession(paths, "synthetic-token");
    const backend = new FakeBackend();
    const controller = new SessionBackups(
      paths,
      new BackupApi(paths, "https://backend.example.test", backend.fetcher),
    );
    expect(await controller.boundary(file, nativeId, resume, "manual")).toContain("committed");
    const binding = JSON.parse(await readFile(join(controller.root, "settings.json"), "utf8"));
    expect(binding.enabled).toBeUndefined();
    await writeFile(
      join(controller.root, "settings.json"),
      JSON.stringify({ ...binding, enabled: false }),
    );
    await writeFile(file, namedRaw(["New checkpoint"]));
    expect(await controller.boundary(file, nativeId, resume, "manual")).toContain("committed");
    expect(backend.uploads).toBe(2);
  });

  test("unavailable policy does not capture or upload a new session", async () => {
    const { paths, file } = await source();
    await saveEncryptedSession(paths, "synthetic-token");
    const controller = new SessionBackups(
      paths,
      new BackupApi(paths, "https://backend.example.test", (async (
        _input: string | URL | Request,
      ): Promise<Response> => {
        throw new Error("offline");
      }) as typeof fetch),
    );
    expect(await controller.boundary(file, nativeId, resume, "manual")).toContain(
      "policy unavailable",
    );
    expect(await readdir(controller.root).catch(() => [])).toEqual([]);
  });

  test("administrator disabling policy after signing prevents object transfer", async () => {
    const { paths, file } = await source();
    await saveEncryptedSession(paths, "synthetic-token");
    const backend = new FakeBackend();
    let disableOnce = true;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await backend.fetcher(input, init);
      if (disableOnce && String(input).endsWith("backup-upload")) {
        backend.enabled = false;
        disableOnce = false;
      }
      return response;
    }) as typeof fetch;
    const controller = new SessionBackups(
      paths,
      new BackupApi(paths, "https://backend.example.test", fetcher),
    );
    expect(await controller.boundary(file, nativeId, resume, "manual")).toContain("pending");
    expect(backend.uploads).toBe(0);
    backend.enabled = true;
    expect(await controller.boundary(file, nativeId, resume, "manual")).toContain("committed");
    expect(backend.uploads).toBe(1);
  });

  test("renames and cleared titles commit with their snapshots and survive a lost response", async () => {
    const { paths, file } = await source();
    await saveEncryptedSession(paths, "synthetic-token");
    const backend = new FakeBackend();
    const controller = new SessionBackups(
      paths,
      new BackupApi(paths, "https://backend.example.test", backend.fetcher),
    );
    await controller.prepare();
    await writeFile(file, namedRaw(["Original"]));
    expect(await controller.boundary(file, nativeId, resume, "manual")).toContain("committed");
    expect(backend.remote.display_name).toBe("Original");
    await writeFile(file, namedRaw(["Original", "Renamed"]));
    backend.failFinalizeOnce = true;
    expect(await controller.boundary(file, nativeId, resume, "manual")).toContain("pending");
    expect(backend.remote.display_name).toBe("Renamed");
    expect(await controller.boundary(file, nativeId, resume, "manual")).toMatch(
      /committed|confirmed/,
    );
    expect(backend.uploads).toBe(2);
    await writeFile(file, namedRaw(["Original", "Renamed", ""]));
    expect(await controller.boundary(file, nativeId, resume, "manual")).toContain("committed");
    expect(backend.remote.display_name).toBe("/historical/path");
    if (!backend.remote.snapshot) throw new Error("Missing committed snapshot");
    expect(backend.remote.snapshot.display_name).toBe("/historical/path");
    expect(backend.uploads).toBe(3);
    await controller.boundary(file, nativeId, resume, "manual");
    expect(backend.uploads).toBe(3);
  });
  test("administrator policy controls automatic capture; uncertain commits coalesce", async () => {
    const { paths, file } = await source();
    await saveEncryptedSession(paths, "synthetic-token");
    const backend = new FakeBackend();
    const controller = new SessionBackups(
      paths,
      new BackupApi(paths, "https://backend.example.test", backend.fetcher),
    );
    backend.enabled = false;
    expect(await controller.boundary(file, nativeId, resume, "manual")).toContain(
      "disabled by administrator",
    );
    expect(backend.calls.map((call) => call.path)).toEqual(["/api/v1/sessions/status"]);
    expect(await readdir(controller.root).catch(() => [])).toEqual([]);
    backend.enabled = true;
    backend.failFinalizeOnce = true;
    expect(await controller.boundary(file, nativeId, resume, "session_shutdown")).toContain(
      "pending",
    );
    const firstDevice = await controller.device();
    const restarted = new SessionBackups(
      paths,
      new BackupApi(paths, "https://backend.example.test", backend.fetcher),
    );
    expect(await restarted.device()).toBe(firstDevice);
    expect(await restarted.boundary(file, nativeId, resume, "manual")).toContain("committed");
    expect(backend.uploads).toBe(1);
    await restarted.boundary(file, nativeId, resume, "session_shutdown");
    expect(backend.uploads).toBe(1);
    backend.enabled = false;
    expect(await restarted.boundary(file, nativeId, resume, "manual")).toContain("disabled");
  });
  test("download verifies and archives original bytes; restored backups use a new destination stream", async () => {
    const { paths } = await source();
    await saveEncryptedSession(paths, "synthetic-token");
    const checkout = join(directory, "restore-checkout");
    await mkdir(checkout);
    const session = remote();
    const compressed = gzipSync(raw);
    session.snapshot = {
      ...snapshot(),
      encoding: "gzip",
      stored_size_bytes: compressed.length,
      stored_sha256: hash(compressed),
    };
    const downloadFetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.redirect).toBe("error");
      if (url.hostname === "objects.example.test") {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return new Response(compressed);
      }
      if (url.pathname.endsWith("/status"))
        return Response.json({ enabled: true, owner_user_id: "1" });
      return Response.json({
        session,
        object_id: "synthetic-object",
        url: "https://objects.example.test/download",
        expires_in: 300,
      });
    }) as typeof fetch;
    const restored = await restoreSession(
      new BackupApi(paths, "https://backend.example.test", downloadFetcher),
      session.id,
      checkout,
      { manager: SessionManager, inspect: async () => true },
    );
    if (!restored) throw new Error("Restore unexpectedly cancelled");
    const archives = join(paths.home, "session-backups", "archives");
    const archive = (await readdir(archives))[0];
    if (!archive) throw new Error("Missing preserved archive");
    expect(await readFile(join(archives, archive, "original.jsonl"))).toEqual(raw);
    const manager = SessionManager.open(restored);
    const backend = new FakeBackend();
    const backups = new SessionBackups(
      paths,
      new BackupApi(paths, "https://backend.example.test", backend.fetcher),
    );
    await backups.prepare();
    await backups.boundary(
      restored,
      manager.getSessionId(),
      { leaf_known: true, selected_leaf_id: manager.getLeafId() },
      "manual",
    );
    const registration = backend.calls.find((call) => call.path === "/api/v1/sessions")?.body as {
      client_session_key: string;
      device_id: string;
      harness_session_id: string;
    };
    expect(registration.client_session_key).not.toBe(session.client_session_key);
    expect(registration.device_id).not.toBe(session.device_id);
    expect(registration.harness_session_id).toBe(manager.getSessionId());
  });
  test("new sessions without a persisted file skip cleanly and can later commit", async () => {
    const { paths, file } = await source();
    await saveEncryptedSession(paths, "synthetic-token");
    const backend = new FakeBackend();
    const controller = new SessionBackups(
      paths,
      new BackupApi(paths, "https://backend.example.test", backend.fetcher),
    );
    await controller.prepare();
    await rm(file);
    expect(await controller.boundary(file, nativeId, resume, "session_start")).toContain(
      "No session content",
    );
    expect(await controller.status()).toContain("paused: 0");
    expect(backend.uploads).toBe(0);
    await writeFile(file, raw);
    expect(await controller.boundary(file, nativeId, resume, "manual")).toContain("committed");
    expect(backend.uploads).toBe(1);
  });
  test("pending old account content is never uploaded by a new login", async () => {
    const { paths, file } = await source();
    await saveEncryptedSession(paths, "old-token");
    const backend = new FakeBackend();
    const controller = new SessionBackups(
      paths,
      new BackupApi(paths, "https://backend.example.test", backend.fetcher),
    );
    await controller.prepare();
    backend.failFinalizeOnce = true;
    await controller.boundary(file, nativeId, resume, "session_shutdown");
    await saveEncryptedSession(paths, "new-user-token");
    backend.owner = "2";
    const before = backend.calls.length;
    expect(await controller.boundary(file, nativeId, resume, "session_start")).toContain(
      "account changed",
    );
    expect(
      backend.calls.slice(before).every((call) => call.path === "/api/v1/sessions/status"),
    ).toBe(true);
    expect(backend.uploads).toBe(1);
  });
  test("account change between verification and API request is blocked", async () => {
    const { paths } = await source();
    await saveEncryptedSession(paths, "old-token");
    const backend = new FakeBackend();
    const api = new BackupApi(paths, "https://backend.example.test", backend.fetcher);
    await api.owner();
    await saveEncryptedSession(paths, "new-token");
    await expect(api.request("/api/v1/sessions", "POST", { sensitive: true })).rejects.toThrow(
      "Credential changed",
    );
    expect(backend.calls).toHaveLength(1);
  });
  test("extension has lifecycle hooks but rejects user backup policy toggles", async () => {
    const previousOrigin = process.env["PI_AXON_BACKUP_SERVICE_ORIGIN"];
    const previousHome = process.env["PI_AXON_BACKUP_HOME"];
    process.env["PI_AXON_BACKUP_SERVICE_ORIGIN"] = "https://backend.example.test";
    process.env["PI_AXON_BACKUP_HOME"] = directory;
    const events: string[] = [];
    const commands: string[] = [];
    let backupHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
    sessionBackupExtension({
      on: (name: string, _handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        events.push(name);
      },
      registerCommand: (name: string, command: { handler: typeof backupHandler }) => {
        commands.push(name);
        if (name === "axon-backups") backupHandler = command.handler;
      },
    } as unknown as ExtensionAPI);
    if (previousOrigin === undefined) delete process.env["PI_AXON_BACKUP_SERVICE_ORIGIN"];
    else process.env["PI_AXON_BACKUP_SERVICE_ORIGIN"] = previousOrigin;
    if (previousHome === undefined) delete process.env["PI_AXON_BACKUP_HOME"];
    else process.env["PI_AXON_BACKUP_HOME"] = previousHome;
    expect(events).toEqual(["session_start", "session_shutdown", "session_tree"]);
    expect(commands).toEqual(["axon-backup-now", "axon-backups"]);
    if (!backupHandler) throw new Error("Missing backup command");
    const notices: string[] = [];
    for (const action of ["enable", "disable", "pause"]) {
      await backupHandler(action, {
        hasUI: true,
        ui: {
          notify: (message: string) => notices.push(message),
          confirm: () => {
            throw new Error("No consent prompt expected");
          },
        },
      } as unknown as ExtensionContext);
    }
    expect(notices).toHaveLength(3);
    expect(notices.every((notice) => notice.includes("controlled by the administrator"))).toBe(
      true,
    );
  });
});
