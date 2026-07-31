import { test } from "node:test";
import * as assert from "node:assert/strict";
import { redactMemorySensitiveText } from "./memory-redaction.ts";

test("redactMemorySensitiveText removes bearer tokens and api keys", () => {
  const input =
    "Authorization: Bearer abcdefghijklmnop and sk-1234567890abcdef";
  const out = redactMemorySensitiveText(input);
  assert.doesNotMatch(out, /abcdefghijklmnop/);
  assert.doesNotMatch(out, /sk-1234567890abcdef/);
  assert.match(out, /REDACTED/);
});
