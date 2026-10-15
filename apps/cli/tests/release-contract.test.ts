import { describe, expect, test } from "bun:test";

import {
  formatCliReleaseTag,
  isCanonicalSemVer,
  isCliReleaseTag,
  parseCliReleaseTag,
} from "../scripts/release-contract.ts";
import { PRODUCT_IDENTITY } from "../src/product/identity.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";
import { parseServiceOrigin } from "../src/product/service-origin.ts";

describe("release version contract", () => {
  test("accepts canonical stable and prerelease versions", () => {
    expect(isCanonicalSemVer("0.1.0")).toBe(true);
    expect(isCanonicalSemVer("0.1.0-rc.1")).toBe(true);
    expect(isCanonicalSemVer("1.2.3-alpha.1+build.5")).toBe(true);
  });

  test("rejects prefixes and non-canonical numeric identifiers", () => {
    expect(isCanonicalSemVer("v0.1.0")).toBe(false);
    expect(isCanonicalSemVer("01.1.0")).toBe(false);
    expect(isCanonicalSemVer("1.0.0-01")).toBe(false);
    expect(isCanonicalSemVer("1.0")).toBe(false);
  });
});

describe("CLI release tag contract", () => {
  test("namespaces CLI tags so other monorepo components cannot collide", () => {
    expect(formatCliReleaseTag("0.2.0")).toBe("cli-0.2.0");
    expect(parseCliReleaseTag("cli-0.2.0")).toBe("0.2.0");
    expect(parseCliReleaseTag("cli-0.2.0-rc.1")).toBe("0.2.0-rc.1");
    expect(isCliReleaseTag("cli-0.2.0")).toBe(true);
  });

  test("rejects bare, v-prefixed, and foreign component tags", () => {
    expect(isCliReleaseTag("0.2.0")).toBe(false);
    expect(isCliReleaseTag("cli-v0.2.0")).toBe(false);
    expect(isCliReleaseTag("backend-0.2.0")).toBe(false);
    expect(() => parseCliReleaseTag("backend-0.2.0")).toThrow(/must start with cli-/);
    expect(() => parseCliReleaseTag("cli-01.0.0")).toThrow(/canonical semantic version/);
    expect(() => formatCliReleaseTag("v0.2.0")).toThrow(/canonical semantic version/);
  });
});

describe("production service base URL contract", () => {
  test("accepts an HTTPS origin", () => {
    expect(parseServiceOrigin("https://cli.example.test:8443", { allowLoopbackHttp: false })).toBe(
      "https://cli.example.test:8443",
    );
  });

  test.each([
    "https://deputydev.ai/axon",
    "https://cli.example.test:8443/services/axon-prod_v1.0~beta",
  ])("preserves the deployment base path in %s", (base) => {
    expect(parseServiceOrigin(base, { allowLoopbackHttp: false })).toBe(base);
  });

  test("normalizes the origin without discarding its base path", () => {
    expect(
      parseServiceOrigin("https://CLI.EXAMPLE.TEST:443/axon", { allowLoopbackHttp: false }),
    ).toBe("https://cli.example.test/axon");
  });

  test.each(["http://localhost:3000/axon", "http://127.0.0.1:3000/axon", "http://[::1]:3000/axon"])(
    "allows loopback HTTP base paths only in development: %s",
    (base) => {
      expect(parseServiceOrigin(base, { allowLoopbackHttp: true })).toBe(base);
      expect(() => parseServiceOrigin(base, { allowLoopbackHttp: false })).toThrow(
        "must use HTTPS",
      );
    },
  );

  test.each([
    "http://cli.example.test/axon",
    "https://cli.example.test/",
    "https://cli.example.test/axon/",
    "https://user:password@cli.example.test/axon",
    "https://cli.example.test/axon?",
    "https://cli.example.test/axon#",
    "https://cli.example.test/axon?url=https://evil.test",
    "https://cli.example.test/axon#other",
    "https://cli.example.test/axon//nested",
    "https://cli.example.test/axon/../other",
    "https://cli.example.test/axon/./nested",
    "https://cli.example.test/axon/%2e%2e/other",
    "https://cli.example.test/axon%2fother",
    "https://cli.example.test/axon%5cother",
    "https://cli.example.test/axon\\\\other",
    " https://cli.example.test/axon",
    "https://cli.example.test/axon\n",
    "https://cli.example.test/axon\u0000",
    "https://cli.example.test/axon path",
    "https:cli.example.test/axon",
    "/axon",
  ])("rejects unsafe or ambiguous service base URL %j", (base) => {
    expect(() => parseServiceOrigin(base, { allowLoopbackHttp: false })).toThrow();
  });
});

describe("axon command identity", () => {
  test("uses the Axon product, command, and managed home consistently", () => {
    const paths = resolveAxonPaths({}, "/Users/example");

    expect(PRODUCT_IDENTITY.applicationId).toBe("axon");
    expect(PRODUCT_IDENTITY.displayName).toBe("Axon");
    expect(PRODUCT_IDENTITY.command).toBe("axon");
    expect(PRODUCT_IDENTITY.homeEnvironmentVariable).toBe("AXON_HOME");
    expect(PRODUCT_IDENTITY.defaultHomeDirectoryName).toBe(".axon");
    expect(paths.home).toBe("/Users/example/.axon");
    expect(paths.managedBinary).toBe("/Users/example/.axon/bin/axon");
    expect(paths.previousBinary).toBe("/Users/example/.axon/bin/axon.prev");
    expect(paths.stagedBinary).toBe("/Users/example/.axon/staged/axon");
    expect(paths.piSessions).toBe("/Users/example/.axon/pi/sessions");
  });

  test("derives managed paths from AXON_HOME", () => {
    const paths = resolveAxonPaths({ AXON_HOME: " /tmp/axon-custom " }, "/Users/example");

    expect(paths.home).toBe("/tmp/axon-custom");
    expect(paths.managedBinary).toBe("/tmp/axon-custom/bin/axon");
    expect(paths.previousBinary).toBe("/tmp/axon-custom/bin/axon.prev");
    expect(paths.stagedBinary).toBe("/tmp/axon-custom/staged/axon");
    expect(paths.piSessions).toBe("/tmp/axon-custom/pi/sessions");
  });
});
