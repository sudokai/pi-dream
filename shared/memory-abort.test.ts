import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  composeMemoryAbortSignal,
  isMemoryQueryBlank,
} from "./memory-abort.ts";

test("composeMemoryAbortSignal times out while leaving the parent signal open", async () => {
  const parent = new AbortController();
  const signal = composeMemoryAbortSignal(parent.signal, 20);
  await new Promise<void>((resolve, reject) => {
    const fail = setTimeout(
      () => reject(new Error("composed abort timeout did not fire")),
      250,
    );
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(fail);
        resolve();
      },
      { once: true },
    );
  });
  assert.equal(signal.aborted, true);
  assert.equal(parent.signal.aborted, false);
});

test("isMemoryQueryBlank treats whitespace-only input as blank", () => {
  assert.equal(isMemoryQueryBlank(""), true);
  assert.equal(isMemoryQueryBlank(" \n\t"), true);
  assert.equal(isMemoryQueryBlank("remember"), false);
});
