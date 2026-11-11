import {
  canonical,
  invariant,
  requireScope,
  validateRef,
} from "@accountability/knowledge-verification/contracts";
import type {
  Context,
  Ref,
} from "@accountability/knowledge-verification/contracts";
import { inspectPlans } from "./index.ts";
import type { PlanningState, PlanRevision } from "./index.ts";
import { inspectEfforts } from "./efforts.ts";
import type { EffortState, EffortRecord } from "./efforts.ts";

export type CapturedInvestigationCoverage = Readonly<{
  schemaVersion: 1;
  profile: "captured-investigation-coverage-v1";
  tenantId: string;
  projectId: string;
  visibility: "private";
  purpose: string;
  basis: Readonly<{
    plan: Ref;
    planningRecordCount: number;
    effortSequence: number;
  }>;
  plan: PlanRevision;
  questions: readonly Readonly<{
    questionId: string;
    material: boolean;
    status: "unresolved";
    effortRefs: readonly Ref[];
    leadsWithoutRecordedEffort: readonly string[];
  }>[];
  effortHistory: readonly EffortRecord[];
  historicalEffectiveEffortRefs: readonly Ref[];
  unloaded: readonly [
    "current-knowledge",
    "verification-reviews",
    "current-source-permissions",
    "raw-audit-events",
  ];
}>;
const same = (a: Ref, b: Ref) => canonical(a) === canonical(b);

/** Captured bookkeeping only: never completeness, work proof, a finding, answer or closure authority. */
export function inspectCapturedInvestigationCoverage(
  context: Context,
  captureJson: string,
  selectedPlan: Ref,
): CapturedInvestigationCoverage {
  invariant(
    typeof captureJson === "string" &&
      captureJson.length <= 5 * 1024 * 1024 &&
      Buffer.byteLength(captureJson) <= 5 * 1024 * 1024,
    "coverage_full",
    "Captured input exceeds metadata budget",
  );
  let capture: any;
  try {
    capture = JSON.parse(captureJson);
  } catch {
    invariant(false, "invalid_coverage", "Captured JSON required");
  }
  invariant(
    capture &&
      typeof capture === "object" &&
      !Array.isArray(capture) &&
      Object.keys(capture).length === 2 &&
      Object.hasOwn(capture, "plans") &&
      Object.hasOwn(capture, "efforts"),
    "invalid_coverage",
    "Exact plans and efforts capture required",
  );
  const c = structuredClone(context),
    choice = structuredClone(selectedPlan);
  invariant(
    c.actor.kind === "human",
    "forbidden",
    "Host-authorized human research context required",
  );
  validateRef(choice);
  requireScope(c, choice);
  invariant(
    choice.kind === "investigation-plan",
    "invalid_reference",
    "Exact plan reference required",
  );
  const plans = capture.plans as PlanningState,
    efforts = capture.efforts as EffortState;
  const records = inspectPlans(c, plans),
    observed = inspectEfforts(c, efforts);
  const plan = records.find((p) => same(p.ref, choice));
  invariant(plan, "missing_reference", "Exact captured plan edition required");
  invariant(
    !records.some(
      (p) => p.ref.id === choice.id && p.ref.revision > choice.revision,
    ),
    "stale_plan",
    "Select latest plan edition in capture",
  );
  invariant(
    plan.purpose === c.purpose,
    "purpose_denied",
    "Plan purpose differs",
  );
  const history = observed.history.filter((e) => e.plan.id === choice.id);
  for (const effort of history) {
    const original = records.find((p) => same(p.ref, effort.plan));
    const question = original?.value.questions.find(
      (q) => q.id === effort.questionId,
    );
    invariant(
      question &&
        (effort.leadId === null ||
          question.leads.some((l) => l.id === effort.leadId)),
      "missing_reference",
      "Effort must retain exact original plan/question/lead basis",
    );
    invariant(
      effort.purpose === c.purpose && original!.purpose === c.purpose,
      "purpose_denied",
      "Included effort purpose differs",
    );
  }
  const effective = observed.effective.filter((e) => e.plan.id === choice.id);
  const output: CapturedInvestigationCoverage = {
    schemaVersion: 1,
    profile: "captured-investigation-coverage-v1",
    tenantId: c.tenantId,
    projectId: c.projectId,
    visibility: "private",
    purpose: c.purpose,
    basis: {
      plan: plan.ref,
      planningRecordCount: records.length,
      effortSequence: observed.history.length,
    },
    plan,
    questions: plan.value.questions.map((q) => {
      const current = effective.filter(
        (e) => same(e.plan, choice) && e.questionId === q.id,
      );
      return {
        questionId: q.id,
        material: q.material,
        status: "unresolved",
        effortRefs: current.map((e) => e.ref),
        leadsWithoutRecordedEffort: q.leads
          .filter((l) => !current.some((e) => e.leadId === l.id))
          .map((l) => l.id),
      };
    }),
    effortHistory: history,
    historicalEffectiveEffortRefs: effective
      .filter((e) => !same(e.plan, choice))
      .map((e) => e.ref),
    unloaded: [
      "current-knowledge",
      "verification-reviews",
      "current-source-permissions",
      "raw-audit-events",
    ],
  };
  invariant(
    Buffer.byteLength(canonical(output)) <= 512 * 1024,
    "coverage_full",
    "Complete coverage table exceeds budget",
  );
  return structuredClone(output);
}
