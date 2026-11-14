import { createKnowledgeState } from "@accountability/knowledge-verification";
import type { Context } from "@accountability/knowledge-verification/contracts";
import { createPlanningState, revisePlan } from "../src/index.ts";
import type { Plan } from "../src/index.ts";
import { createEffortState, recordEffort } from "../src/efforts.ts";
import { createQuestionDispositionState } from "../src/question-dispositions.ts";
import type { QuestionDispositionInput } from "../src/question-dispositions.ts";
export const context: Context = {
  tenantId: "fiction",
  projectId: "dispositions",
  actor: { id: "reviewer", kind: "human", roles: ["researcher"] },
  purpose: "review",
  requestId: "synthetic",
  now: "2026-01-01T00:00:00.000Z",
};
export function fixture() {
  const c = structuredClone(context),
    knowledge = createKnowledgeState(c);
  const value: Plan = {
    title: "Fictional unanswered questions",
    intakeCaseRef: null,
    basisClaimRefs: [],
    questions: ["one", "two", "three"].map((id, i) => ({
      id,
      parentId: null,
      text: "What remains unknown " + id + "?",
      whyMaterial: "Unanswered fixture question",
      material: i < 2,
      hypotheses: [
        {
          id: "hypothesis",
          explanation: "An alternative",
          claimRefs: [],
          contraryTest: "Seek contrary fixture records",
        },
      ],
      leads: [{ id: "log", description: "Authorized fixture log" }],
      stopCondition: "Pause and retain uncertainty",
    })),
  };
  const plans = revisePlan(c, knowledge, createPlanningState(c), {
      id: "plan",
      expectedRevision: 0,
      value,
    }),
    selected = plans.records[0]!.ref;
  const efforts = recordEffort(c, plans, createEffortState(c), {
    id: "attempt",
    expectedSequence: 0,
    plan: selected,
    questionId: "one",
    leadId: "log",
    outcome: "unavailable",
    detail: "Synthetic assertion, not work proof",
    corrects: null,
  });
  const state = createQuestionDispositionState(c);
  const input: QuestionDispositionInput = {
    id: "review",
    expectedSequence: 0,
    supersedes: null,
    selected,
    questions: [
      {
        questionId: "one",
        status: "unresolved",
        reason: "Unknown",
        assigneeId: null,
        reviewAt: null,
      },
      {
        questionId: "two",
        status: "deferred",
        reason: "Fixture access unavailable",
        assigneeId: null,
        reviewAt: "2026-02-01T00:00:00.000Z",
      },
      {
        questionId: "three",
        status: "assigned",
        reason: "Seek an authorized contrary route",
        assigneeId: "fictional-human",
        reviewAt: "2026-02-02T00:00:00.000Z",
      },
    ],
    reopeningTriggers: ["New authorized fixture records become available"],
  };
  return { c, knowledge, value, plans, efforts, selected, state, input };
}
export const captured = (x: ReturnType<typeof fixture>) =>
  JSON.stringify({ plans: x.plans, efforts: x.efforts });
