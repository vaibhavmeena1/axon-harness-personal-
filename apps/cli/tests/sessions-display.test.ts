import { describe, expect, test } from "bun:test";

import type { RemoteSession } from "../src/sessions/contracts.ts";
import {
  formatBackupTime,
  formatSessionList,
  formatSnapshotSize,
} from "../src/sessions/display.ts";

function session(title: string | null = "Fix login flow"): RemoteSession {
  return {
    id: "8ea530c5-d5c4-4d13-9628-72d5adfe1c48",
    display_name: title,
    harness: "pi",
    harness_session_id: "native-session",
    session_format: "pi-jsonl",
    device_id: "3c302aa4-39dc-4f52-9564-d08cf05f52d3",
    client_session_key: "d7d38526-1a6f-4365-8964-cbfe0369e242",
    update_token: "8ea530c5-d5c4-4d13-9628-72d5adfe1c48",
    last_backup_at: "2026-10-08T21:05:04.358013+00:00",
    updated_at: "2026-10-08T21:05:04.358013+00:00",
    snapshot: {
      display_name: title,
      raw_sha256: "a".repeat(64),
      stored_sha256: "a".repeat(64),
      raw_size_bytes: 17948,
      stored_size_bytes: 17948,
      encoding: "identity",
      session_format_version: "3",
      resume_metadata: { leaf_known: false, selected_leaf_id: null },
    },
  };
}

describe("session listing display", () => {
  test("shows local dates, timezone, readable sizes and unquoted titles", () => {
    const item = session('Fix "login" flow');
    const listing = formatSessionList([item], { timeZone: "Asia/Kolkata", columns: 120 });
    expect(listing).toContain("Backed-up sessions · Asia/Kolkata");
    expect(listing).toContain("LAST BACKUP");
    expect(listing).toContain("TITLE");
    expect(listing).toContain(item.id);
    expect(listing).toContain("09 Oct 2026, 02:35");
    expect(listing).toContain("17.5 KiB");
    expect(listing).toContain('Fix "login" flow');
    expect(listing).not.toContain('\\"');
    expect(listing).not.toContain("pi-jsonl");
    expect(listing).not.toContain(item.last_backup_at as string);
  });

  test("uses the current machine timezone by default", () => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(formatSessionList([session()])).toContain(timeZone);
    expect(formatSessionList([session()])).toContain(
      formatBackupTime(session().last_backup_at).replace(` (${timeZone})`, ""),
    );
  });

  test("converts timezone offsets and daylight saving time at the backup date", () => {
    expect(formatBackupTime("2026-10-08T21:05:04Z", "UTC")).toBe("08 Oct 2026, 21:05 (UTC)");
    expect(formatBackupTime("2026-01-01T12:00:00Z", "America/New_York")).toBe(
      "01 Jan 2026, 07:00 (America/New_York)",
    );
    expect(formatBackupTime("2026-07-01T12:00:00Z", "America/New_York")).toBe(
      "01 Jul 2026, 08:00 (America/New_York)",
    );
  });

  test("has a useful empty state", () => {
    expect(formatSessionList([])).toBe("No backed-up sessions yet.");
  });

  test("does not pretend missing or invalid backup metadata is a timestamp or zero bytes", () => {
    const item = session(null);
    item.snapshot = null;
    item.last_backup_at = null;
    const listing = formatSessionList([item], { timeZone: "UTC" });
    expect(listing).toContain("(no title)");
    expect(listing).toContain("Not backed up");
    expect(listing).toContain("—");
    expect(listing).not.toContain("0 B");
    expect(formatBackupTime("not a date", "UTC")).toBe("Unknown (UTC)");
  });

  test.each(["a".repeat(256), "界".repeat(256), "😀".repeat(256), "👩‍💻".repeat(80)])(
    "keeps useful titles and full IDs in narrow terminals: %s",
    (title) => {
      const item = session(title);
      const listing = formatSessionList([item], { timeZone: "UTC", columns: 80 });
      const lines = listing.split("\n");
      expect(lines).toHaveLength(5);
      for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
      expect(lines[2]).toEndWith("…");
      expect(lines[3]).toContain(item.id);
      expect(item.display_name).toBe(title);
      expect(listing).not.toContain("�");
    },
  );

  test("truncates wide-table titles without hiding full IDs", () => {
    const listing = formatSessionList([session("界".repeat(256))], {
      timeZone: "UTC",
      columns: 100,
    });
    const line = listing.split("\n").at(-1) ?? "";
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(100);
    expect(line).toEndWith("…");
    expect(line).toContain(session().id);
  });

  test("renders titles on one line and strips terminal control characters", () => {
    const listing = formatSessionList([session("  Fix\nlogin\tflow\x1b  ")], { timeZone: "UTC" });
    expect(listing.split("\n")).toHaveLength(4);
    expect(listing).toContain("Fix login flow");
    expect(listing).not.toContain("\x1b");
  });

  test.each([
    [undefined, "—"],
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KiB"],
    [17948, "17.5 KiB"],
    [1024 * 1024, "1.0 MiB"],
    [100 * 1024 * 1024, "100.0 MiB"],
  ] as const)("formats %s bytes as %s", (bytes, expected) => {
    expect(formatSnapshotSize(bytes)).toBe(expected);
  });
});
