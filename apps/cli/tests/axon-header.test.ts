import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { PI_INSTALL_VERSION } from "../src/harnesses/pi/installation.ts";
import axonExtension from "../src/harnesses/pi/resources/extensions/axon.ts";

type HeaderFactory = NonNullable<Parameters<ExtensionContext["ui"]["setHeader"]>[0]>;
type Header = ReturnType<HeaderFactory> & { setExpanded(value: boolean): void };
const environmentKeys = ["PI_AXON_CLI_VERSION", "PI_AXON_AUTH_RELAY_URL"] as const;
let savedEnvironment: Record<string, string | undefined>;
let savedKeybindings: ReturnType<typeof getKeybindings>;

beforeEach(() => {
  savedEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
  savedKeybindings = getKeybindings();
  setKeybindings(
    new KeybindingsManager({
      "app.interrupt": { defaultKeys: "escape", description: "Interrupt" },
      "app.model.select": { defaultKeys: "ctrl+l", description: "Models" },
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand" },
      "app.clear": { defaultKeys: "ctrl+c", description: "Clear" },
      "app.exit": { defaultKeys: "ctrl+d", description: "Exit" },
      "app.thinking.cycle": { defaultKeys: "shift+tab", description: "Thinking" },
      "app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Show thinking" },
      "app.editor.external": { defaultKeys: "ctrl+g", description: "Editor" },
      "app.message.followUp": { defaultKeys: "alt+enter", description: "Queue" },
      "app.clipboard.pasteImage": { defaultKeys: "ctrl+v", description: "Attach" },
    }),
  );
});

afterEach(() => {
  setKeybindings(savedKeybindings);
  for (const key of environmentKeys) {
    const value = savedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setup(mode: ExtensionContext["mode"] = "tui", cwd?: string) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const listeners = new Map<string, (data: unknown) => void>();
  const emitBackup = (data: unknown) => listeners.get("axon:backup-status")?.(data);
  const setHeader = mock((_factory: Parameters<ExtensionContext["ui"]["setHeader"]>[0]) => {});
  axonExtension({
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        listeners.set(channel, handler);
        return () => listeners.delete(channel);
      },
    },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
      return () => {};
    },
    registerEntryRenderer() {},
    registerCommand() {},
  } as unknown as ExtensionAPI);
  handlers.get("session_start")?.({}, {
    mode,
    cwd,
    hasUI: mode === "tui" || mode === "rpc",
    ui: { setHeader },
  } as unknown as ExtensionContext);
  return { handlers, setHeader, emitBackup };
}

const plainTheme = (fg: (color: string, text: string) => string = (_color, text) => text): Theme =>
  ({ fg, bold: (text: string) => text }) as unknown as Theme;

function header(
  theme = plainTheme((_color, text) => `\u001b[36m${text}\u001b[0m`),
  backupState?: string,
  cwd?: string,
): Header {
  const { setHeader, emitBackup } = setup("tui", cwd);
  if (backupState !== undefined) emitBackup(backupState);
  const factory = setHeader.mock.calls[0]?.[0];
  if (!factory) throw new Error("Axon header was not registered");
  return factory({} as Parameters<HeaderFactory>[0], theme) as Header;
}

const text = (component: Header, width = 100) =>
  component.render(width).map(stripVTControlCharacters).join("\n");
/** Zero-width color markers, so layout measures exactly as with a real theme. */
const COLOR_CODES = ["accent", "borderAccent", "borderMuted", "success", "warning", "dim", "muted"];
const sgr = (color: string) => `\u001b[38;5;${COLOR_CODES.indexOf(color) + 1}m`;
const markedTheme = () => plainTheme((color, value) => `${sgr(color)}${value}\u001b[39m`);
const marked = (color: string, value: string) => `${sgr(color)}${value}\u001b[39m`;
const collapsed = (value: string) => value.replace(/\s+/g, " ");
const WIDTHS = [1, 8, 24, 32, 40, 48, 55, 56, 57, 60, 80, 86, 120, 200];

describe("Axon startup header", () => {
  test("frames the neuron logo, launcher version, tagline, and Pi attribution in a card", () => {
    process.env["PI_AXON_CLI_VERSION"] = "0.1.0-dev";
    const lines = text(header()).split("\n");
    expect(lines[0]).toStartWith(" ╭─");
    expect(lines[0]).toEndWith("─╮");
    expect(lines[1]).toContain("◉─╮    Axon v0.1.0-dev");
    expect(lines[2]).toContain("├─●  TATA 1mg · Your coding workspace");
    expect(lines[3]).toContain("╰─●");
    expect(lines[4]).toStartWith(" ╰─");
    expect(lines[4]).toEndWith(` Powered by Pi v${PI_INSTALL_VERSION} ──╯`);
    const output = text(header());
    expect(output).toContain("escape interrupt");
    expect(output).toContain("ctrl+l models");
    expect(output).toContain("/ commands");
    expect(output).toContain("/hotkeys all shortcuts");
  });

  test("caps the card width on wide terminals and aligns hints to it", () => {
    const component = header();
    for (const width of [86, 120, 200]) {
      const lines = component.render(width).map(stripVTControlCharacters);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(85);
      expect(visibleWidth(lines[0] ?? "")).toBe(85);
    }
  });

  test("omits the launcher version when loaded outside Axon", () => {
    const output = text(header());
    expect(output).toContain("Axon");
    expect(output).not.toContain("Axon v");
    expect(output).toContain(`Powered by Pi v${PI_INSTALL_VERSION}`);
  });

  test("does not render terminal controls or multiline values from version metadata", () => {
    process.env["PI_AXON_CLI_VERSION"] = "1.0\n\u001b]0;untrusted\u0007";
    const output = text(header());
    expect(output).not.toContain("Axon v");
    expect(output).not.toContain("untrusted");
  });

  test("shows the working directory relative to home, keeping its most specific end", () => {
    const project = join(homedir(), "work", "tata-1mg", "deputydev-cli");
    expect(text(header(undefined, undefined, project))).toContain("~/work/tata-1mg/deputydev-cli");
    expect(text(header(undefined, undefined, "/srv/app"))).toContain("/srv/app");
    const deep = join(homedir(), ...Array.from({ length: 12 }, (_, index) => `segment-${index}`));
    const narrow = text(header(undefined, undefined, deep), 60);
    expect(narrow).toContain("…/");
    expect(narrow).toContain("segment-11");
    expect(narrow).not.toContain("segment-0/");
    expect(text(header())).not.toContain("~");
  });

  test("never writes terminal controls from the working directory", () => {
    const output = header(plainTheme(), undefined, "/tmp/evil\u001b]0;owned\u0007\nname")
      .render(100)
      .join("\n");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
    expect(output).toContain("/tmp/evil?]0;owned??name");
  });

  test("shows concise live backup states beside the wordmark without adding header lines", () => {
    process.env["PI_AXON_CLI_VERSION"] = "0.1.0-dev";
    const { setHeader, emitBackup } = setup();
    const requestRender = mock(() => {});
    const component = setHeader.mock.calls[0]?.[0]?.(
      { requestRender } as unknown as Parameters<HeaderFactory>[0],
      plainTheme(),
    ) as Header;
    const lineCount = component.render(100).length;
    expect(text(component)).not.toContain("Backup:");
    for (const [state, label] of [
      ["checking", "checking…"],
      ["syncing", "syncing…"],
      ["saved", "saved"],
      ["pending", "pending"],
      ["paused", "paused"],
      ["off", "off"],
      ["ready", "on"],
    ]) {
      emitBackup(state);
      expect(component.render(100)[1]).toContain(`Backup: ${label}`);
      expect(component.render(100)).toHaveLength(lineCount);
      expect(text(component)).not.toContain("/axon-backups");
      for (const width of WIDTHS) {
        for (const line of component.render(width))
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      expect(component.render(40)[0]).toContain(`Backup: ${label}`);
    }
    expect(requestRender).toHaveBeenCalledTimes(7);
    component.dispose?.();
    emitBackup("saved");
    expect(requestRender).toHaveBeenCalledTimes(7);
  });

  test("right-aligns backup status inside the card and preserves the title", () => {
    process.env["PI_AXON_CLI_VERSION"] = "0.1.0-dev";
    const component = header(undefined, "saved");
    for (const width of [58, 60, 80, 86]) {
      const row = stripVTControlCharacters(component.render(width)[1] ?? "");
      expect(row).toContain("Axon v0.1.0-dev");
      expect(row).toEndWith("● Backup: saved  │");
      expect(visibleWidth(row)).toBe(width - 1);
    }
    for (const width of [40, 48]) {
      const row = stripVTControlCharacters(component.render(width)[0] ?? "");
      expect(row).toContain("Axon v0.1.0-dev");
      expect(row).toEndWith("● Backup: saved");
      expect(visibleWidth(row)).toBe(width - 1);
    }
  });

  test("keeps the wordmark and logo intact when a long version competes with backup status", () => {
    process.env["PI_AXON_CLI_VERSION"] = `1.0.0-${"a".repeat(65)}`;
    const component = header(undefined, "checking");
    for (const width of [32, 40, 48, 58, 80, 120]) {
      const row = stripVTControlCharacters(component.render(width)[width > 57 ? 1 : 0] ?? "");
      expect(row).toContain("Axon");
      expect(row).toContain("● Backup: checking…");
      if (width > 57) expect(row).toStartWith(" │  ◉─╮    Axon");
    }
    expect(text(component, 20).split("\n")[0]).toContain("Axon");
    expect(text(component, 20).split("\n")[0]).not.toContain("Backup:");
  });

  test("uses semantic colors for backup activity, success, warnings, and disabled backup", () => {
    const theme = markedTheme();
    for (const [state, label, color, dot] of [
      ["checking", "checking…", "accent", "●"],
      ["syncing", "syncing…", "accent", "●"],
      ["saved", "saved", "success", "●"],
      ["ready", "on", "success", "●"],
      ["pending", "pending", "warning", "●"],
      ["paused", "paused", "warning", "●"],
      ["off", "off", "dim", "○"],
    ] as const) {
      const row = header(theme, state).render(200)[1];
      expect(row).toContain(marked(color, dot));
      expect(row).toContain(marked(color, label));
    }
  });

  test("brands the wordmark and logo with the accent color", () => {
    const output = header(markedTheme()).render(100).join("\n");
    expect(output).toContain(marked("accent", "Axon"));
    expect(output).toContain(marked("accent", "◉"));
    expect(output).toContain(marked("borderAccent", "├─"));
    expect(output).toContain(marked("borderMuted", "│"));
  });

  test("retains early backup updates and ignores untrusted status payloads", () => {
    const { setHeader, emitBackup } = setup();
    emitBackup("pending");
    const requestRender = mock(() => {});
    const component = setHeader.mock.calls[0]?.[0]?.(
      { requestRender } as unknown as Parameters<HeaderFactory>[0],
      plainTheme(),
    ) as Header;
    expect(text(component)).toContain("Backup: pending");
    for (const value of [
      "private-name /private/path secret-token",
      "__proto__",
      null,
      { state: "saved" },
    ])
      emitBackup(value);
    expect(requestRender).not.toHaveBeenCalled();
    expect(text(component)).toContain("Backup: pending");
    expect(text(component)).not.toContain("secret-token");
  });

  test("uses active shortcuts and omits disabled actions", () => {
    getKeybindings().setUserBindings({
      "app.interrupt": "ctrl+x",
      "app.model.select": [],
    });
    const output = text(header());
    expect(output).toContain("ctrl+x interrupt");
    expect(output).not.toContain("escape interrupt");
    expect(output).not.toContain("models");
  });

  test("expands into an aligned shortcut reference with Pi's header expansion contract", () => {
    const component = header();
    expect(text(component)).not.toContain("external editor");
    component.setExpanded(true);
    const expanded = text(component).split("\n");
    expect(collapsed(text(component))).toContain("ctrl+g external editor");
    expect(collapsed(text(component))).toContain("ctrl+c clear / twice to exit");
    expect(collapsed(text(component))).toContain("ctrl+o less");
    const columns = expanded
      .filter((line) => /^ (escape|ctrl\+l|shift\+tab|ctrl\+g) /.test(line))
      .map((line) => line.search(/ {2}\S/) + 2);
    expect(columns).toHaveLength(4);
    expect(new Set(columns).size).toBe(1);
    component.setExpanded(false);
    expect(text(component)).not.toContain("external editor");
    expect(text(component)).toContain("ctrl+o more");
  });

  test("wraps complete shortcut groups instead of clipping later actions", () => {
    const component = header();
    for (const width of [24, 32, 40, 48, 60, 80, 120]) {
      const output = text(component, width);
      for (const label of [
        "escape interrupt",
        "ctrl+l models",
        "/ commands",
        "! shell",
        "ctrl+o more",
        "/hotkeys all shortcuts",
      ]) {
        expect(output).toContain(label);
      }
      for (const line of output.split("\n")) {
        expect(line.trim()).not.toStartWith("·");
        expect(line.trim()).not.toEndWith("·");
      }
    }
    // Card (5) + spacer + two hint rows at the capped card width.
    expect(component.render(100)).toHaveLength(8);
  });

  test("wraps expanded help and adapts to keybinding changes on the same component", () => {
    const component = header();
    component.setExpanded(true);
    const output = collapsed(text(component, 24));
    expect(output).toContain("external editor");
    expect(output).toContain("ctrl+c clear / twice to exit");
    expect(output).toContain("ctrl+v attach files/images");
    getKeybindings().setUserBindings({
      "app.interrupt": "ctrl+shift+x",
      "app.model.select": [],
    });
    component.invalidate();
    expect(collapsed(text(component, 40))).toContain("ctrl+shift+x interrupt");
    expect(text(component, 40)).not.toContain("ctrl+l");
    expect(text(component, 40)).not.toContain("escape");
    component.setExpanded(false);
    expect(text(component, 40)).toContain("ctrl+o more");
  });

  test("falls back to plain stacked lines in narrow terminals and fits every line", () => {
    const component = header(undefined, "syncing", "/srv/app");
    expect(text(component, 57)).not.toContain("◉");
    expect(text(component, 57)).not.toContain("╭");
    expect(text(component, 57)).toContain("Axon");
    expect(text(component, 57)).toContain("TATA 1mg");
    expect(text(component, 58)).toContain("◉");
    for (const expanded of [false, true]) {
      component.setExpanded(expanded);
      for (const width of WIDTHS) {
        for (const line of component.render(width))
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(component.render(0)).toEqual([]);
  });

  test("rebuilds themed text after invalidation instead of caching styled lines", () => {
    let color = "36";
    const component = header(plainTheme((_role, value) => `\u001b[${color}m${value}\u001b[0m`));
    expect(component.render(100).join("\n")).toContain("\u001b[36mAxon");
    color = "35";
    component.invalidate();
    expect(component.render(100).join("\n")).toContain("\u001b[35mAxon");
  });

  for (const mode of ["rpc", "json", "print"] as const) {
    test(`does not install terminal components in ${mode} mode`, () => {
      expect(setup(mode).setHeader).not.toHaveBeenCalled();
    });
  }

  test("loads as a standalone extension in the pinned native Pi runtime", async () => {
    const root = resolve(import.meta.dir, "..");
    const home = await mkdtemp(join(tmpdir(), "axon-header-"));
    try {
      const child = Bun.spawn(
        [
          join(root, "node_modules", ".bin", "pi"),
          "--offline",
          "--no-extensions",
          "--extension",
          join(root, "src/harnesses/pi/resources/extensions/axon.ts"),
          "--list-models",
        ],
        {
          cwd: home,
          env: {
            HOME: home,
            PATH: process.env["PATH"] ?? "",
            PI_CODING_AGENT_DIR: join(home, "pi"),
            PI_SKIP_VERSION_CHECK: "1",
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.length).toBeGreaterThan(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
