/** macOS targets that every release publishes a native binary for. */
export const RELEASE_TARGETS = ["darwin-arm64", "darwin-x64"] as const;

export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

/**
 * Launchers released before x64 support read only `checksums.txt`, and expect it to
 * hold exactly the darwin-arm64 hashes. Keep publishing that file unchanged.
 */
export const LEGACY_CHECKSUMS_NAME = "checksums.txt";
export const LEGACY_CHECKSUMS_TARGET: ReleaseTarget = "darwin-arm64";

/** Architecture names reported by `lipo -archs` for a single-architecture binary. */
export const LIPO_ARCHITECTURES: Readonly<Record<ReleaseTarget, string>> = Object.freeze({
  "darwin-arm64": "arm64",
  "darwin-x64": "x86_64",
});

export interface ReleaseAssetNames {
  readonly binary: string;
  readonly archive: string;
  readonly checksums: string;
  readonly sourceMap: string;
}

export function isReleaseTarget(value: string): value is ReleaseTarget {
  return (RELEASE_TARGETS as readonly string[]).includes(value);
}

/** The release target that runs natively in this process, if one is published. */
export function hostReleaseTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): ReleaseTarget | undefined {
  const target = `${platform}-${arch}`;
  return isReleaseTarget(target) ? target : undefined;
}

export function releaseAssetNames(target: ReleaseTarget): ReleaseAssetNames {
  const binary = `axon-${target}`;
  return {
    binary,
    archive: `${binary}.gz`,
    checksums: `checksums-${target}.txt`,
    sourceMap: `${binary}.map`,
  };
}

/** The two-line checksum file read by the installer and the updater. */
export function formatReleaseChecksums(
  target: ReleaseTarget,
  archiveSha256: string,
  binarySha256: string,
): string {
  const names = releaseAssetNames(target);
  return `${archiveSha256}  ${names.archive}\n${binarySha256}  ${names.binary}\n`;
}
