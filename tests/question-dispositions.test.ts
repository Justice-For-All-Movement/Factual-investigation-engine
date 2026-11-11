import test from "node:test";
import assert from "node:assert/strict";
import {
  recordQuestionDispositions,
  inspectQuestionDispositions,
} from "../src/question-dispositions.ts";
import { recordEffort } from "../src/efforts.ts";
import { revisePlan } from "../src/index.ts";
import { fixture, captured } from "./disposition-fixture.ts";

test("whole explicit human review preserves unanswered dispositions, source coverage and reopening metadata without closure", () => {
  const x = fixture(),
    s = recordQuestionDispositions(x.c, captured(x), x.state, x.input);
  const d = inspectQuestionDispositions(x.c, captured(x), s, x.selected);
  assert.equal(d.reviewRequired, null);
  assert.deepEqual(
    d.questions.map((q) => q.disposition.status),
    ["unresolved", "deferred", "assigned"],
  );
  assert.deepEqual(
    d.coverage.questions.map((q) => q.status),
    ["unresolved", "unresolved", "unresolved"],
  );
  assert.deepEqual(d.coverage.effortHistory, x.efforts.records);
  assert.deepEqual(
    d.latestReview?.reopeningTriggers,
    x.input.reopeningTriggers,
  );
  assert.equal(Object.hasOwn(d, "closed"), false);
  assert.equal(Object.hasOwn(d, "complete"), false);
  assert.equal(d.latestReview?.actorKind, "human");
  assert.equal(d.latestReview?.ref.revision, 1);
  (d.latestReview!.questions[0] as { reason: string }).reason = "changed";
  assert.equal(s.records[0]!.questions[0]!.reason, "Unknown");
  assert.equal(x.state.records.length, 0);
});
test("new effort correction and plan edition require explicit new review, retaining old decisions and exact historical basis", () => {
  const x = fixture();
  let s = recordQuestionDispositions(x.c, captured(x), x.state, x.input);
  x.efforts = recordEffort(x.c, x.plans, x.efforts, {
    id: "correction",
    expectedSequence: 1,
    plan: x.selected,
    questionId: "one",
    leadId: "log",
    outcome: "exhausted",
    detail: "Corrected assertion",
    corrects: x.efforts.records[0]!.ref,
  });
  let d = inspectQuestionDispositions(x.c, captured(x), s, x.selected);
  assert.equal(d.reviewRequired, "basis-changed");
  assert(d.questions.every((q) => q.disposition.status === "unresolved"));
  assert.equal(d.latestReview?.questions[1]!.status, "deferred");
  const original = structuredClone(s.records[0]);
  s = recordQuestionDispositions(x.c, captured(x), s, {
    ...x.input,
    id: "review-two",
    expectedSequence: 1,
    supersedes: s.records[0]!.ref,
  });
  assert.deepEqual(s.records[0], original);
  assert.equal(
    inspectQuestionDispositions(x.c, captured(x), s, x.selected).reviewRequired,
    null,
  );
  x.plans = revisePlan(x.c, x.knowledge, x.plans, {
    id: "plan",
    expectedRevision: 1,
    value: x.value,
  });
  assert.throws(
    () => inspectQuestionDispositions(x.c, captured(x), s, x.selected),
    { code: "stale_plan" },
  );
  d = inspectQuestionDispositions(x.c, captured(x), s, x.plans.records[1]!.ref);
  assert.equal(d.reviewRequired, "basis-changed");
  assert.equal(d.coverage.questions[0]!.effortRefs.length, 0);
  assert.deepEqual(d.coverage.historicalEffectiveEffortRefs, [
    x.efforts.records[1]!.ref,
  ]);
  assert.equal(d.history.length, 2);
});
test("review due time and missing review expose unresolved defaults without rewriting historical assignments", () => {
  const x = fixture();
  let d = inspectQuestionDispositions(x.c, captured(x), x.state, x.selected);
  assert.equal(d.reviewRequired, "no-review");
  assert.equal(d.latestReview, null);
  const s = recordQuestionDispositions(x.c, captured(x), x.state, x.input);
  d = inspectQuestionDispositions(
    { ...x.c, now: "2026-02-01T00:00:00.000Z" },
    captured(x),
    s,
    x.selected,
  );
  assert.equal(d.reviewRequired, "review-due");
  assert(d.questions.every((q) => q.disposition.status === "unresolved"));
  assert.equal(s.records[0]!.questions[2]!.status, "assigned");
});
test("omitted material questions, fake answers, invalid assignment, past deferral, forks and stale global sequence deny", () => {
  const x = fixture();
  const run = (patch: object) =>
    recordQuestionDispositions(x.c, captured(x), x.state, {
      ...x.input,
      ...patch,
    });
  for (const questions of [
    x.input.questions.slice(1),
    [...x.input.questions].reverse(),
    x.input.questions.map((q, i) =>
      i === 0 ? { ...q, status: "answered" } : q,
    ),
    x.input.questions.map((q, i) => (i === 2 ? { ...q, assigneeId: null } : q)),
    x.input.questions.map((q, i) =>
      i === 1 ? { ...q, reviewAt: x.c.now } : q,
    ),
  ])
    assert.throws(() => run({ questions }));
  assert.throws(() => run({ expectedSequence: 1 }), {
    code: "revision_conflict",
  });
  assert.throws(() => run({ reopeningTriggers: [] }));
  assert.throws(() => run({ closed: true }));
  const s = recordQuestionDispositions(x.c, captured(x), x.state, x.input);
  assert.throws(() =>
    recordQuestionDispositions(x.c, captured(x), s, {
      ...x.input,
      id: "fork",
      expectedSequence: 1,
    }),
  );
  assert.throws(() =>
    recordQuestionDispositions(x.c, captured(x), s, {
      ...x.input,
      expectedSequence: 1,
      supersedes: s.records[0]!.ref,
    }),
  );
});
