import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MEMORY_DIR_MODE,
  MEMORY_FILE_MODE,
  ensureMemorySecureDir,
  writeMemorySecureFileAtomic,
} from "./memory-fs.ts";

test("ensureMemorySecureDir creates directories with mode 0700", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-secure-dir-"));
  try {
    const nested = path.join(dir, "nested");
    ensureMemorySecureDir(nested);
    assert.equal(fs.statSync(nested).mode & 0o777, MEMORY_DIR_MODE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeMemorySecureFileAtomic writes complete contents with mode 0600", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-secure-file-"));
  try {
    const filePath = path.join(dir, "config.json");
    writeMemorySecureFileAtomic(filePath, '{"enabled":false}\n');
    assert.equal(fs.readFileSync(filePath, "utf-8"), '{"enabled":false}\n');
    assert.equal(fs.statSync(filePath).mode & 0o777, MEMORY_FILE_MODE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
