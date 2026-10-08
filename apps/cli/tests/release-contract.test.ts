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

describe("production service origin contract", () => {
  test("accepts an HTTPS origin only", () => {
    expect(parseServiceOrigin("https://cli.example.test:8443", { allowLoopbackHttp: false })).toBe(
      "https://cli.example.test:8443",
    );
  });

  test("rejects HTTP and URL components beyond the origin", () => {
    expect(() =>
      parseServiceOrigin("http://cli.example.test", { allowLoopbackHttp: false }),
    ).toThrow("must use HTTPS");
    expect(() =>
      parseServiceOrigin("https://cli.example.test/path", { allowLoopbackHttp: false }),
    ).toThrow("only scheme, host, and optional port");
    expect(() =>
      parseServiceOrigin("https://cli.example.test/", { allowLoopbackHttp: false }),
    ).toThrow("must not have a trailing slash");
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
