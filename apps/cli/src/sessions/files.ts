import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid())
  ) {
    throw new Error("Unsafe backup directory");
  }
  await chmod(path, 0o700);
}

export async function assertInside(root: string, path: string): Promise<void> {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Session is outside managed storage");
  let parent = resolve(root);
  for (const part of ["", ...rel.split(/[\\/]/).slice(0, -1)]) {
    parent = join(parent, part);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Symlinked session directory");
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Session is not a regular file");
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path));
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temp, { force: true });
  }
}

export async function readJson(path: string): Promise<unknown | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("Could not safely read backup state");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024) throw new Error("Invalid backup state");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

export async function fileIntegrity(
  path: string,
  maximum: number,
): Promise<{ hash: string; size: number }> {
  const hasher = createHash("sha256");
  let size = 0;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      size += bytes.length;
      if (size > maximum) throw new Error("Session exceeds backup size limit");
      hasher.update(bytes);
    }
  } finally {
    await handle.close();
  }
  return { hash: hasher.digest("hex"), size };
}

export { readFile };
