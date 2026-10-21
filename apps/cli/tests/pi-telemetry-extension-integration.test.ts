import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { saveEncryptedSession } from "../src/cli/auth/session.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const piExecutable = join(repositoryRoot, "node_modules", ".bin", "pi");
const telemetryExtension = join(
  repositoryRoot,
  "src",
  "harnesses",
  "pi",
  "resources",
  "extensions",
  "pi-org-telemetry.mjs",
);
const temporaryDirectories: string[] = [];
// Native Node/Pi cold starts can exceed Bun's default 5s on Intel CI runners.
// Keep subprocess deadlines inside the test deadline, leaving time for cleanup.
const subprocessTimeoutMs = 10_000;
const integrationTimeoutMs = 20_000;

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected a TCP server address"));
        return;
      }
      resolvePort(address.port);
    });
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function runPi(
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> {
  const home = await mkdtemp(join(tmpdir(), "axon-pi-telemetry-e2e-"));
  temporaryDirectories.push(home);
  const subprocess = Bun.spawn(
    [
      piExecutable,
      "--offline",
      "--no-extensions",
      "--extension",
      telemetryExtension,
      "--list-models",
    ],
    {
      cwd: repositoryRoot,
      env: {
        HOME: home,
        PATH: Reflect.get(process.env, "PATH") ?? "",
        PI_CODING_AGENT_DIR: join(home, "pi"),
        PI_CODING_AGENT_SESSION_DIR: join(home, "pi", "sessions"),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        ...extraEnvironment,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: subprocessTimeoutMs,
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Pi telemetry extension integration", () => {
  test(
    "standalone bundle exports authenticated telemetry under native Node",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "axon-native-otel-"));
      temporaryDirectories.push(home);
      await saveEncryptedSession(
        resolveAxonPaths({ AXON_HOME: home, HOME: home }),
        "native-session",
      );
      const seen: Array<{ path: string; auth: string | undefined; body: Buffer }> = [];
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          seen.push({
            path: request.url ?? "",
            auth: request.headers.authorization,
            body: Buffer.concat(chunks),
          });
          response.writeHead(200, { "content-type": "application/x-protobuf" }).end();
        });
      });
      const port = await listen(server);
      const script = `
      const {default: extension} = await import(${JSON.stringify(telemetryExtension)});
      const handlers = new Map();
      extension({on: (name,handler) => {handlers.set(name,handler); return () => {};}});
      const ctx = {cwd: process.env.HOME, mode: "json", hasUI: false, sessionManager: {getSessionId: () => "native-node", getSessionFile: () => undefined}};
      await handlers.get("session_start")({reason:"startup"},ctx);
      for (const event of [
        {messageType:"user",prompt:"private-user-content",systemPrompt:""},
        {messageType:"custom",message:{role:"custom",customType:"task",content:"private-custom-content",display:false,timestamp:Date.now()},systemPrompt:""},
      ]) {
        await handlers.get("before_agent_start")(event,ctx);
        await handlers.get("agent_start")({},ctx);
        await handlers.get("turn_start")({turnIndex:0},ctx);
        await handlers.get("turn_end")({message:{role:"assistant",stopReason:"stop"},toolResults:[]},ctx);
        await handlers.get("agent_end")({messages:[]},ctx);
        await handlers.get("agent_settled")({},ctx);
      }
      await handlers.get("session_shutdown")({reason:"quit"},ctx);
    `;
      let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
      try {
        child = Bun.spawn(["node", "--input-type=module", "--eval", script], {
          cwd: repositoryRoot,
          env: {
            HOME: home,
            PATH: Reflect.get(process.env, "PATH") ?? "",
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
            PI_ORG_OTEL_DIAGNOSTICS: "true",
            PI_ORG_OTEL_MANAGED_HOME: home,
            PI_ORG_OTEL_MANAGED_ENDPOINT: `http://127.0.0.1:${port}/api/v1/otel`,
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}/api/v1/otel`,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: subprocessTimeoutMs,
        });
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        expect(new Set(seen.map((request) => request.path))).toEqual(
          new Set(["/api/v1/otel/v1/traces", "/api/v1/otel/v1/metrics", "/api/v1/otel/v1/logs"]),
        );
        for (const request of seen) {
          expect(request.auth).toBe("Bearer native-session");
          expect(request.body.includes(Buffer.from("native-session"))).toBe(false);
          expect(request.body.includes(Buffer.from("axon_auth"))).toBe(true);
          expect(request.body.includes(Buffer.from("private-user-content"))).toBe(false);
          expect(request.body.includes(Buffer.from("private-custom-content"))).toBe(false);
          expect(request.body.includes(Buffer.from("pi.telemetry.dropped"))).toBe(false);
        }
      } finally {
        if (child) {
          child.kill();
          await child.exited;
        }
        await close(server);
      }
    },
    integrationTimeoutMs,
  );

  test(
    "loads in the managed Pi version without an OTLP endpoint",
    async () => {
      const result = await runPi();
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.length).toBeGreaterThan(0);
    },
    integrationTimeoutMs,
  );

  test(
    "does no OTLP network work when no endpoint is configured",
    async () => {
      let requests = 0;
      const server = createServer((request, response) => {
        requests += 1;
        request.resume();
        response.writeHead(200).end();
      });
      const port = await listen(server);
      try {
        const result = await runPi({
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(requests).toBe(0);
      } finally {
        await close(server);
      }
    },
    integrationTimeoutMs,
  );
});
