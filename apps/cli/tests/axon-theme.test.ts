import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { AXON_THEME_SETTING, axonThemeArguments } from "../src/harnesses/pi/settings-defaults.ts";
import type { AxonPaths } from "../src/product/paths.ts";

const THEMES_DIRECTORY = resolve(import.meta.dir, "../src/harnesses/pi/resources/themes");
type Rgb = { r: number; g: number; b: number };
interface LoadedTheme {
  readonly appearance: "dark" | "light";
  readonly colors: Record<string, Rgb>;
}

// Pi does not export its theme loader, so load it from the pinned package by path.
const themeModuleDirectory = join(
  dirname(Bun.resolveSync("@earendil-works/pi-coding-agent", import.meta.dir)),
  "modes/interactive/theme",
);
const { loadThemeFromPath, setThemeJsonValidator } = (await import(
  join(themeModuleDirectory, "theme.js")
)) as {
  loadThemeFromPath(path: string, mode: string): LoadedTheme;
  setThemeJsonValidator(validator: (label: string, json: unknown) => unknown): void;
};
const { validateThemeJson } = (await import(join(themeModuleDirectory, "theme-schema.js"))) as {
  validateThemeJson(label: string, json: unknown): unknown;
};
// Match Pi 1.2 startup: the lightweight loader alone does not enable schema validation.
setThemeJsonValidator(validateThemeJson);

function contrast(a: Rgb, b: Rgb): number {
  const luminance = ({ r, g, b: blue }: Rgb) => {
    const channel = (value: number) => {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(blue);
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

describe("Axon themes", () => {
  const [light, dark] = AXON_THEME_SETTING.split("/") as [string, string];

  for (const [name, appearance, background] of [
    [dark, "dark", { r: 24, g: 24, b: 28 }],
    [light, "light", { r: 255, g: 255, b: 255 }],
  ] as const) {
    test(`${name} loads in Pi with readable text on a typical ${appearance} terminal`, async () => {
      const path = join(THEMES_DIRECTORY, `${name}.json`);
      // Pi only hot-reloads a theme whose file name matches its name.
      const document = (await Bun.file(path).json()) as { name: string; $schema: string };
      expect(document.name).toBe(name);
      expect(document.$schema).toBe("https://pi.dev/schemas/theme.schema.json");
      const theme = loadThemeFromPath(path, "truecolor");
      expect(theme.appearance).toBe(appearance);
      for (const role of ["text", "muted", "dim", "accent", "success", "error", "warning"]) {
        expect(contrast(theme.colors[role] as Rgb, background)).toBeGreaterThanOrEqual(4.5);
      }
      for (const [fg, bg] of [
        ["userMessageText", "userMessageBg"],
        ["toolOutput", "toolSuccessBg"],
        ["toolOutput", "toolErrorBg"],
        ["toolOutput", "toolPendingBg"],
        ["text", "selectedBg"],
        ["customMessageText", "customMessageBg"],
      ] as const) {
        expect(contrast(theme.colors[fg] as Rgb, theme.colors[bg] as Rgb)).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });
  }
});

test("Pi startup theme validation rejects unsupported metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axon-invalid-theme-"));
  try {
    const document = await Bun.file(join(THEMES_DIRECTORY, "axon-dark.json")).json();
    const path = join(directory, "invalid.json");
    await Bun.write(path, JSON.stringify({ ...document, unsupportedMetadata: true }));
    expect(() => loadThemeFromPath(path, "truecolor")).toThrow("Invalid theme");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Axon theme default", () => {
  let root: string;
  let paths: AxonPaths;
  let project: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "axon-theme-"));
    paths = { pi: join(root, "pi") } as AxonPaths;
    project = join(root, "project");
    await mkdir(join(project, ".pi"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("selects the Axon light/dark pair when no theme was chosen", async () => {
    expect(await axonThemeArguments(paths, project, ["hello"])).toEqual([
      "--use-theme",
      "axon-light/axon-dark",
    ]);
    await Bun.write(join(paths.pi, "settings.json"), JSON.stringify({ defaultTools: [] }));
    expect(await axonThemeArguments(paths, project, [])).toEqual([
      "--use-theme",
      AXON_THEME_SETTING,
    ]);
  });

  test("respects a theme saved globally, including Pi's system theme", async () => {
    await Bun.write(join(paths.pi, "settings.json"), JSON.stringify({ theme: "system" }));
    expect(await axonThemeArguments(paths, project, [])).toEqual([]);
  });

  test("respects a theme saved for the project", async () => {
    await Bun.write(join(project, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }));
    expect(await axonThemeArguments(paths, project, [])).toEqual([]);
  });

  test("respects an explicit --use-theme but not one passed as a message after --", async () => {
    expect(await axonThemeArguments(paths, project, ["--use-theme", "light"])).toEqual([]);
    expect(await axonThemeArguments(paths, project, ["--", "--use-theme"])).toEqual([
      "--use-theme",
      AXON_THEME_SETTING,
    ]);
  });

  test("leaves the theme to Pi when settings cannot be read safely", async () => {
    await Bun.write(join(paths.pi, "settings.json"), "{ not json");
    expect(await axonThemeArguments(paths, project, [])).toEqual([]);
  });
});
