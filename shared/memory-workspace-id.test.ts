import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  canonicalizeMemoryRemote,
  clearMemoryWorkspaceIdCaches,
  encodeMemorySessionDirName,
  memoryWorkspaceConfigPath,
  memoryWorkspaceDbPath,
  resolveMemoryWorkspaceId,
} from "./memory-workspace-id.ts";

test("canonicalizeMemoryRemote collapses SSH and HTTPS forge URLs", () => {
  const a = canonicalizeMemoryRemote("git@github.com:Org/Repo.git");
  const b = canonicalizeMemoryRemote("https://github.com/org/repo");
  const c = canonicalizeMemoryRemote("https://github.com/Org/Repo.git/");
  assert.equal(a, "github.com/org/repo");
  assert.equal(b, a);
  assert.equal(c, a);
});

test("encodeMemorySessionDirName matches pi session layout", () => {
  assert.equal(
    encodeMemorySessionDirName("/Users/user/Developer/proj"),
    "--Users-user-Developer-proj--",
  );
});

test("resolveMemoryWorkspaceId: same origin → same id across dirs", () => {
  clearMemoryWorkspaceIdCaches();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-ws-"));
  try {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    for (const dir of [a, b]) {
      spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
      spawnSync(
        "git",
        ["remote", "add", "origin", "git@github.com:Acme/Widget.git"],
        { cwd: dir, encoding: "utf8" },
      );
    }
    const idA = resolveMemoryWorkspaceId(a);
    const idB = resolveMemoryWorkspaceId(b);
    assert.equal(idA, idB);
    assert.match(idA, /^[a-f0-9]{12}_/);
    assert.match(idA, /widget/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMemoryWorkspaceId: cwd fallback when not a git repo", () => {
  clearMemoryWorkspaceIdCaches();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-cwd-"));
  try {
    const id = resolveMemoryWorkspaceId(dir);
    assert.match(id, /^[a-f0-9]{12}_/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("memory paths nest under workspace id", () => {
  const db = memoryWorkspaceDbPath("abc123_widget");
  const cfg = memoryWorkspaceConfigPath("abc123_widget");
  assert.ok(db.endsWith(`${path.sep}abc123_widget${path.sep}memory.db`));
  assert.ok(cfg.endsWith(`${path.sep}abc123_widget${path.sep}config.json`));
});
