/**
 * LLM briefing planner: selects, orders, and groups existing candidate IDs.
 * Never rewrites stored text. Fail-closed on malformed output or invalid IDs.
 */

import {
  MEMORY_BRIEFING_SECTION_LABELS,
  MEMORY_BRIEFING_TOKEN_BUDGET,
  estimateMemoryTextTokens,
  parsePrefixedNodeId,
  type MemoryBriefingPlan,
  type MemoryBriefingSection,
  type MemoryBriefingSectionId,
  type MemoryNodeId,
  type MemorySearchableNodeType,
  type MemorySearchCandidate,
  type SummaryNodeId,
} from "./memory-types.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  getMemoryById,
  getSummaryById,
  listGraphEdgesFrom,
} from "./memory-graph.ts";

const SECTION_IDS = new Set<string>([
  "learned_user_preferences",
  "workspace_knowledge",
  "relevant_summaries",
]);

export interface MemoryPlannerModelResult {
  text: string;
  usage?: unknown;
}

export type MemoryPlannerCompleteFn = (input: {
  system: string;
  user: string;
  signal?: AbortSignal;
}) => Promise<MemoryPlannerModelResult>;

export interface PlanRelevantMemoryBriefingInput {
  query: string;
  candidates: MemorySearchCandidate[];
  tokenBudget?: number;
  complete: MemoryPlannerCompleteFn;
  signal?: AbortSignal;
  /** Optional DB for ancestor-overlap checks (summary contains). */
  db?: DatabaseSync;
  plannerPrompt?: string;
}

export type PlanRelevantMemoryBriefingResult =
  | { ok: true; plan: MemoryBriefingPlan; usage?: unknown }
  | { ok: false; error: string; usage?: unknown };

/** Build the user payload for the briefing planner. */
export function buildMemoryBriefingPlannerUserPayload(
  query: string,
  candidates: MemorySearchCandidate[],
): string {
  const lines = [
    `Opening request:`,
    query.trim() || "(empty)",
    "",
    "Candidates (select only from these IDs; do not rewrite text):",
  ];
  for (const c of candidates) {
    lines.push(
      `- ${c.prefixedId} type=${c.nodeType} kind=${c.kind} heat=${c.heat.toFixed(3)} tokens≈${c.estimatedTokens}`,
      `  text: ${c.text}`,
    );
  }
  lines.push(
    "",
    "Respond with strict JSON only:",
    `{"sections":[{"id":"learned_user_preferences"|"workspace_knowledge"|"relevant_summaries","ids":["M:1","S:2"]}]}`,
    "Rules: only include relevant IDs; prefer a summary over many cold details when appropriate; omit empty sections; never invent IDs or prose.",
  );
  return lines.join("\n");
}

/** Default system prompt for the briefing planner. */
export function defaultMemoryBriefingPlannerSystemPrompt(): string {
  return [
    "You are the memory briefing planner for a coding agent.",
    "Given the user's opening request and candidate memory/summary nodes, select only the relevant existing IDs.",
    "You may group IDs under fixed section ids: learned_user_preferences, workspace_knowledge, relevant_summaries.",
    "You must not rewrite stored text, invent memories, or include IDs that were not provided.",
    "If nothing is relevant, return {\"sections\":[]}.",
    "Output strict JSON only — no markdown fences.",
  ].join(" ");
}

interface ParsedPlannerJson {
  sections: Array<{ id: string; ids: string[] }>;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  // Strip optional markdown fences
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]!.trim() : trimmed;
  return JSON.parse(body);
}

function parsePlannerJson(text: string): ParsedPlannerJson {
  const raw = extractJsonObject(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Planner output must be a JSON object");
  }
  if (!Array.isArray(raw.sections)) {
    throw new Error("Planner output must include a sections array");
  }
  const sections: Array<{ id: string; ids: string[] }> = [];
  for (const s of raw.sections) {
    if (!s || typeof s !== "object") {
      throw new Error("Each section must be an object");
    }
    const sec = s as Record<string, unknown>;
    if (typeof sec.id !== "string" || !SECTION_IDS.has(sec.id)) {
      throw new Error(`Invalid section id: ${String(sec.id)}`);
    }
    if (!Array.isArray(sec.ids)) {
      throw new Error(`Section ${sec.id} ids must be an array`);
    }
    const ids: string[] = [];
    for (const id of sec.ids) {
      if (typeof id !== "string") {
        throw new Error(`Section ${sec.id} contains a non-string id`);
      }
      ids.push(id);
    }
    sections.push({ id: sec.id, ids });
  }
  return { sections };
}

/**
 * Collect every memory/summary id contained by a summary, transitively.
 * Walks the full containment DAG (summary → summary → … → memory) and
 * returns all descendant keys, so ancestor and nested-member overlap is
 * detected at any depth.
 */
function summaryMemberKeys(
  db: DatabaseSync | undefined,
  summaryId: number,
): Set<string> {
  const keys = new Set<string>();
  if (!db) return keys;
  const stack: Array<{ type: MemorySearchableNodeType; id: number }> = [
    { type: "summary", id: summaryId },
  ];
  const seen = new Set<string>([`summary:${summaryId}`]);
  while (stack.length) {
    const node = stack.pop()!;
    const edges = listGraphEdgesFrom(db, node.type, node.id).filter(
      (e) => e.relation === "contains",
    );
    for (const e of edges) {
      const key = `${e.toType}:${e.toId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      keys.add(key);
      if (e.toType === "summary") {
        stack.push({ type: "summary", id: e.toId });
      }
    }
  }
  return keys;
}

/**
 * Validate planner IDs, remove ancestor/member overlap, pack under token budget.
 * Drops complete lowest-priority nodes when over budget (never truncates text).
 */
export function validateAndPackMemoryBriefingPlan(
  candidates: MemorySearchCandidate[],
  parsed: ParsedPlannerJson,
  opts?: { tokenBudget?: number; db?: DatabaseSync },
): MemoryBriefingPlan {
  const budget = opts?.tokenBudget ?? MEMORY_BRIEFING_TOKEN_BUDGET;
  const byId = new Map(
    candidates.map((c) => [c.prefixedId, c] as const),
  );
  const selected: Array<{
    sectionId: MemoryBriefingSectionId;
    candidate: MemorySearchCandidate;
  }> = [];
  const seen = new Set<string>();
  const selectedKeys = new Set<string>();

  for (const section of parsed.sections) {
    const sectionId = section.id as MemoryBriefingSectionId;
    for (const rawId of section.ids) {
      const parsedId = parsePrefixedNodeId(rawId);
      if (!parsedId.ok) {
        throw new Error(parsedId.error);
      }
      if (parsedId.type === "observation") {
        throw new Error(`Planner selected observation id ${rawId}`);
      }
      const candidate = byId.get(parsedId.prefixed as MemoryNodeId | SummaryNodeId);
      if (!candidate) {
        throw new Error(`Planner selected unknown or inactive id ${rawId}`);
      }
      if (seen.has(candidate.prefixedId)) continue;
      // Overlap: skip memory if an ancestor summary already selected
      if (candidate.nodeType === "memory") {
        let covered = false;
        for (const key of selectedKeys) {
          if (!key.startsWith("summary:")) continue;
          const sid = Number(key.slice("summary:".length));
          const members = summaryMemberKeys(opts?.db, sid);
          if (members.has(`memory:${candidate.nodeId}`)) {
            covered = true;
            break;
          }
        }
        if (covered) continue;
      }
      // Overlap: skip summary if an ancestor summary already selected
      if (candidate.nodeType === "summary") {
        let covered = false;
        for (const key of selectedKeys) {
          if (!key.startsWith("summary:")) continue;
          const sid = Number(key.slice("summary:".length));
          if (sid === candidate.nodeId) continue;
          const members = summaryMemberKeys(opts?.db, sid);
          if (members.has(`summary:${candidate.nodeId}`)) {
            covered = true;
            break;
          }
        }
        if (covered) continue;
      }
      // If selecting a summary, drop already-selected members
      if (candidate.nodeType === "summary") {
        const members = summaryMemberKeys(opts?.db, candidate.nodeId);
        for (let i = selected.length - 1; i >= 0; i--) {
          const s = selected[i]!;
          const key = `${s.candidate.nodeType}:${s.candidate.nodeId}`;
          if (members.has(key)) {
            seen.delete(s.candidate.prefixedId);
            selectedKeys.delete(key);
            selected.splice(i, 1);
          }
        }
      }
      seen.add(candidate.prefixedId);
      selectedKeys.add(`${candidate.nodeType}:${candidate.nodeId}`);
      selected.push({ sectionId, candidate });
    }
  }

  // Budget pack: keep order, drop complete lowest-priority (last) nodes if needed
  let total = selected.reduce(
    (sum, s) => sum + s.candidate.estimatedTokens,
    0,
  );
  while (total > budget && selected.length > 0) {
    const removed = selected.pop()!;
    total -= removed.candidate.estimatedTokens;
    seen.delete(removed.candidate.prefixedId);
  }

  const sectionMap = new Map<MemoryBriefingSectionId, MemoryBriefingSection>();
  for (const item of selected) {
    let section = sectionMap.get(item.sectionId);
    if (!section) {
      section = {
        sectionId: item.sectionId,
        label: MEMORY_BRIEFING_SECTION_LABELS[item.sectionId],
        nodes: [],
      };
      sectionMap.set(item.sectionId, section);
    }
    section.nodes.push({
      prefixedId: item.candidate.prefixedId,
      nodeType: item.candidate.nodeType,
      kind: item.candidate.kind,
      text: item.candidate.text,
      heat: item.candidate.heat,
    });
  }

  // Preserve planner section order
  const sections: MemoryBriefingSection[] = [];
  const order: MemoryBriefingSectionId[] = [
    "learned_user_preferences",
    "workspace_knowledge",
    "relevant_summaries",
  ];
  for (const id of order) {
    const s = sectionMap.get(id);
    if (s && s.nodes.length) sections.push(s);
  }

  const selectedIds = selected.map((s) => s.candidate.prefixedId);
  const estimatedTokens = selected.reduce(
    (sum, s) => sum + s.candidate.estimatedTokens,
    0,
  );

  return { sections, estimatedTokens, selectedIds };
}

/**
 * Re-read every selected plan node from the database so rendered text always
 * reflects committed state. Drops nodes that are no longer active or whose
 * text changed since planning. All reads run inside one consistent read
 * transaction.
 */
export function refreshMemoryBriefingPlanNodes(
  db: DatabaseSync,
  plan: MemoryBriefingPlan,
): MemoryBriefingPlan {
  if (plan.sections.length === 0) return plan;
  db.exec("BEGIN");
  try {
    const sections: MemoryBriefingSection[] = [];
    const selectedIds: Array<MemoryNodeId | SummaryNodeId> = [];
    let estimatedTokens = 0;
    for (const section of plan.sections) {
      const nodes: MemoryBriefingSection["nodes"] = [];
      for (const node of section.nodes) {
        const parsed = parsePrefixedNodeId(node.prefixedId);
        if (!parsed.ok) continue;
        const current =
          parsed.type === "memory"
            ? getMemoryById(db, parsed.id)
            : parsed.type === "summary"
              ? getSummaryById(db, parsed.id)
              : null;
        if (!current) continue; // node gone — fail closed
        if (current.state !== "active") continue; // retired/superseded/conflicted
        if (current.text !== node.text) continue; // text changed since planning — drop
        nodes.push({ ...node, text: current.text });
        selectedIds.push(node.prefixedId);
        estimatedTokens += estimateMemoryTextTokens(current.text);
      }
      if (nodes.length) sections.push({ ...section, nodes });
    }
    const refreshed: MemoryBriefingPlan = {
      sections,
      estimatedTokens,
      selectedIds,
    };
    db.exec("COMMIT");
    return refreshed;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nested rollback failure is ignored.
    }
    throw err;
  }
}

/**
 * Call the recall model and validate/pack a briefing plan.
 * Fail-closed: any error returns ok:false with no memories.
 */
export async function planRelevantMemoryBriefing(
  input: PlanRelevantMemoryBriefingInput,
): Promise<PlanRelevantMemoryBriefingResult> {
  if (input.candidates.length === 0) {
    return {
      ok: true,
      plan: { sections: [], estimatedTokens: 0, selectedIds: [] },
    };
  }

  let usage: unknown;
  try {
    const system =
      input.plannerPrompt ?? defaultMemoryBriefingPlannerSystemPrompt();
    const user = buildMemoryBriefingPlannerUserPayload(
      input.query,
      input.candidates,
    );
    const result = await input.complete({
      system,
      user,
      signal: input.signal,
    });
    usage = result.usage;
    if (!result.text || !result.text.trim()) {
      return { ok: false, error: "Planner returned empty output", usage };
    }
    const parsed = parsePlannerJson(result.text);
    const plan = validateAndPackMemoryBriefingPlan(
      input.candidates,
      parsed,
      { tokenBudget: input.tokenBudget, db: input.db },
    );
    return { ok: true, plan, usage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, usage };
  }
}

/** Format a validated briefing plan as visible message content. */
export function formatMemoryBriefingMessage(plan: MemoryBriefingPlan): string {
  if (plan.sections.length === 0) return "";
  const lines: string[] = ["# Workspace memory briefing", ""];
  for (const section of plan.sections) {
    lines.push(`## ${section.label}`);
    for (const node of section.nodes) {
      lines.push(`- **${node.prefixedId}** (${node.kind}): ${node.text}`);
    }
    lines.push("");
  }
  lines.push(
    "_Use `memory_search` or `memory_open` for more detail. IDs are stable._",
  );
  return lines.join("\n").trim() + "\n";
}
