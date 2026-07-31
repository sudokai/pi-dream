import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "./memory-database.ts";
import { acquireMemoryRunClaim } from "./memory-run-claim.ts";
import { commitMemoryLearningSession } from "./memory-repository.ts";
import { retireMemoryNode, getMemoryById } from "./memory-graph.ts";
import {
  refreshMemoryBriefingPlanNodes,
  validateAndPackMemoryBriefingPlan,
} from "./memory-recall-planner.ts";
import {
  formatMemoryNodeId,
  formatSummaryNodeId,
  type MemoryBriefingPlan,
  type MemorySearchCandidate,
} from "./memory-types.ts";

function candidate(
  nodeType: "memory" | "summary",
  id: number,
  text: string,
): MemorySearchCandidate {
  return {
    nodeType,
    nodeId: id,
    prefixedId:
      nodeType === "memory" ? formatMemoryNodeId(id) : formatSummaryNodeId(id),
    kind: nodeType === "memory" ? "fact" : "summary",
    text,
    heat: 1,
    estimatedTokens: 3,
    bm25Rank: null,
    semanticRank: null,
    rrfScore: 1,
  };
}

test("planner dedupes transitive containment (grandparent summary + nested memory)", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    commitMemoryLearningSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "fact",
            observationText: "Build tool is pnpm",
            memoryText: "Build tool is pnpm",
          },
          {
            op: "summarize",
            tempRef: "s2",
            text: "Tooling",
            memberIds: ["m1"],
          },
          {
            op: "summarize",
            tempRef: "s1",
            text: "Project setup",
            memberIds: ["s2"],
          },
        ],
      },
    });

    // Summaries are created in op order: S:1 = "Tooling" (contains M:1),
    // S:2 = "Project setup" (contains S:1, transitively M:1).
    const grandparent = formatSummaryNodeId(2);
    const child = formatSummaryNodeId(1);
    const m1 = formatMemoryNodeId(1);
    const candidates = [
      candidate("summary", 2, "Project setup"),
      candidate("summary", 1, "Tooling"),
      candidate("memory", 1, "Build tool is pnpm"),
    ];

    // Grandparent summary + deeply nested memory: the nested memory is dropped.
    const planA = validateAndPackMemoryBriefingPlan(
      candidates,
      { sections: [{ id: "relevant_summaries", ids: [grandparent, m1] }] },
      { db },
    );
    assert.deepEqual(planA.selectedIds, [grandparent]);

    // Reverse order: selecting the grandparent drops the selected memory.
    const planB = validateAndPackMemoryBriefingPlan(
      candidates,
      { sections: [{ id: "relevant_summaries", ids: [m1, grandparent] }] },
      { db },
    );
    assert.deepEqual(planB.selectedIds, [grandparent]);

    // Nested summary under an already-selected grandparent is also dropped.
    const planC = validateAndPackMemoryBriefingPlan(
      candidates,
      { sections: [{ id: "relevant_summaries", ids: [grandparent, child] }] },
      { db },
    );
    assert.deepEqual(planC.selectedIds, [grandparent]);

    // Direct child summary still dedupes its member memory.
    const planD = validateAndPackMemoryBriefingPlan(
      candidates,
      { sections: [{ id: "relevant_summaries", ids: [child, m1] }] },
      { db },
    );
    assert.deepEqual(planD.selectedIds, [child]);

    // Selecting the nested memory alone keeps it.
    const planE = validateAndPackMemoryBriefingPlan(
      candidates,
      { sections: [{ id: "workspace_knowledge", ids: [m1] }] },
      { db },
    );
    assert.deepEqual(planE.selectedIds, [m1]);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("refresh drops nodes retired or revised while recall ran (fail closed)", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    const runId = claim.runId!;
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "a",
            kind: "fact",
            observationText: "Deploy target Fly",
            memoryText: "Deploys to Fly.io",
          },
          {
            op: "create",
            tempRef: "b",
            kind: "fact",
            observationText: "Node 24",
            memoryText: "Runs on Node 24",
          },
          {
            op: "create",
            tempRef: "c",
            kind: "fact",
            observationText: "pnpm",
            memoryText: "Uses pnpm",
          },
        ],
      },
    });

    const plan: MemoryBriefingPlan = {
      sections: [
        {
          sectionId: "workspace_knowledge",
          label: "Workspace knowledge",
          nodes: [
            {
              prefixedId: "M:1",
              nodeType: "memory",
              kind: "fact",
              text: "Deploys to Fly.io",
              heat: 1,
            },
            {
              prefixedId: "M:2",
              nodeType: "memory",
              kind: "fact",
              text: "Runs on Node 24",
              heat: 1,
            },
            {
              prefixedId: "M:3",
              nodeType: "memory",
              kind: "fact",
              text: "Uses pnpm",
              heat: 1,
            },
          ],
        },
      ],
      estimatedTokens: 9,
      selectedIds: ["M:1", "M:2", "M:3"],
    };

    // A concurrent learner retires M:1 and revises M:2 mid-recall.
    retireMemoryNode(db, "M:1");
    const m2 = getMemoryById(db, 2)!;
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: "h2",
      plan: {
        operations: [
          {
            op: "revise",
            memoryId: "M:2",
            observationText: "Node 24 LTS",
            memoryText: "Runs on Node 24 LTS",
            expectedVersionId: m2.currentVersionId,
          },
        ],
      },
    });

    const refreshed = refreshMemoryBriefingPlanNodes(db, plan);
    assert.deepEqual(refreshed.selectedIds, ["M:3"]);
    assert.equal(refreshed.sections.length, 1);
    assert.equal(refreshed.sections[0]!.nodes.length, 1);
    assert.equal(refreshed.sections[0]!.nodes[0]!.text, "Uses pnpm");

    // Empty plans pass through untouched.
    const empty: MemoryBriefingPlan = {
      sections: [],
      estimatedTokens: 0,
      selectedIds: [],
    };
    assert.equal(refreshMemoryBriefingPlanNodes(db, empty), empty);
  } finally {
    closeMemoryDatabase(db);
  }
});
