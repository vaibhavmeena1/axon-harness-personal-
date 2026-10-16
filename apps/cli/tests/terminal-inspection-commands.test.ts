import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCommands } from "../src/harnesses/pi/terminal-permissions/command-parser.ts";
import {
  classifyInspectionCommand,
  createWorkspacePathChecker,
} from "../src/harnesses/pi/terminal-permissions/inspection-commands.ts";

let directory: string;
let workspace: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "axon-inspection-"));
  workspace = join(directory, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "source.ts"), "const result = 1;\n");
  await writeFile(join(workspace, "patterns.txt"), "result\n");
  await writeFile(join(directory, "outside.txt"), "private\n");
  await symlink(join(directory, "outside.txt"), join(workspace, "outside-link"));
  await symlink(join(workspace, "source.ts"), join(workspace, "inside-link"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function classify(command: string): string {
  const commands = parseCommands(command);
  if (commands?.length !== 1 || commands[0] === undefined) return "unsupported";
  return classifyInspectionCommand(commands[0], workspace);
}

describe("argument-aware inspection profiles", () => {
  test.each([
    "pwd",
    "pwd -P",
    "ls -lah .",
    "cat -n source.ts",
    "head -n 10 source.ts",
    "head -n10 source.ts",
    "tail --lines=20 source.ts",
    "wc -l source.ts",
    "grep -n result source.ts",
    "grep -in -e result source.ts",
    "grep -f patterns.txt source.ts",
    "rg -n result source.ts",
    "rg -n -g '*.ts' result .",
    "rg --files .",
    "rg --regexp=result source.ts",
    "rg --file patterns.txt .",
    "rg --context=2 result .",
    "find . -maxdepth 2 -type f -name '*.ts' -print",
    "sed -n '1,200p' source.ts",
    "git status --short",
    "git --no-pager status --porcelain=v2",
    "git diff --stat --no-ext-diff --no-textconv",
    "git diff --no-ext-diff --no-textconv HEAD -- source.ts",
    "git log --oneline -n5",
    "git log --format='%h %s' --max-count=5",
    "git log -p --no-ext-diff --no-textconv -n 1",
    "git show --stat --no-ext-diff --no-textconv HEAD",
    "git ls-files -- source.ts",
    "cat inside-link",
    "cat -- source.ts",
  ])("recognizes read-only arguments: %s", (command) => {
    expect(classify(command)).toBe("inspection");
  });

  test.each([
    "ls -L .",
    "tail -f source.ts",
    "head -n invalid source.ts",
    "head -n",
    "wc --files0-from=source.ts",
    "rg -L result .",
    "rg --follow result .",
    "rg --pre=helper result .",
    "rg --hostname-bin=helper result .",
    "rg --type-add=custom result .",
    "grep -R result .",
    "grep --unknown result .",
    "find . -delete",
    "find . -exec helper",
    "find . -fprint output",
    "find -L . -print",
    "sed -i 's/a/b/' source.ts",
    "sed -n '1,2w output' source.ts",
    "sed -n 'e helper' source.ts",
    "git diff --output=output",
    "git diff --ext-diff",
    "git show --textconv HEAD",
    "git diff",
    "git diff --stat",
    "git diff --no-ext-diff HEAD",
    "git diff --no-textconv HEAD",
    "git show HEAD",
    "git show --stat --no-textconv HEAD",
    "git log -p",
    "git log -pn5",
    "git log --stat --no-textconv",
    "git log --output output",
    "git log --format",
    "git log --format --output=result",
    "git show --pretty --output=result",
    "git diff -U --output=result",
    "rg --regexp --pre=helper",
    "git -c core.fsmonitor=helper status",
    "git --git-dir=/tmp status",
    "git -C /tmp status",
    "git clean -fd",
    "git restore source.ts",
    "git branch",
    "git push",
    "git fetch",
    "git reset --hard",
    "/bin/pwd",
    "./git status",
    "git constructor",
    "git log --constructor=output",
  ])("requires review for unsupported or dangerous arguments: %s", (command) => {
    expect(classify(command)).toBe("review");
  });

  test.each([
    "cat ../outside.txt",
    "cat outside-link",
    "head -n 5 /etc/hosts",
    "grep -f ../outside.txt source.ts",
    "rg --file=outside-link result .",
    "git diff -- ../outside.txt",
    "git log ../outside.txt",
    "sed -n '1p' outside-link",
    "find ../ -print",
    "cat missing-file",
  ])("requires review for unverified file operands: %s", (command) => {
    expect(classify(command)).toBe("review");
  });

  test.each(["custom-inspector source.ts", "constructor", "toString"])(
    "does not grant inspection privileges to unknown programs: %s",
    (command) => {
      expect(classify(command)).toBe("unknown");
    },
  );

  test.each([
    "cat source.ts > output",
    "cat $(pwd)",
    "env FLAG=value cat source.ts",
    "if true; then pwd; fi",
    "cat *.ts",
    "cat source.ts &",
    "pwd\n",
  ])("does not widen the literal shell grammar: %s", (command) => {
    expect(classify(command)).not.toBe("inspection");
  });

  test("resolves each operand once per workspace path checker", async () => {
    const isWorkspacePath = createWorkspacePathChecker(workspace);
    expect(isWorkspacePath("source.ts")).toBe(true);
    await rm(join(workspace, "source.ts"));
    expect(isWorkspacePath("source.ts")).toBe(true);
    expect(createWorkspacePathChecker(workspace)("source.ts")).toBe(false);
  });
});
