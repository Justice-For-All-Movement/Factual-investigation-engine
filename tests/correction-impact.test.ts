import test from "node:test";
import assert from "node:assert/strict";
import * as k from "@accountability/knowledge-verification";
import type {
  Context,
  Ref,
} from "@accountability/knowledge-verification/contracts";
import * as f from "../src/index.ts";
import { inspectCapturedPlanCorrectionImpact as impact } from "../src/correction-impact.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "review",
  purpose: "private-review",
  actor: { id: "researcher", kind: "human", roles: ["researcher"] },
  now: "2026-01-01T00:00:00Z",
  requestId: "r",
};
const entity: k.KnowledgeValue = {
  type: "entity",
  label: "Fictional person",
  description: "Unresolved",
  category: "person",
};
const claimValue: Extract<k.KnowledgeValue, { type: "claim" }> = {
  type: "claim",
  text: "Unverified fictional account",
  subjectRefs: [],
  time: { earliest: null, latest: null },
  accountType: "attributed_testimony",
  limitations: ["Unverified"],
  assessment: null,
  proceduralPosture: null,
  editorialApproval: null,
};
function planValue(refs: readonly Ref[]): f.Plan {
  return {
    title: "Fictional review",
    intakeCaseRef: null,
    basisClaimRefs: refs,
    questions: [
      {
        id: "q",
        parentId: null,
        text: "What can be established?",
        whyMaterial: "Account unresolved",
        material: true,
        hypotheses: [
          {
            id: "h",
            explanation: "A fictional account",
            claimRefs: refs,
            contraryTest: "Seek an authorized contrary account",
          },
        ],
        leads: [],
        stopCondition: "Remain unresolved if no authorized evidence",
      },
    ],
  };
}
function setup() {
  let knowledge = k.reviseKnowledge(c, k.createKnowledgeState(c), {
    id: "person",
    expectedRevision: 0,
    value: entity,
  });
  const person = knowledge.records.at(-1)!.ref;
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "event",
    expectedRevision: 0,
    value: {
      type: "event",
      label: "Fictional meeting",
      description: "Unverified fixture",
      entityRefs: [person],
      time: { earliest: null, latest: null },
    },
  });
  const event = knowledge.records.at(-1)!.ref;
  const roleValue: Extract<k.KnowledgeValue, { type: "relationship" }> = {
    type: "relationship",
    relationshipType: "role_assertion",
    label: "Reported attendee",
    from: person,
    to: event,
    time: { earliest: null, latest: null },
    limitations: ["Unverified"],
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
  };
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "role",
    expectedRevision: 0,
    value: roleValue,
  });
  const role = knowledge.records.at(-1)!.ref;
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "claim",
    expectedRevision: 0,
    value: { ...claimValue, subjectRefs: [role] },
  });
  const claim = knowledge.records.at(-1)!.ref,
    value = planValue([claim]);
  const plans = f.revisePlan(c, knowledge, f.createPlanningState(c), {
    id: "plan",
    expectedRevision: 0,
    value,
  });
  return {
    knowledge,
    plans,
    selected: plans.records[0]!.ref,
    person,
    event,
    role,
    roleValue,
    claim,
    value,
  };
}
function corrected() {
  const x = setup();
  const knowledge = k.reviseKnowledge(c, x.knowledge, {
    id: "event",
    expectedRevision: 1,
    value: {
      type: "event",
      label: "Fictional meeting",
      description: "Corrected captured date",
      entityRefs: [x.person],
      time: { earliest: "2026-01-02T00:00:00Z", latest: null },
    },
  });
  const after = knowledge.records.at(-1)!.ref;
  const plans = f.revisePlan(c, knowledge, x.plans, {
    id: "unrelated",
    expectedRevision: 0,
    value: planValue([]),
  });
  return { ...x, knowledge, plans, after };
}
test("captured corrected date reaches claim through relationship, retains unrelated plan and null facts", () => {
  const x = corrected(),
    before = structuredClone(x);
  const r = impact(
    c,
    JSON.stringify({ knowledge: x.knowledge, plans: x.plans }),
    x.event,
    x.after,
  );
  assert.deepEqual(
    r.plans.map((p) => p.status),
    ["review-required", "no-captured-dependency"],
  );
  assert.deepEqual(r.plans[0]!.affectedRefs, [x.event]);
  assert.equal(
    r.plans[0]!.review.edges.filter((e) => e.to.id === x.event.id).length,
    1,
  );
  assert.equal(Object.hasOwn(r, "verified"), false);
  assert.equal(Object.hasOwn(r, "allowed"), false);
  Object.assign(r.plans[0]!.plan, { id: "copy" });
  assert.deepEqual(x, before);
});
test("all historical plan editions retained; latest observation never replaces old dependency graph", () => {
  const x = corrected();
  const plans = f.revisePlan(c, x.knowledge, x.plans, {
    id: "plan",
    expectedRevision: 1,
    value: planValue([]),
  });
  const r = impact(
    c,
    JSON.stringify({ knowledge: x.knowledge, plans }),
    x.event,
    x.after,
  );
  assert.equal(r.plans.length, 3);
  assert.equal(r.plans[0]!.status, "review-required");
  assert.deepEqual(r.plans[0]!.latestPlan, plans.records.at(-1)!.ref);
  assert.equal(r.plans[2]!.status, "no-captured-dependency");
});
test("missing transitive root is indeterminate, never unaffected or silently omitted", () => {
  const x = corrected();
  const knowledge = {
    ...x.knowledge,
    records: x.knowledge.records.filter((r) => r.ref.id !== "claim"),
  };
  const r = impact(
    c,
    JSON.stringify({ knowledge, plans: x.plans }),
    x.event,
    x.after,
  );
  assert.equal(r.plans[0]!.status, "indeterminate");
  assert.deepEqual(r.plans[0]!.review.nodes[0]!.ref, x.claim);
});
test("wrong scope roles purpose and nonconsecutive missing or stale correction editions fail whole", () => {
  const x = corrected(),
    json = JSON.stringify({ knowledge: x.knowledge, plans: x.plans });
  for (const ctx of [
    { ...c, actor: { ...c.actor, roles: ["viewer"] } },
    { ...c, purpose: "other" },
    { ...c, projectId: "foreign" },
  ])
    assert.throws(() => impact(ctx, json, x.event, x.after));
  for (const next of [
    { ...x.after, id: "other" },
    { ...x.after, revision: 3 },
    { ...x.after, projectId: "foreign" },
    x.event,
  ])
    assert.throws(() => impact(c, json, x.event, next));
  const changed = k.reviseKnowledge(c, x.knowledge, {
    id: "event",
    expectedRevision: 2,
    value: x.knowledge.records.at(-1)!.value,
  });
  assert.throws(
    () =>
      impact(
        c,
        JSON.stringify({ knowledge: changed, plans: x.plans }),
        x.event,
        x.after,
      ),
    { code: "stale_reference" },
  );
});
test("hostile JSON fields and oversize input deny with no partial report", () => {
  const x = corrected();
  for (const input of [
    "{",
    "null",
    "[]",
    JSON.stringify({ knowledge: x.knowledge, plans: x.plans, allowed: true }),
    " ".repeat(5 * 1024 * 1024 + 1),
  ])
    assert.throws(() => impact(c, input, x.event, x.after));
});
test("aggregate graph work has independent whole-report budget; inputs and plan history remain unchanged", () => {
  const x = corrected();
  let knowledge = x.knowledge;
  const subjects: Ref[] = [];
  for (let i = 0; i < 64; i++) {
    knowledge = k.reviseKnowledge(c, knowledge, {
      id: `fixture-${i}`,
      expectedRevision: 0,
      value: entity,
    });
    subjects.push(knowledge.records.at(-1)!.ref);
  }
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "wide",
    expectedRevision: 0,
    value: { ...claimValue, subjectRefs: subjects },
  });
  const root = knowledge.records.at(-1)!.ref;
  let plans = f.createPlanningState(c);
  for (let i = 0; i < 64; i++)
    plans = f.revisePlan(c, knowledge, plans, {
      id: `plan-${i}`,
      expectedRevision: 0,
      value: planValue([root]),
    });
  const boundedPlans = { ...plans, records: plans.records.slice(0, 63) };
  assert.throws(
    () =>
      impact(
        c,
        JSON.stringify({ knowledge, plans: boundedPlans }),
        x.event,
        x.after,
      ),
    { code: "impact_full", message: "Complete impact view exceeds budget" },
  );
  const json = JSON.stringify({ knowledge, plans });
  assert.throws(() => impact(c, json, x.event, x.after), {
    code: "impact_full",
    message: "Whole impact graph budget exceeded",
  });
  assert.equal(plans.records.length, 64);
  assert.equal(JSON.stringify({ knowledge, plans }), json);
});
test("extra correction reference fields, zero editions and mixed captured Knowledge purpose fail whole", () => {
  const x = corrected(),
    json = JSON.stringify({ knowledge: x.knowledge, plans: x.plans });
  const extra = { ...x.event, allowed: true };
  assert.throws(() => impact(c, json, extra, x.after), {
    code: "invalid_reference",
  });
  assert.throws(
    () =>
      impact(c, json, { ...x.event, revision: 0 }, { ...x.after, revision: 1 }),
    { code: "invalid_reference" },
  );
  const knowledge = structuredClone(x.knowledge);
  Object.assign(knowledge.records[0]!, { purpose: "foreign-use" });
  assert.throws(() =>
    impact(c, JSON.stringify({ knowledge, plans: x.plans }), x.event, x.after),
  );
});

test("all older editions require review while successor-bound graphs retain their own unaffected observation", () => {
  const x = setup();
  let knowledge = k.reviseKnowledge(c, x.knowledge, {
    id: "person",
    expectedRevision: 1,
    value: entity,
  });
  const before = knowledge.records.at(-1)!.ref;
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "person",
    expectedRevision: 2,
    value: entity,
  });
  const after = knowledge.records.at(-1)!.ref;
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "fresh-claim",
    expectedRevision: 0,
    value: { ...claimValue, subjectRefs: [after] },
  });
  const plans = f.revisePlan(c, knowledge, x.plans, {
    id: "fresh-plan",
    expectedRevision: 0,
    value: planValue([knowledge.records.at(-1)!.ref]),
  });
  const r = impact(c, JSON.stringify({ knowledge, plans }), before, after);
  assert.deepEqual(r.plans[0]!.affectedRefs, [x.person]);
  assert.equal(r.plans[0]!.status, "review-required");
  assert.equal(r.plans[1]!.status, "no-captured-dependency");
  assert.deepEqual(r.plans[1]!.affectedRefs, []);
});
