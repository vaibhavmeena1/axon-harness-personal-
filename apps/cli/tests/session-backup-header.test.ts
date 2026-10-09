import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import sessionBackupExtension, {
  BACKUP_HEADER_CHANNEL,
  backupHeaderState,
} from "../src/harnesses/pi/session-backup/index.ts";
import { SessionBackups } from "../src/sessions/backup.ts";

const environmentKeys = ["PI_AXON_BACKUP_SERVICE_ORIGIN", "PI_AXON_BACKUP_HOME"] as const;
let savedEnvironment: Record<string, string | undefined>;

beforeEach(() => {
  savedEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env["PI_AXON_BACKUP_SERVICE_ORIGIN"] = "https://backend.example.test";
  process.env["PI_AXON_BACKUP_HOME"] = "/tmp/axon-backup-header-test";
});

afterEach(() => {
  for (const key of environmentKeys) {
    const value = savedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setup() {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<
    string,
    { handler(args: string, ctx: ExtensionContext): Promise<void> }
  >();
  const emit = mock((_channel: string, _data: unknown) => {});
  const setStatus = mock(() => {});
  const notify = mock((_message: string, _level: string) => {});
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: { setStatus, notify },
    sessionManager: {
      getSessionFile: () => "/tmp/session.jsonl",
      getSessionId: () => "native-session",
      getLeafId: () => null,
    },
  } as unknown as ExtensionContext;
  sessionBackupExtension({
    events: { emit },
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(name, handler);
    },
    registerCommand: (
      name: string,
      command: { handler(args: string, ctx: ExtensionContext): Promise<void> },
    ) => {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI);
  const states = () =>
    emit.mock.calls
      .filter(([channel]) => channel === BACKUP_HEADER_CHANNEL)
      .map(([, state]) => state);
  return { handlers, commands, states, ctx, setStatus, notify };
}

describe("backup header status", () => {
  test("only reports confirmed checkpoints as saved", () => {
    for (const [message, state] of [
      ["Backups disabled by administrator", "off"],
      ["Backup committed", "saved"],
      ["Backup confirmed 2026-10-01T00:00:00Z", "saved"],
      ["Backup committed; newer checkpoint pending", "pending"],
      ["Snapshot pending (offline, unavailable or timed out); not backed up yet", "pending"],
      [
        "Incomplete or changing checkpoint; retry at the next boundary (not backed up yet)",
        "pending",
      ],
      ["Reservation expired; reconciled snapshot will retry at the next boundary", "pending"],
      ["Backup paused: login required", "paused"],
      ["Backup capture failed (invalid, oversized, unsafe or busy); Pi remains usable", "paused"],
      ["No persisted session to back up", "ready"],
      ["No session content to back up", "ready"],
      ["Backups enabled; last confirmed: none; pending streams: 0; paused: 0", "ready"],
      ["Backups enabled; last confirmed: 2026-10-01; pending streams: 0; paused: 0", "saved"],
      ["Backups enabled; last confirmed: 2026-10-01; pending streams: 1; paused: 0", "pending"],
      [
        "Backups enabled; last confirmed: none; pending streams: 1; paused: 1; local queue issues: 1",
        "paused",
      ],
      ["unknown private detail", "paused"],
    ] as const) {
      expect(backupHeaderState(message)).toBe(state);
    }
  });

  test("publishes live background capture progress without putting text in the footer", async () => {
    let complete!: (value: string) => void;
    let started!: () => void;
    const checkpoint = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const boundary = spyOn(SessionBackups.prototype, "boundary").mockImplementation(() => {
      started();
      return checkpoint;
    });
    try {
      const { handlers, states, ctx, setStatus } = setup();
      expect(handlers.get("session_start")?.({}, ctx)).toBeUndefined();
      expect(states()).toEqual(["checking"]);
      await entered;
      expect(states()).toEqual(["checking", "syncing"]);
      complete("Backup committed");
      await handlers.get("session_shutdown")?.({}, ctx);
      expect(states()).toEqual(["checking", "syncing", "saved", "syncing", "saved"]);
      expect(setStatus).not.toHaveBeenCalled();
    } finally {
      complete("Backup committed");
      boundary.mockRestore();
    }
  });

  test("keeps detailed command notifications while publishing safe concise states", async () => {
    const status = spyOn(SessionBackups.prototype, "status").mockResolvedValue(
      "Backups enabled; last confirmed: none; pending streams: 1; paused: 0",
    );
    try {
      const { commands, states, ctx, setStatus, notify } = setup();
      await commands.get("axon-backups")?.handler("status", ctx);
      expect(states()).toEqual(["pending"]);
      expect(notify.mock.calls[0]?.[0]).toContain("pending streams: 1");
      status.mockRejectedValue(new Error("private-name /private/path secret-token"));
      await commands.get("axon-backups")?.handler("status", ctx);
      expect(states()).toEqual(["pending", "paused"]);
      expect(notify.mock.calls[1]?.[0]).not.toContain("secret-token");
      expect(setStatus).not.toHaveBeenCalled();
    } finally {
      status.mockRestore();
    }
  });
});
