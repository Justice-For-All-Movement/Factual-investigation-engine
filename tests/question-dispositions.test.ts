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

test("host role/kind/scope/purpose and exact positive typed editions are checked without identity claims", () => {
  const x = fixture(),
    s = recordQuestionDispositions(x.c, captured(x), x.state, x.input);
  for (const c of [
    { ...x.c, actor: { ...x.c.actor, roles: [] } },
    { ...x.c, actor: { ...x.c.actor, kind: "agent" as const } },
    { ...x.c, projectId: "other" },
    { ...x.c, purpose: "other" },
  ]) {
    assert.throws(() =>
      inspectQuestionDispositions(c, captured(x), s, x.selected),
    );
    assert.throws(() =>
      recordQuestionDispositions(c, captured(x), x.state, x.input),
    );
  }
  for (const selected of [
    { ...x.selected, revision: 0 },
    { ...x.selected, kind: "claim" },
    { ...x.selected, projectId: "other" },
    { ...x.selected, revision: 1.5 },
  ])
    assert.throws(() =>
      recordQuestionDispositions(x.c, captured(x), x.state, {
        ...x.input,
        selected,
      }),
    );
  assert.throws(() =>
    recordQuestionDispositions(x.c, captured(x), x.state, {
      ...x.input,
      questions: x.input.questions.map((q, i) =>
        i === 2 ? { ...q, assigneeId: " " } : q,
      ),
    }),
  );
  // A nonempty host label passes syntax only; no directory or delivery callback exists.
  assert.equal(s.records[0]!.questions[2]!.assigneeId, "fictional-human");
});

test("altered original captured basis, stored decision profile, predecessor, actor and future history counts deny", () => {
  const x = fixture(),
    s = recordQuestionDispositions(x.c, captured(x), x.state, x.input);
  for (const patch of [
    { basis: { ...s.records[0]!.basis, captureDigest: "0".repeat(64) } },
    { basis: { ...s.records[0]!.basis, planningRecordCount: 2 } },
    { basis: { ...s.records[0]!.basis, effortSequence: 2 } },
    { actorKind: "agent" },
    { visibility: "public" },
    { sequence: 2 },
    { supersedes: s.records[0]!.ref },
    { createdAt: "2026-02-30T00:00:00.000Z" },
    {
      questions: s.records[0]!.questions.map((q, i) =>
        i === 0 ? { ...q, status: "verified" } : q,
      ),
    },
    { reopeningTriggers: ["duplicate", "duplicate"] },
    { closed: true },
  ]) {
    const bad = structuredClone(s);
    Object.assign(bad.records[0]!, patch);
    assert.throws(() =>
      inspectQuestionDispositions(x.c, captured(x), bad, x.selected),
    );
  }
  const changed = JSON.parse(captured(x));
  changed.efforts.records[0].detail = "Changed original unavailable assertion";
  assert.throws(() =>
    inspectQuestionDispositions(x.c, JSON.stringify(changed), s, x.selected),
  );
  assert.throws(() =>
    inspectQuestionDispositions(x.c, captured(x).slice(1), s, x.selected),
  );
  assert.throws(() =>
    inspectQuestionDispositions(
      x.c,
      JSON.stringify({ ...JSON.parse(captured(x)), permission: true }),
      s,
      x.selected,
    ),
  );
});

test("separate logical plans keep independent predecessors and a global monotonic captured review basis", () => {
  const x = fixture();
  let s = recordQuestionDispositions(x.c, captured(x), x.state, x.input);
  x.plans = revisePlan(x.c, x.knowledge, x.plans, {
    id: "other",
    expectedRevision: 0,
    value: { ...x.value, title: "Other plan" },
  });
  const other = x.plans.records[1]!.ref;
  assert.throws(() =>
    recordQuestionDispositions(x.c, captured(x), s, {
      ...x.input,
      id: "other-review",
      selected: other,
      expectedSequence: 1,
      supersedes: s.records[0]!.ref,
    }),
  );
  s = recordQuestionDispositions(x.c, captured(x), s, {
    ...x.input,
    id: "other-review",
    selected: other,
    expectedSequence: 1,
  });
  let d = inspectQuestionDispositions(x.c, captured(x), s, other);
  assert.equal(d.reviewRequired, null);
  assert.equal(d.history.length, 1);
  d = inspectQuestionDispositions(x.c, captured(x), s, x.selected);
  assert.equal(d.reviewRequired, "basis-changed");
  assert.equal(d.history.length, 1);
  s = recordQuestionDispositions(x.c, captured(x), s, {
    ...x.input,
    id: "first-plan-new-review",
    expectedSequence: 2,
    supersedes: s.records[0]!.ref,
  });
  assert.equal(
    inspectQuestionDispositions(x.c, captured(x), s, x.selected).history.length,
    2,
  );
  const truncated = {
    ...x,
    plans: { ...x.plans, records: x.plans.records.slice(0, 1) },
  };
  assert.throws(() =>
    inspectQuestionDispositions(x.c, captured(truncated), s, x.selected),
  );
});

test("actual 256 record capacity retains whole history and byte budgets fail rather than evict or truncate", () => {
  const x = fixture(),
    s = recordQuestionDispositions(x.c, captured(x), x.state, x.input),
    base = s.records[0]!;
  const records = Array.from({ length: 256 }, (_, i) => ({
    ...structuredClone(base),
    ref: { ...base.ref, id: "review-" + i },
    sequence: i + 1,
    supersedes: i === 0 ? null : { ...base.ref, id: "review-" + (i - 1) },
  }));
  const full = { ...s, records };
  assert.equal(
    inspectQuestionDispositions(x.c, captured(x), full, x.selected).history
      .length,
    256,
  );
  assert.throws(() =>
    recordQuestionDispositions(x.c, captured(x), full, {
      ...x.input,
      id: "overflow",
      expectedSequence: 256,
      supersedes: records[255]!.ref,
    }),
  );
  const huge = {
    ...full,
    records: records.map((r) => ({
      ...r,
      questions: r.questions.map((q) => ({ ...q, reason: "x".repeat(4000) })),
    })),
  };
  assert.throws(
    () => inspectQuestionDispositions(x.c, captured(x), huge, x.selected),
    { code: "dispositions_full" },
  );
  // A valid bounded stored history may still exceed the smaller whole-table budget.
  const wide = {
    ...full,
    records: records.map((r) => ({
      ...r,
      questions: r.questions.map((q) => ({ ...q, reason: "x".repeat(800) })),
    })),
  };
  assert(Buffer.byteLength(JSON.stringify(wide)) < 2 * 1024 * 1024);
  assert.throws(
    () => inspectQuestionDispositions(x.c, captured(x), wide, x.selected),
    { code: "dispositions_full" },
  );
  assert.throws(
    () =>
      inspectQuestionDispositions(
        x.c,
        " ".repeat(5 * 1024 * 1024 + 1),
        s,
        x.selected,
      ),
    { code: "dispositions_full" },
  );
  assert.equal(full.records.length, 256);
  assert.equal(s.records.length, 1);
});
