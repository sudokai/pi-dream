/**
 * Recall completions through pi's supported pi-ai provider path.
 *
 * The extension-facing ModelRegistry is a synchronous compatibility facade
 * (find / getProvider / getApiKeyAndHeaders); it does NOT expose
 * completeSimple — that lives on internal ModelRuntime. Model calls therefore
 * go through the effective pi-ai Provider's streamSimple + EventStream.result()
 * with auth resolved via getApiKeyAndHeaders.
 */

import type {
  Context,
  SimpleStreamOptions,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import type {
  MemoryAuthResultLike,
  MemoryModelRegistryLike,
  ResolvedMemoryModel,
} from "./memory-model.ts";
import type { MemoryThinkingLevel } from "./memory-config.ts";
import { extractMemoryModelText } from "./memory-model.ts";
import {
  MEMORY_AUTH_TIMEOUT_MS,
  MEMORY_COMPLETION_TIMEOUT_MS,
} from "./memory-types.ts";
import { raceMemoryOperation } from "./memory-abort.ts";

export interface MemoryCompletionInput {
  system: string;
  user: string;
  signal?: AbortSignal;
}

export interface MemoryCompletionResult {
  text: string;
  usage?: unknown;
}

/**
 * Map a memory config thinking level to pi's SimpleStreamOptions.reasoning.
 * "off" (and unset) omit the key entirely; non-reasoning models clamp it.
 */
export function memoryThinkingLevelToReasoning(
  level: MemoryThinkingLevel | undefined,
): ThinkingLevel | undefined {
  if (level === undefined || level === "off") return undefined;
  return level;
}

/**
 * Complete one recall call (planner) through the provider's streamSimple.
 * Fail-closed: missing provider, unresolved auth, stream errors, and model
 * errorMessage all reject instead of returning empty output.
 */
export async function completeMemoryModelCall(
  registry: MemoryModelRegistryLike,
  resolved: ResolvedMemoryModel,
  input: MemoryCompletionInput,
): Promise<MemoryCompletionResult> {
  const provider = registry.getProvider?.(resolved.provider);
  if (!provider || typeof provider.streamSimple !== "function") {
    throw new Error(
      `Model registry does not expose provider "${resolved.provider}" for recall model ${resolved.modelId}`,
    );
  }

  let auth: MemoryAuthResultLike | undefined;
  if (typeof registry.getApiKeyAndHeaders === "function") {
    auth = await raceMemoryOperation(
      registry.getApiKeyAndHeaders(resolved.model),
      input.signal,
      MEMORY_AUTH_TIMEOUT_MS,
    );
    if (auth && !auth.ok) {
      throw new Error(
        `No API key for recall model ${resolved.modelId}: ${auth.error}`,
      );
    }
  }

  const options: SimpleStreamOptions = { signal: input.signal };
  const reasoning = memoryThinkingLevelToReasoning(resolved.thinking);
  if (reasoning !== undefined) options.reasoning = reasoning;
  if (auth?.ok) {
    options.apiKey = auth.apiKey;
    options.headers = auth.headers;
    options.env = auth.env;
  }

  const context: Context = {
    systemPrompt: input.system,
    messages: [
      {
        role: "user",
        content: input.user,
        timestamp: Date.now(),
      },
    ],
  };
  const stream = provider.streamSimple(resolved.model, context, options);
  if (!stream || typeof stream.result !== "function") {
    throw new Error(
      `Provider "${resolved.provider}" streamSimple returned an invalid stream`,
    );
  }

  const message = await raceMemoryOperation(
    stream.result(),
    input.signal,
    MEMORY_COMPLETION_TIMEOUT_MS,
  );
  if (message.errorMessage) {
    throw new Error(message.errorMessage);
  }
  return {
    text: extractMemoryModelText({ content: message.content }),
    usage: message.usage,
  };
}
