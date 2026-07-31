/**
 * Redact sensitive values before learner model input.
 */

const REDACTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> =
  [
    {
      pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
      replacement: "[REDACTED_BEARER_TOKEN]",
    },
    {
      pattern:
        /\b(?:api[_-]?key|apikey|token|secret|password|passwd|authorization)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi,
      replacement: "[REDACTED_SECRET]",
    },
    {
      pattern: /\bsk-[A-Za-z0-9]{16,}\b/g,
      replacement: "[REDACTED_API_KEY]",
    },
    {
      pattern:
        /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
      replacement: "[REDACTED_PRIVATE_KEY]",
    },
    {
      pattern: /\b(?:postgres|mysql|mongodb)(?:\+srv)?:\/\/[^\s'"]+/gi,
      replacement: "[REDACTED_CONNECTION_STRING]",
    },
    {
      pattern: /\bCookie:\s*[^\n]+/gi,
      replacement: "Cookie: [REDACTED_COOKIE]",
    },
    {
      pattern: /\bSet-Cookie:\s*[^\n]+/gi,
      replacement: "Set-Cookie: [REDACTED_COOKIE]",
    },
  ];

/** Redact obvious secrets from free text while preserving surrounding structure. */
export function redactMemorySensitiveText(text: string): string {
  let out = text;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
