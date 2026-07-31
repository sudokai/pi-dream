/**
 * Secure filesystem helpers: restrictive modes and atomic writes.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import * as path from "node:path";

export const MEMORY_DIR_MODE = 0o700;
export const MEMORY_FILE_MODE = 0o600;

/** Create a directory tree with mode 0700 regardless of umask. */
export function ensureMemorySecureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: MEMORY_DIR_MODE });
  }
  try {
    chmodSync(dir, MEMORY_DIR_MODE);
  } catch {
    // chmod may fail on some filesystems; mkdir mode is still set.
  }
}

/** chmod a file to 0600 when possible. */
export function chmodMemorySecureFile(filePath: string): void {
  try {
    chmodSync(filePath, MEMORY_FILE_MODE);
  } catch {
    // Best-effort on platforms that ignore chmod.
  }
}

/**
 * Atomically write UTF-8 text: temp file in the same directory, fsync, rename.
 * Cleans up the temp file when rename fails.
 */
export function writeMemorySecureFileAtomic(
  filePath: string,
  contents: string,
): void {
  const dir = path.dirname(filePath);
  ensureMemorySecureDir(dir);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "w", MEMORY_FILE_MODE);
    const buf = Buffer.from(contents, "utf-8");
    writeSync(fd, buf, 0, buf.length, 0);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, filePath);
    chmodMemorySecureFile(filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failure during error handling
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore temp cleanup failure
    }
    throw err;
  }
}
