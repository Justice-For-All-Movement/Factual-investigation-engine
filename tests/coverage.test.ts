import test from "node:test";
import assert from "node:assert/strict";
import * as f from "../src/index.ts";
import * as e from "../src/efforts.ts";
import { inspectCapturedInvestigationCoverage } from "../src/coverage.ts";
import { createKnowledgeState } from "@accountability/knowledge-verification";
import type { Context } from "@accountability/knowledge-verification/contracts";
const c: Context = {
  tenantId: "fiction",
  projectId: "coverage",
  actor: { id: "human", kind: "human", roles: ["researcher"] },
  purpose: "review",
  requestId: "synthetic",
  now: "2026-01-01T00:00:00Z",
};
function fixture() {
  const knowledge = createKnowledgeState(c),
    value: f.Plan = {
      title: "Synthetic plan",
      intakeCaseRef: null,
      basisClaimRefs: [],
      questions: [
        {
          id: "q",
          parentId: null,
          text: "What remains unknown?",
          whyMaterial: "A missing record",
          material: true,
          hypotheses: [
            {
              id: "h",
              explanation: "Fictional competing explanation",
              claimRefs: [],
              contraryTest: "Seek contrary fixture records",
            },
          ],
          leads: [
            { id: "log", description: "Authorized fixture log" },
            { id: "other", description: "Another lead" },
          ],
          stopCondition: "Pause; never infer an answer",
        },
      ],
    };
  const plans = f.revisePlan(c, knowledge, f.createPlanningState(c), {
      id: "plan",
      expectedRevision: 0,
      value,
    }),
    selected = plans.records[0]!.ref;
  const efforts = e.recordEffort(c, plans, e.createEffortState(c), {
    id: "attempt",
    expectedSequence: 0,
    plan: selected,
    questionId: "q",
    leadId: "log",
    outcome: "unavailable",
    detail: "Synthetic unavailable assertion",
    corrects: null,
  });
  return { plans, efforts, selected, knowledge, value };
}
test("current captured effort assertions leave all questions unresolved and retain unrecorded leads", () => {
  const x = fixture(),
    d = inspectCapturedInvestigationCoverage(
      c,
      JSON.stringify({ plans: x.plans, efforts: x.efforts }),
      x.selected,
    );
  assert.deepEqual(d.questions, [
    {
      questionId: "q",
      material: true,
      status: "unresolved",
      effortRefs: [x.efforts.records[0]!.ref],
      leadsWithoutRecordedEffort: ["other"],
    },
  ]);
  assert.deepEqual(d.effortHistory, x.efforts.records);
  assert.equal(Object.hasOwn(d, "closed"), false);
  assert.equal(d.basis.effortSequence, 1);
  (d.plan.value as any).title = "modified";
  assert.equal(x.plans.records[0]!.value.title, "Synthetic plan");
});
test("corrected effort history remains intact and older plan efforts never silently cover a new edition", () => {
  const x = fixture();
  x.efforts = e.recordEffort(c, x.plans, x.efforts, {
    id: "corrected",
    expectedSequence: 1,
    plan: x.selected,
    questionId: "q",
    leadId: "log",
    outcome: "exhausted",
    detail: "Corrected synthetic assertion",
    corrects: x.efforts.records[0]!.ref,
  });
  let d = inspectCapturedInvestigationCoverage(
    c,
    JSON.stringify({ plans: x.plans, efforts: x.efforts }),
    x.selected,
  );
  assert.equal(d.effortHistory.length, 2);
  assert.deepEqual(d.questions[0]!.effortRefs, [x.efforts.records[1]!.ref]);
  x.plans = f.revisePlan(c, x.knowledge, x.plans, {
    id: "plan",
    expectedRevision: 1,
    value: x.value,
  });
  assert.throws(
    () =>
      inspectCapturedInvestigationCoverage(
        c,
        JSON.stringify({ plans: x.plans, efforts: x.efforts }),
        x.selected,
      ),
    { code: "stale_plan" },
  );
  d = inspectCapturedInvestigationCoverage(
    c,
    JSON.stringify({ plans: x.plans, efforts: x.efforts }),
    x.plans.records[1]!.ref,
  );
  assert.equal(d.questions[0]!.status, "unresolved");
  assert.equal(d.questions[0]!.effortRefs.length, 0);
  assert.deepEqual(d.historicalEffectiveEffortRefs, [
    x.efforts.records[1]!.ref,
  ]);
  assert.equal(d.effortHistory.length, 2);
});
test("foreign scope, roles, human kind, purpose and unbound effort metadata deny", () => {
  const x = fixture(),
    capture = () => JSON.stringify({ plans: x.plans, efforts: x.efforts });
  for (const ctx of [
    { ...c, actor: { ...c.actor, roles: [] } },
    { ...c, actor: { ...c.actor, kind: "agent" as const } },
    { ...c, projectId: "foreign" },
    { ...c, purpose: "other" },
  ])
    assert.throws(() =>
      inspectCapturedInvestigationCoverage(ctx, capture(), x.selected),
    );
  (x.efforts.records[0] as any).questionId = "invented";
  assert.throws(
    () => inspectCapturedInvestigationCoverage(c, capture(), x.selected),
    { code: "missing_reference" },
  );
  assert.throws(
    () =>
      inspectCapturedInvestigationCoverage(
        c,
        '{"plans":null,"efforts":null,"closed":true}',
        x.selected,
      ),
    { code: "invalid_coverage" },
  );
});

test("complete output bounds retain unresolved questions and fail rather than truncate exhausted history", () => {
  const x = fixture(),
    base = x.efforts.records[0]!;
  const run = (size: number) => {
    x.efforts = {
      ...x.efforts,
      records: Array.from({ length: 128 }, (_, i) => ({
        ...structuredClone(base),
        ref: { ...base.ref, id: "bounded" + i },
        sequence: i + 1,
        outcome: "exhausted" as const,
        detail: "x".repeat(size),
      })),
    };
    return inspectCapturedInvestigationCoverage(
      c,
      JSON.stringify({ plans: x.plans, efforts: x.efforts }),
      x.selected,
    );
  };
  let low = 1,
    high = 4000;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    try {
      run(mid);
      low = mid;
    } catch (e) {
      assert.equal((e as any).code, "coverage_full");
      high = mid - 1;
    }
  }
  const d = run(low),
    size = Buffer.byteLength(JSON.stringify(d));
  const last = x.efforts.records.at(-1)! as any;
  last.detail += "x".repeat(512 * 1024 - size);
  const exact = inspectCapturedInvestigationCoverage(
    c,
    JSON.stringify({ plans: x.plans, efforts: x.efforts }),
    x.selected,
  );
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 512 * 1024);
  assert.equal(exact.effortHistory.length, 128);
  assert.equal(exact.questions[0]!.status, "unresolved");
  last.detail += "x";
  assert.throws(
    () =>
      inspectCapturedInvestigationCoverage(
        c,
        JSON.stringify({ plans: x.plans, efforts: x.efforts }),
        x.selected,
      ),
    { code: "coverage_full" },
  );
  assert.throws(
    () =>
      inspectCapturedInvestigationCoverage(
        c,
        " ".repeat(5 * 1024 * 1024 + 1),
        x.selected,
      ),
    { code: "coverage_full" },
  );
  assert.throws(
    () =>
      inspectCapturedInvestigationCoverage(c, "😀".repeat(1400000), x.selected),
    { code: "coverage_full" },
  );
  assert.throws(
    () => inspectCapturedInvestigationCoverage(c, "{broken", x.selected),
    { code: "invalid_coverage" },
  );
});

test("only the selected logical plan contributes table history while global sequence remains descriptive", () => {
  const x = fixture();
  x.plans = f.revisePlan(c, x.knowledge, x.plans, {
    id: "unrelated",
    expectedRevision: 0,
    value: x.value,
  });
  x.efforts = e.recordEffort(c, x.plans, x.efforts, {
    id: "unrelated",
    expectedSequence: 1,
    plan: x.plans.records[1]!.ref,
    questionId: "q",
    leadId: "log",
    outcome: "attempted",
    detail: "Unrelated synthetic assertion",
    corrects: null,
  });
  const d = inspectCapturedInvestigationCoverage(
    c,
    JSON.stringify({ plans: x.plans, efforts: x.efforts }),
    x.selected,
  );
  assert.equal(d.effortHistory.length, 1);
  assert.equal(d.basis.effortSequence, 2);
  assert.equal(d.basis.planningRecordCount, 2);
  assert.equal(d.plan.ref.id, "plan");
  assert.equal(d.historicalEffectiveEffortRefs.length, 0);
});

test("included effort and original plan purpose must match and empty effort capture is not coverage proof", () => {
  const x = fixture();
  const empty = inspectCapturedInvestigationCoverage(
    c,
    JSON.stringify({ plans: x.plans, efforts: e.createEffortState(c) }),
    x.selected,
  );
  assert.equal(empty.questions[0]!.status, "unresolved");
  assert.deepEqual(empty.questions[0]!.leadsWithoutRecordedEffort, [
    "log",
    "other",
  ]);
  (x.efforts.records[0] as any).purpose = "other";
  assert.throws(
    () =>
      inspectCapturedInvestigationCoverage(
        c,
        JSON.stringify({ plans: x.plans, efforts: x.efforts }),
        x.selected,
      ),
    { code: "purpose_denied" },
  );
});
