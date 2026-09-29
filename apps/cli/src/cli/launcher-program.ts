import { Command, CommanderError } from "commander";

import { BUILD_INFO } from "../build-info.ts";
import { LAUNCHER_EXIT_STATUS } from "../launcher/exit-status.ts";
import { PRODUCT_IDENTITY } from "../product/identity.ts";
import { resolveDeputyDevPaths } from "../product/paths.ts";
import { type AuthLoginOptions, runAuthLogin, runAuthStatus } from "./commands/auth.ts";
import { runDoctor } from "./commands/doctor.ts";
import { printHarnesses } from "./commands/harnesses.ts";
import { printPaths } from "./commands/paths.ts";
import { runSetup, type SetupOptions } from "./commands/setup.ts";
import { runUninstall, type UninstallOptions } from "./commands/uninstall.ts";

function setExitStatus(status: number): void {
  if (status !== 0) {
    process.exitCode = status;
  }
}

function createLauncherProgram(): Command {
  const program = new Command();
  program
    .name(PRODUCT_IDENTITY.command)
    .description(`${PRODUCT_IDENTITY.displayName} managed harness launcher`)
    .usage("<harness> [harness arguments...] | <command> [options]")
    .helpOption("-h, --help", "display launcher help")
    .version(BUILD_INFO.version, "-V, --version", "display launcher version")
    .showHelpAfterError()
    .exitOverride();

  program
    .command("harnesses")
    .description("list supported harness IDs and aliases")
    .action(() => {
      printHarnesses();
    });

  program
    .command("paths")
    .description("show managed DeputyDev paths")
    .action(() => {
      printPaths(resolveDeputyDevPaths());
    });

  const auth = program.command("auth").description("manage the local DeputyDev session");
  auth
    .command("login")
    .description("sign in to DeputyDev from your browser")
    .option("--browser", "open the browser without a selection prompt")
    .action(async (options: AuthLoginOptions) => {
      await runAuthLogin(resolveDeputyDevPaths(), options);
    });
  auth
    .command("status")
    .description("check whether a local encrypted session is saved")
    .action(async () => {
      await runAuthStatus(resolveDeputyDevPaths());
    });

  program
    .command("doctor")
    .description("diagnose the launcher and installed harnesses")
    .argument("[harness]", "stable harness ID or alias")
    .action(async (harness: string | undefined) => {
      const environment = process.env;
      const status = await runDoctor(
        {
          cwd: process.cwd(),
          environment,
          paths: resolveDeputyDevPaths(environment),
        },
        harness,
      );
      setExitStatus(status);
    });

  program
    .command("setup")
    .description("prepare a managed harness")
    .argument("<harness>", "stable harness ID (currently pi)")
    .option("--sync-packages", "install or repair required packages")
    .action(async (harness: string, options: SetupOptions) => {
      await runSetup(harness, options);
    });

  program
    .command("uninstall")
    .description("remove the managed binary while preserving user data by default")
    .option("--remove-runtimes", "also remove cached immutable runtimes")
    .option(
      "--remove-profiles",
      "also remove launcher profiles; shared auth in uuid.json is preserved",
    )
    .action(async (options: UninstallOptions) => {
      await runUninstall(resolveDeputyDevPaths(), options);
    });

  program.addHelpText(
    "after",
    `\nHarnesses:\n  ${PRODUCT_IDENTITY.command} pi [pi arguments...]\n  ${PRODUCT_IDENTITY.command} opencode [opencode arguments...]\n  ${PRODUCT_IDENTITY.command} opencode2 [opencode arguments...]  (compatibility alias)\n\nEverything after a harness ID is passed to that harness without launcher parsing.`,
  );

  return program;
}

export async function runLauncherProgram(argumentsVector: readonly string[]): Promise<void> {
  const program = createLauncherProgram();

  if (argumentsVector.length === 0) {
    program.outputHelp();
    return;
  }

  try {
    await program.parseAsync([...argumentsVector], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0) {
        process.exitCode = LAUNCHER_EXIT_STATUS.usage;
      }
      return;
    }

    throw error;
  }
}
