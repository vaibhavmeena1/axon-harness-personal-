import type { StableHarnessId } from "./contracts.ts";

const SENSITIVE_NAME = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;

export function isTrue(value: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(value ?? "");
}

function redactArguments(argumentsVector: readonly string[]): readonly string[] {
  let redactNext = false;

  return argumentsVector.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }

    const assignmentIndex = argument.indexOf("=");
    if (assignmentIndex > 0) {
      const name = argument.slice(0, assignmentIndex);
      if (SENSITIVE_NAME.test(name)) {
        return `${name}=<redacted>`;
      }
    }

    if (argument.startsWith("-") && SENSITIVE_NAME.test(argument)) {
      redactNext = true;
    }

    return argument;
  });
}

export function printDebugLaunchPreview(input: {
  readonly harness: StableHarnessId;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
}): void {
  console.error(
    `[axon] launch ${JSON.stringify({
      harness: input.harness,
      executable: input.executable,
      arguments: redactArguments(input.arguments),
      cwd: input.cwd,
      environment: "inherited; Axon control variables stripped",
    })}`,
  );
}
