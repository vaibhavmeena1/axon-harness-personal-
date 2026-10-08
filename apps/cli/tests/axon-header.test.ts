import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  visibleWidth,
} from "@earendil-works/pi-tui";

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

function setup(mode: ExtensionContext["mode"] = "tui") {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const setHeader = mock((_factory: Parameters<ExtensionContext["ui"]["setHeader"]>[0]) => {});
  axonExtension({
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
      return () => {};
    },
    registerEntryRenderer() {},
    registerCommand() {},
  } as unknown as ExtensionAPI);
  handlers.get("session_start")?.({}, {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: { setHeader },
  } as unknown as ExtensionContext);
  return { handlers, setHeader };
}

function header(
  theme = {
    fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[0m`,
  } as unknown as Theme,
): Header {
  const { setHeader } = setup();
  const factory = setHeader.mock.calls[0]?.[0];
  if (!factory) throw new Error("Axon header was not registered");
  return factory({} as Parameters<HeaderFactory>[0], theme) as Header;
}

const text = (component: Header, width = 100) =>
  component.render(width).map(stripVTControlCharacters).join("\n");

describe("Axon startup header", () => {
  test("shows the connected-node logo, launcher version, and Pi attribution", () => {
    process.env["PI_AXON_CLI_VERSION"] = "0.1.0-dev";
    const output = text(header());
    expect(output).toContain("●───●");
    expect(output).toContain("Axon v0.1.0-dev");
    expect(output).toContain("TATA 1mg · Your coding workspace");
    expect(output).toContain("Powered by Pi v1.1.0");
    expect(output).toContain("escape interrupt");
    expect(output).toContain("ctrl+l models");
    expect(output).toContain("/ commands");
    expect(output).toContain("/hotkeys all shortcuts");
  });

  test("omits the launcher version when loaded outside Axon", () => {
    const output = text(header());
    expect(output).toContain("Axon");
    expect(output).not.toContain("Axon v");
    expect(output).toContain("Powered by Pi v1.1.0");
  });

  test("does not render terminal controls or multiline values from version metadata", () => {
    process.env["PI_AXON_CLI_VERSION"] = "1.0\n\u001b]0;untrusted\u0007";
    const output = text(header());
    expect(output).not.toContain("Axon v");
    expect(output).not.toContain("untrusted");
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

  test("expands and collapses shortcut help with Pi's header expansion contract", () => {
    const component = header();
    expect(text(component)).not.toContain("external editor");
    component.setExpanded(true);
    expect(text(component)).toContain("ctrl+g external editor");
    expect(text(component)).toContain("ctrl+c clear / twice to exit");
    expect(text(component)).toContain("ctrl+o less");
    component.setExpanded(false);
    expect(text(component)).not.toContain("external editor");
    expect(text(component)).toContain("ctrl+o more");
  });

  test("falls back to a text wordmark in narrow terminals and fits every line", () => {
    const component = header();
    expect(text(component, 40)).not.toContain("●");
    expect(text(component, 40)).toContain("Axon");
    expect(text(component, 40)).toContain("TATA 1mg");
    for (const expanded of [false, true]) {
      component.setExpanded(expanded);
      for (const width of [1, 8, 24, 40, 47, 48, 80, 120]) {
        for (const line of component.render(width))
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(component.render(0)).toEqual([]);
  });

  test("rebuilds themed text after invalidation instead of caching styled lines", () => {
    let color = "36";
    const component = header({
      fg: (_role: string, value: string) => `\u001b[${color}m${value}\u001b[0m`,
    } as unknown as Theme);
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
