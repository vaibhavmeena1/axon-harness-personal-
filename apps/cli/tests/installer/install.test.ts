import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const installerPath = join(repositoryRoot, "install.sh");
const fixtureRoots: string[] = [];

interface FixtureOptions {
  readonly archiveIsCorrupt?: boolean;
  readonly binaryVersion?: string;
  readonly checksums?: string;
  readonly releaseVersion?: string;
}

interface InstallerFixture {
  readonly home: string;
  readonly managedHome: string;
  readonly mockBin: string;
  readonly releaseDirectory: string;
  readonly releaseVersion: string;
  readonly requestLog: string;
  readonly root: string;
}

interface InstallerResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await Bun.write(path, contents);
  await chmod(path, 0o755);
}

async function createFixture(options: FixtureOptions = {}): Promise<InstallerFixture> {
  const root = await mkdtemp(join(tmpdir(), "ddcli-installer-"));
  fixtureRoots.push(root);
  const releaseVersion = options.releaseVersion ?? "0.1.0";
  const releaseDirectory = join(root, "release");
  const exactReleaseDirectory = join(releaseDirectory, releaseVersion);
  const mockBin = join(root, "mock-bin");
  const home = join(root, "home");
  const managedHome = join(home, ".deputydev");
  const requestLog = join(root, "requests.log");
  await Promise.all([
    mkdir(exactReleaseDirectory, { recursive: true }),
    mkdir(mockBin, { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);

  const binaryVersion = options.binaryVersion ?? releaseVersion;
  const binaryBytes = new TextEncoder().encode(
    `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then\n  printf '%s\\n' '${binaryVersion}'\n  exit 0\nfi\nexit 64\n`,
  );
  const archiveBytes = options.archiveIsCorrupt
    ? new TextEncoder().encode("this is not gzip data")
    : Bun.gzipSync(binaryBytes);
  const checksums =
    options.checksums ??
    `${sha256(archiveBytes)}  ddcli-darwin-arm64.gz\n${sha256(binaryBytes)}  ddcli-darwin-arm64\n`;

  await Promise.all([
    Bun.write(join(releaseDirectory, "VERSION"), `${releaseVersion}\n`),
    Bun.write(join(exactReleaseDirectory, "ddcli-darwin-arm64.gz"), archiveBytes),
    Bun.write(join(exactReleaseDirectory, "checksums.txt"), checksums),
    Bun.write(requestLog, ""),
  ]);

  await Promise.all([
    writeExecutable(
      join(mockBin, "uname"),
      `#!/bin/sh\ncase "\${1:-}" in\n  -s) printf '%s\\n' "\${MOCK_UNAME_S:-Darwin}" ;;\n  -m) printf '%s\\n' "\${MOCK_UNAME_M:-arm64}" ;;\n  *) exit 2 ;;\nesac\n`,
    ),
    writeExecutable(join(mockBin, "codesign"), "#!/bin/sh\nexit 0\n"),
    writeExecutable(
      join(mockBin, "node"),
      `#!/bin/sh\n[ "\${MOCK_NODE_OLD:-0}" != 1 ] || exit 1\nexit 0\n`,
    ),
    writeExecutable(join(mockBin, "npm"), "#!/bin/sh\nprintf '10.0.0\\n'\n"),
    writeExecutable(
      join(mockBin, "curl"),
      `#!/bin/sh
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      shift
      output=$1
      ;;
    https://*) url=$1 ;;
  esac
  shift
done
[ -n "$output" ] && [ -n "$url" ] || exit 2
printf '%s\\n' "$url" >> "$MOCK_CURL_LOG"
asset=\${url##*/}
if [ "\${MOCK_CURL_FAIL_ASSET:-}" = "$asset" ]; then
  exit 22
fi
case "$url" in
  "$MOCK_RELEASES_URL/latest/VERSION") source_file="$MOCK_RELEASE_DIR/VERSION" ;;
  "$MOCK_RELEASES_URL/$MOCK_RELEASE_VERSION/"*) source_file="$MOCK_RELEASE_DIR/$MOCK_RELEASE_VERSION/$asset" ;;
  *) exit 22 ;;
esac
cp "$source_file" "$output"
`,
    ),
  ]);

  return {
    home,
    managedHome,
    mockBin,
    releaseDirectory,
    releaseVersion,
    requestLog,
    root,
  };
}

async function runInstaller(
  fixture: InstallerFixture,
  environment: Record<string, string> = {},
): Promise<InstallerResult> {
  const releasesUrl = "https://fixtures.invalid/api/v1/cli/releases";
  const subprocess = Bun.spawn(["/bin/sh", installerPath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: `${fixture.mockBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      container: "",
      _DDCLI_RELEASES_URL: releasesUrl,
      MOCK_RELEASES_URL: releasesUrl,
      MOCK_RELEASE_DIR: fixture.releaseDirectory,
      MOCK_RELEASE_VERSION: fixture.releaseVersion,
      MOCK_CURL_LOG: fixture.requestLog,
      ...environment,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { exitCode, stderr, stdout };
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("install.sh platform and prerequisites", () => {
  test("has valid POSIX shell syntax", async () => {
    const subprocess = Bun.spawn(["/bin/sh", "-n", installerPath]);
    expect(await subprocess.exited).toBe(0);
  });

  test("rejects non-macOS hosts", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture, { MOCK_UNAME_S: "Linux" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("macOS is required");
  });

  test("rejects unsupported macOS architectures", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture, { MOCK_UNAME_M: "x86_64" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Apple Silicon arm64 is required");
  });

  test("accepts Node.js and npm before downloading", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Node.js 22.19+ and npm are available for Pi.");
  });

  test("stops before downloading when Node.js is too old and the installer is non-interactive", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture, { MOCK_NODE_OLD: "1" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Pi requires Node.js 22.19+ and npm");
    expect(await Bun.file(fixture.requestLog).text()).toBe("");
  });

  test("stops before downloading when npm is missing", async () => {
    const fixture = await createFixture();
    await rm(join(fixture.mockBin, "npm"));
    const result = await runInstaller(fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Pi requires Node.js 22.19+ and npm");
    expect(await Bun.file(fixture.requestLog).text()).toBe("");
  });

  test("reports a missing required tool", async () => {
    const fixture = await createFixture();
    await rm(join(fixture.mockBin, "curl"));
    const result = await runInstaller(fixture, { PATH: fixture.mockBin });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("required tool is not available: curl");
  });
});

describe("install.sh verified installation", () => {
  test("downloads from one exact release and installs without sudo", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture);
    const installedPath = join(fixture.managedHome, "bin", "ddcli");
    const requests = await Bun.file(fixture.requestLog).text();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Installed ddcli 0.1.0 at ${installedPath}`);
    expect(await Bun.file(installedPath).text()).toContain("0.1.0");
    expect(requests).toContain("/latest/VERSION");
    expect(requests).toContain("/0.1.0/checksums.txt");
    expect(requests).toContain("/0.1.0/ddcli-darwin-arm64.gz");
    expect(requests).not.toContain("/latest/checksums.txt");
  });

  test("fails when an exact-release download fails", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture, { MOCK_CURL_FAIL_ASSET: "checksums.txt" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("could not download checksums.txt");
  });

  test("rejects a compressed hash mismatch", async () => {
    const fixture = await createFixture({
      checksums: `${"0".repeat(64)}  ddcli-darwin-arm64.gz\n${"1".repeat(64)}  ddcli-darwin-arm64\n`,
    });
    const result = await runInstaller(fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("compressed SHA-256 mismatch");
  });

  test("rejects corrupt gzip after verifying its published hash", async () => {
    const fixture = await createFixture({ archiveIsCorrupt: true });
    const result = await runInstaller(fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not valid gzip data");
  });

  test("rejects a binary version mismatch", async () => {
    const fixture = await createFixture({ binaryVersion: "0.1.1" });
    const result = await runInstaller(fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reports 0.1.1, expected 0.1.0");
  });

  test("preserves an existing installation and atomically replaces it", async () => {
    const fixture = await createFixture();
    const binDirectory = join(fixture.managedHome, "bin");
    const installedPath = join(binDirectory, "ddcli");
    await mkdir(binDirectory, { recursive: true });
    await Bun.write(installedPath, "old installation\n");
    await chmod(installedPath, 0o755);

    const result = await runInstaller(fixture);
    const temporaryFiles = (await readdir(binDirectory)).filter((name) =>
      name.startsWith(".ddcli-"),
    );

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(binDirectory, "ddcli.prev")).text()).toBe("old installation\n");
    expect(await Bun.file(installedPath).text()).toContain("0.1.0");
    expect(temporaryFiles).toEqual([]);
  });

  test("honors DEPUTYDEV_HOME", async () => {
    const fixture = await createFixture();
    const customHome = join(fixture.root, "custom deputydev home");
    const result = await runInstaller(fixture, { DEPUTYDEV_HOME: customHome });

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(customHome, "bin", "ddcli")).exists()).toBe(true);
    expect(await Bun.file(join(fixture.managedHome, "bin", "ddcli")).exists()).toBe(false);
  });

  test("prints an exact PATH instruction when the managed bin is absent", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`${fixture.managedHome}/bin is not on PATH`);
    expect(result.stdout).toContain(`export PATH="${fixture.managedHome}/bin:$PATH"`);
    expect(result.stdout).toContain("After updating PATH, run: ddcli doctor");
  });
});
