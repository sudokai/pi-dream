/**
 * Model resolution helpers for learning and recall.
 */

import {
  resolveEffectiveMemoryModelId,
  splitMemoryModelId,
  type MemoryThinkingLevel,
  validateOptionalMemoryModel,
} from "./memory-config.ts";

export interface MemoryModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  completeSimple?: (
    model: unknown,
    context: { system?: string; messages: Array<{ role: string; content: string }> },
    options?: { signal?: AbortSignal; thinking?: string },
  ) => Promise<{ content?: unknown; usage?: unknown; text?: string; errorMessage?: string }>;
}

export interface ResolvedMemoryModel {
  modelId: string;
  provider: string;
  modelKey: string;
  model: unknown;
  thinking?: MemoryThinkingLevel;
}

/**
 * Resolve learning or recall model from optional config + current session model.
 * Returns null with error when configured model is invalid or none available.
 */
export function resolveMemoryModel(
  fieldName: string,
  configured: string | undefined,
  currentSessionModelId: string | undefined,
  registry: MemoryModelRegistryLike,
  thinking?: MemoryThinkingLevel,
): { ok: true; resolved: ResolvedMemoryModel } | { ok: false; error: string } {
  const configError = validateOptionalMemoryModel(
    fieldName,
    configured,
    (p, m) => registry.find(p, m),
  );
  if (configError) return { ok: false, error: configError };

  const modelId = resolveEffectiveMemoryModelId(
    configured,
    currentSessionModelId,
  );
  if (!modelId) {
    return {
      ok: false,
      error: `${fieldName}: no configured model and no current session model`,
    };
  }
  const parts = splitMemoryModelId(modelId);
  if (!parts) {
    return {
      ok: false,
      error: `${fieldName} must use provider/model format: ${modelId}`,
    };
  }
  const model = registry.find(parts.provider, parts.modelId);
  if (!model) {
    return {
      ok: false,
      error: `${fieldName} does not resolve to an available model: ${modelId}`,
    };
  }
  return {
    ok: true,
    resolved: {
      modelId,
      provider: parts.provider,
      modelKey: parts.modelId,
      model,
      thinking,
    },
  };
}

/**
 * Extract assistant text from a completeSimple-style response.
 */
export function extractMemoryModelText(result: {
  content?: unknown;
  text?: string;
  errorMessage?: string;
}): string {
  if (result.errorMessage) {
    throw new Error(result.errorMessage);
  }
  if (typeof result.text === "string" && result.text.trim()) {
    return result.text;
  }
  const content = result.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
    return parts.join("");
  }
  return "";
}

/**
 * Format current session model as provider/modelId when possible.
 */
export function formatSessionModelId(
  model: { provider?: string; id?: string } | null | undefined,
): string | undefined {
  if (!model) return undefined;
  const provider = model.provider;
  const id = model.id;
  if (typeof provider === "string" && typeof id === "string" && provider && id) {
    return `${provider}/${id}`;
  }
  return undefined;
}
