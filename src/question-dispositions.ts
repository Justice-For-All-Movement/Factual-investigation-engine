import { createHash } from "node:crypto";
import {
  canonical,
  invariant,
  nonempty,
  requireScope,
  validateRef,
} from "@accountability/knowledge-verification/contracts";
import type {
  Context,
  Ref,
  Scope,
} from "@accountability/knowledge-verification/contracts";
import { inspectPlans } from "./index.ts";
import type { PlanningState } from "./index.ts";
import { inspectEfforts } from "./efforts.ts";
import type { EffortState } from "./efforts.ts";
import { inspectCapturedInvestigationCoverage } from "./coverage.ts";

export type QuestionDisposition = Readonly<{
  questionId: string;
  status: "unresolved" | "deferred" | "assigned";
  reason: string;
  /** Host-authored human identifier only; not identity, delegation or task delivery proof. */
  assigneeId: string | null;
  reviewAt: string | null;
}>;
export type DispositionBasis = Readonly<{
  plan: Ref;
  planningRecordCount: number;
  effortSequence: number;
  captureDigest: string;
}>;
export type QuestionDispositionRecord = Readonly<{
  ref: Ref;
  sequence: number;
  supersedes: Ref | null;
  basis: DispositionBasis;
  questions: readonly QuestionDisposition[];
  reopeningTriggers: readonly string[];
  visibility: "private";
  actorId: string;
  actorKind: "human";
  createdAt: string;
  requestId: string;
  purpose: string;
}>;
export type QuestionDispositionState = Scope &
  Readonly<{
    schemaVersion: 1;
    visibility: "private";
    purpose: string;
    records: readonly QuestionDispositionRecord[];
  }>;
export type QuestionDispositionInput = Readonly<{
  id: string;
  expectedSequence: number;
  supersedes: Ref | null;
  selected: Ref;
  questions: readonly QuestionDisposition[];
  reopeningTriggers: readonly string[];
}>;
type Capture = { plans: PlanningState; efforts: EffortState };
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function exact(v: unknown, keys: readonly string[]): void {
  invariant(
    v !== null &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype &&
      Reflect.ownKeys(v).length === keys.length &&
      keys.every(
        (k) =>
          Object.hasOwn(v, k) &&
          "value" in Object.getOwnPropertyDescriptor(v, k)!,
      ),
    "invalid_disposition",
    "Exact plain data fields required",
  );
}
function date(v: string): number {
  invariant(
    typeof v === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
      Number.isFinite(Date.parse(v)) &&
      new Date(v).toISOString() === v,
    "invalid_disposition",
    "Canonical UTC millisecond timestamp required",
  );
  return Date.parse(v);
}
function authorize(c: Context, s: Scope): void {
  invariant(
    c.actor.kind === "human",
    "forbidden",
    "Host-authorized human context required",
  );
  inspectPlans(c, {
    tenantId: s.tenantId,
    projectId: s.projectId,
    schemaVersion: 1,
    visibility: "private",
    records: [],
  });
}
function reference(r: Ref, s: Scope, kind: string): void {
  exact(r, ["tenantId", "projectId", "kind", "id", "revision"]);
  validateRef(r);
  requireScope(s, r);
  nonempty(r.id, "Reference", 128);
  invariant(
    r.kind === kind && Number.isSafeInteger(r.revision) && r.revision > 0,
    "invalid_disposition",
    "Positive exact typed edition required",
  );
}
function capture(c: Context, text: string): Capture {
  invariant(
    typeof text === "string" &&
      text.length <= 5 * 1024 * 1024 &&
      Buffer.byteLength(text) <= 5 * 1024 * 1024,
    "dispositions_full",
    "Captured metadata budget exceeded",
  );
  let v: Capture;
  try {
    v = JSON.parse(text);
  } catch {
    invariant(false, "invalid_disposition", "Captured JSON required");
  }
  exact(v, ["plans", "efforts"]);
  inspectPlans(c, v.plans);
  inspectEfforts(c, v.efforts);
  return v;
}
function prefix(data: Capture, n: number, m: number): Capture {
  invariant(
    Number.isSafeInteger(n) &&
      n >= 1 &&
      n <= data.plans.records.length &&
      Number.isSafeInteger(m) &&
      m >= 0 &&
      m <= data.efforts.records.length,
    "invalid_disposition",
    "Available exact history prefixes required",
  );
  return {
    plans: { ...data.plans, records: data.plans.records.slice(0, n) },
    efforts: { ...data.efforts, records: data.efforts.records.slice(0, m) },
  };
}
function basis(data: Capture, selected: Ref): DispositionBasis {
  return {
    plan: selected,
    planningRecordCount: data.plans.records.length,
    effortSequence: data.efforts.records.length,
    captureDigest: createHash("sha256").update(canonical(data)).digest("hex"),
  };
}
function decisions(
  questions: readonly QuestionDisposition[],
  triggers: readonly string[],
  ids: readonly string[],
  createdAt: string,
): void {
  invariant(
    Array.isArray(questions) && questions.length === ids.length,
    "invalid_disposition",
    "Every selected-plan question requires one explicit disposition",
  );
  for (const [i, q] of questions.entries()) {
    exact(q, ["questionId", "status", "reason", "assigneeId", "reviewAt"]);
    invariant(
      q.questionId === ids[i] &&
        ["unresolved", "deferred", "assigned"].includes(q.status),
      "invalid_disposition",
      "Exact question order and unanswered disposition required",
    );
    nonempty(q.reason, "Disposition rationale", 4000);
    if (q.status === "assigned")
      nonempty(q.assigneeId!, "Host human assignee identifier", 128);
    else
      invariant(
        q.assigneeId === null,
        "invalid_disposition",
        "Only assigned questions may name an assignee",
      );
    if (q.status === "unresolved")
      invariant(
        q.reviewAt === null,
        "invalid_disposition",
        "Unresolved question has no scheduled disposition",
      );
    else
      invariant(
        date(q.reviewAt!) > date(createdAt),
        "invalid_disposition",
        "Deferred or assigned questions require a later explicit review time",
      );
  }
  invariant(
    Array.isArray(triggers) &&
      triggers.length >= 1 &&
      triggers.length <= 16 &&
      new Set(triggers).size === triggers.length,
    "invalid_disposition",
    "One to sixteen distinct literal reopening triggers required",
  );
  for (const t of triggers) nonempty(t, "Reopening trigger", 2000);
}
function validate(
  c: Context,
  data: Capture,
  state: QuestionDispositionState,
): void {
  exact(state, [
    "tenantId",
    "projectId",
    "schemaVersion",
    "visibility",
    "purpose",
    "records",
  ]);
  authorize(c, state);
  invariant(
    state.schemaVersion === 1 &&
      state.visibility === "private" &&
      state.purpose === c.purpose &&
      Array.isArray(state.records) &&
      state.records.length <= 256,
    "invalid_disposition",
    "Bounded private same-purpose review history required",
  );
  invariant(
    Buffer.byteLength(canonical(state)) <= 2 * 1024 * 1024,
    "dispositions_full",
    "Whole review history budget exceeded",
  );
  const ids = new Set<string>(),
    latest = new Map<string, QuestionDispositionRecord>();
  let previousPlanning = 0,
    previousEffort = 0;
  for (const [i, r] of state.records.entries()) {
    exact(r, [
      "ref",
      "sequence",
      "supersedes",
      "basis",
      "questions",
      "reopeningTriggers",
      "visibility",
      "actorId",
      "actorKind",
      "createdAt",
      "requestId",
      "purpose",
    ]);
    reference(r.ref, state, "investigation-question-review");
    invariant(
      r.ref.revision === 1 &&
        r.sequence === i + 1 &&
        !ids.has(r.ref.id) &&
        r.visibility === "private" &&
        r.actorKind === "human" &&
        r.purpose === c.purpose,
      "invalid_disposition",
      "Immutable unique sequential private human review required",
    );
    ids.add(r.ref.id);
    date(r.createdAt);
    nonempty(r.actorId, "Historical actor metadata", 128);
    nonempty(r.requestId, "Historical request metadata", 128);
    exact(r.basis, [
      "plan",
      "planningRecordCount",
      "effortSequence",
      "captureDigest",
    ]);
    reference(r.basis.plan, state, "investigation-plan");
    invariant(
      r.basis.planningRecordCount >= previousPlanning &&
        r.basis.effortSequence >= previousEffort,
      "invalid_disposition",
      "Review history cannot regress its captured basis",
    );
    previousPlanning = r.basis.planningRecordCount;
    previousEffort = r.basis.effortSequence;
    const old = latest.get(r.basis.plan.id);
    if (r.supersedes !== null)
      reference(r.supersedes, state, "investigation-question-review");
    invariant(
      same(r.supersedes, old?.ref ?? null),
      "invalid_disposition",
      "Exact previous logical-plan review required; no forks",
    );
    const historical = prefix(
      data,
      r.basis.planningRecordCount,
      r.basis.effortSequence,
    );
    invariant(
      same(r.basis, basis(historical, r.basis.plan)),
      "invalid_disposition",
      "Exact original captured basis required",
    );
    const observed = inspectCapturedInvestigationCoverage(
      c,
      JSON.stringify(historical),
      r.basis.plan,
    );
    decisions(
      r.questions,
      r.reopeningTriggers,
      observed.plan.value.questions.map((q) => q.id),
      r.createdAt,
    );
    latest.set(r.basis.plan.id, r);
  }
}
/** Pure host-authorized private metadata. No persistence, identity proofing or closure authority. */
export function createQuestionDispositionState(
  context: Context,
): QuestionDispositionState {
  const c = structuredClone(context);
  authorize(c, c);
  return {
    tenantId: c.tenantId,
    projectId: c.projectId,
    schemaVersion: 1,
    visibility: "private",
    purpose: c.purpose,
    records: [],
  };
}
/** Append a whole explicit human review; never resolves a question or closes/reopens a case. */
export function recordQuestionDispositions(
  context: Context,
  captureJson: string,
  state: QuestionDispositionState,
  input: QuestionDispositionInput,
): QuestionDispositionState {
  const c = structuredClone(context),
    s = structuredClone(state),
    q = structuredClone(input);
  const data = capture(c, captureJson);
  validate(c, data, s);
  exact(q, [
    "id",
    "expectedSequence",
    "supersedes",
    "selected",
    "questions",
    "reopeningTriggers",
  ]);
  nonempty(q.id, "Review identifier", 128);
  reference(q.selected, c, "investigation-plan");
  invariant(
    Number.isSafeInteger(q.expectedSequence) &&
      q.expectedSequence === s.records.length,
    "revision_conflict",
    "Exact global review sequence required",
  );
  const observed = inspectCapturedInvestigationCoverage(
    c,
    captureJson,
    q.selected,
  );
  const createdAt = new Date(c.now).toISOString();
  decisions(
    q.questions,
    q.reopeningTriggers,
    observed.plan.value.questions.map((x) => x.id),
    createdAt,
  );
  const r: QuestionDispositionRecord = {
    ref: {
      tenantId: c.tenantId,
      projectId: c.projectId,
      kind: "investigation-question-review",
      id: q.id,
      revision: 1,
    },
    sequence: q.expectedSequence + 1,
    supersedes: q.supersedes,
    basis: basis(data, q.selected),
    questions: q.questions,
    reopeningTriggers: q.reopeningTriggers,
    visibility: "private",
    actorId: c.actor.id,
    actorKind: "human",
    createdAt,
    requestId: c.requestId,
    purpose: c.purpose,
  };
  const next: QuestionDispositionState = { ...s, records: [...s.records, r] };
  validate(c, data, next);
  return structuredClone(next);
}
/** Captured table only. Changed basis or a due review falls back to unresolved; prior decisions remain visible. */
export function inspectQuestionDispositions(
  context: Context,
  captureJson: string,
  state: QuestionDispositionState,
  selected: Ref,
) {
  const c = structuredClone(context),
    s = structuredClone(state),
    choice = structuredClone(selected);
  const data = capture(c, captureJson);
  validate(c, data, s);
  const coverage = inspectCapturedInvestigationCoverage(c, captureJson, choice);
  const latest =
    s.records.filter((r) => r.basis.plan.id === choice.id).at(-1) ?? null;
  const reviewRequired = !latest
    ? ("no-review" as const)
    : !same(latest.basis, basis(data, choice))
      ? ("basis-changed" as const)
      : latest.questions.some(
            (q) =>
              q.reviewAt !== null &&
              Date.parse(q.reviewAt) <= Date.parse(c.now),
          )
        ? ("review-due" as const)
        : null;
  const output = {
    schemaVersion: 1 as const,
    profile: "captured-question-dispositions-v1" as const,
    visibility: "private" as const,
    tenantId: c.tenantId,
    projectId: c.projectId,
    purpose: c.purpose,
    coverage,
    reviewRequired,
    latestReview: latest,
    questions: coverage.questions.map((q) => ({
      questionId: q.questionId,
      material: q.material,
      disposition:
        reviewRequired === null
          ? latest!.questions.find((d) => d.questionId === q.questionId)!
          : {
              questionId: q.questionId,
              status: "unresolved" as const,
              reason: "Explicit current review required",
              assigneeId: null,
              reviewAt: null,
            },
    })),
    history: s.records.filter((r) => r.basis.plan.id === choice.id),
  };
  invariant(
    Buffer.byteLength(canonical(output)) <= 512 * 1024,
    "dispositions_full",
    "Complete table budget exceeded",
  );
  return structuredClone(output);
}
