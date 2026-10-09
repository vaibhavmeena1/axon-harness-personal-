import { normalizeDisplayName, type RemoteSession } from "./contracts.ts";

function dateFormatter(timeZone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function backupTime(timestamp: string | null, formatter: Intl.DateTimeFormat): string {
  if (timestamp === null) return "Not backed up";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Unknown";
  // Compose the parts so ICU changes to literals (e.g. "," vs "at") cannot shift columns.
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts["day"]} ${parts["month"]} ${parts["year"]}, ${parts["hour"]}:${parts["minute"]}`;
}

export function formatBackupTime(timestamp: string | null, timeZone?: string): string {
  const formatter = dateFormatter(timeZone);
  return `${backupTime(timestamp, formatter)} (${formatter.resolvedOptions().timeZone})`;
}

export function formatSnapshotSize(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function truncateTitle(title: string, width: number): string {
  if (Bun.stringWidth(title) <= width) return title;
  let prefix = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    title,
  )) {
    if (Bun.stringWidth(prefix + segment) > width - 1) break;
    prefix += segment;
  }
  return `${prefix.trimEnd()}…`;
}

export function formatSessionTitle(
  session: Pick<RemoteSession, "display_name">,
  width?: number,
): string {
  const title =
    normalizeDisplayName(session.display_name ?? "")?.replace(/\s+/gu, " ") ?? "(no title)";
  return width === undefined ? title : truncateTitle(title, Math.max(1, width));
}

function row(id: string, date: string, size: string, title: string): string {
  return `${id.padEnd(36)}  ${date.padEnd(18)}  ${size.padStart(9)}  ${title}`;
}

export function formatSessionList(
  sessions: readonly RemoteSession[],
  options: { timeZone?: string; columns?: number } = {},
): string {
  if (!sessions.length) return "No backed-up sessions yet.";
  const formatter = dateFormatter(options.timeZone);
  const heading = `Backed-up sessions · ${formatter.resolvedOptions().timeZone}`;
  const columns = options.columns ?? 120;
  const rows = sessions.map((session) => ({
    id: session.id,
    date: backupTime(session.last_backup_at, formatter),
    size: formatSnapshotSize(session.snapshot?.raw_size_bytes),
    title: formatSessionTitle(session),
  }));
  // Keep useful titles and copyable full IDs even when a table would squeeze the title.
  if (columns < 100) {
    return [
      heading,
      ...rows.flatMap(({ id, date, size, title }) => [
        "",
        truncateTitle(title, Math.max(1, columns)),
        `  ${id}`,
        `  ${date} · ${size}`,
      ]),
    ].join("\n");
  }
  const titleWidth = Math.max(1, Math.min(60, columns - Bun.stringWidth(row("", "", "", ""))));
  return [
    heading,
    "",
    row("ID", "LAST BACKUP", "SIZE", "TITLE"),
    ...rows.map(({ id, date, size, title }) =>
      row(id, date, size, truncateTitle(title, titleWidth)),
    ),
  ].join("\n");
}
