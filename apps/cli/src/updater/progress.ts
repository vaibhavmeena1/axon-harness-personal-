import { spinner } from "@clack/prompts";

import type { UpdateProgress } from "./update.ts";

export interface UpdateProgressView {
  readonly report: (progress: UpdateProgress) => void;
  readonly done: () => void;
}

function label({ stage, version }: UpdateProgress): string {
  if (stage === "download") return `Downloading axon ${version}`;
  if (stage === "verify") return `Verifying axon ${version}`;
  return "Checking for axon updates";
}

/** A transient spinner for terminals; undefined for pipes and CI so scripted output is unchanged. */
export function updateProgressView(): UpdateProgressView | undefined {
  if (!process.stdout.isTTY || process.env["CI"]) return undefined;
  // The spinner's SIGINT listener would otherwise swallow Ctrl+C for the rest of the update.
  // Without the guide bar, clear() leaves no trace once the outcome is printed.
  const indicator = spinner({ withGuide: false, onCancel: () => process.exit(130) });
  let started = false;
  return {
    report: (progress) => {
      if (started) {
        indicator.message(label(progress));
      } else {
        indicator.start(label(progress));
        started = true;
      }
    },
    // Callers print the outcome themselves, so the spinner only ever clears.
    done: () => {
      if (started) indicator.clear();
    },
  };
}

export async function withUpdateProgress<T>(
  run: (onProgress?: (progress: UpdateProgress) => void) => Promise<T>,
  view: UpdateProgressView | undefined = updateProgressView(),
): Promise<T> {
  try {
    return await run(view?.report);
  } finally {
    view?.done();
  }
}
