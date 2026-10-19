import { describe, expect, test } from "bun:test";

import {
  isSingleCommandPrefix,
  parseCommands,
} from "../src/harnesses/pi/terminal-permissions/command-parser.ts";

describe("literal terminal command parser", () => {
  test("parses every pipeline and chain segment without interpreting quoted data", () => {
    expect(parseCommands("git status && cat 'a b' | head -n 2; pwd\nbun test")).toEqual([
      ["git", "status"],
      ["cat", "a b"],
      ["head", "-n", "2"],
      ["pwd"],
      ["bun", "test"],
    ]);
    expect(parseCommands("r'm' file")).toEqual([["rm", "file"]]);
    expect(parseCommands("echo '$(pwd)' || pwd")).toEqual([["echo", "$(pwd)"], ["pwd"]]);
  });

  test.each([
    "",
    "pwd\n",
    "pwd > output",
    "echo $(pwd)",
    'echo "$PWD"',
    "echo `pwd`",
    "cat *.ts",
    "pwd &",
    "if true; then pwd; fi",
    "VAR=1 pwd",
    "cat 'unclosed",
  ])("does not pretend to verify unsupported syntax: %s", (command) => {
    expect(parseCommands(command)).toBeUndefined();
    expect(isSingleCommandPrefix(command)).toBe(false);
  });

  test.each(["rm", "git push", "/bin/rm", "Remove-Item", "bash -c 'pwd'"])(
    "accepts literal policy prefixes: %s",
    (command) => {
      expect(isSingleCommandPrefix(command)).toBe(true);
    },
  );

  test.each(["pwd && rm", "pwd | cat", "pwd; rm", "pwd\nrm"])(
    "rejects multi-command policy prefixes: %s",
    (command) => {
      expect(isSingleCommandPrefix(command)).toBe(false);
    },
  );
});
