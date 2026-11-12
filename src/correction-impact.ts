import { inspectKnowledge } from "@accountability/knowledge-verification";
import type { KnowledgeState } from "@accountability/knowledge-verification";
import { canonical, invariant, requireScope, validateRef } from "@accountability/knowledge-verification/contracts";
import type { Context, Ref } from "@accountability/knowledge-verification/contracts";
import { inspectPlans } from "./index.ts";
import type { PlanningState } from "./index.ts";
import { reviewPlanKnowledge } from "./knowledge-review.ts";
import type { PlanKnowledgeReview } from "./knowledge-review.ts";

export type CapturedPlanCorrectionImpact = Readonly<{
  profile: "captured-plan-correction-impact-v1";
  visibility: "private";
  tenantId: string;
  projectId: string;
  purpose: string;
  before: Ref;
  after: Ref;
  planningRecordCount: number;
  knowledgeRecordCount: number;
  plans: readonly Readonly<{
    plan: Ref;
    latestPlan: Ref;
    status: "review-required" | "indeterminate" | "no-captured-dependency";
    affectedRefs: readonly Ref[];
    review: PlanKnowledgeReview;
  }>[];
  unloaded: readonly ["current-source-permissions", "findings", "draft-outputs", "raw-audit-events"];
}>;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Complete bounded captured dependency comparison, not a correction command or permission. */
export function inspectCapturedPlanCorrectionImpact(
  context: Context,
  captureJson: string,
  before: Ref,
  after: Ref,
): CapturedPlanCorrectionImpact {
  invariant(typeof captureJson === "string" && captureJson.length <= 5 * 1024 * 1024 &&
    Buffer.byteLength(captureJson) <= 5 * 1024 * 1024, "impact_full", "Captured input exceeds budget");
  let capture: { knowledge: KnowledgeState; plans: PlanningState };
  try { capture = JSON.parse(captureJson); }
  catch { invariant(false, "invalid_impact", "Captured JSON required"); }
  invariant(capture! && typeof capture === "object" && !Array.isArray(capture) &&
    Object.keys(capture).length === 2 && Object.hasOwn(capture, "knowledge") && Object.hasOwn(capture, "plans"),
    "invalid_impact", "Exact knowledge and plans capture required");
  const c = structuredClone(context), prior = structuredClone(before), next = structuredClone(after);
  invariant(c.actor.kind === "human", "forbidden", "Host-authorized human research context required");
  for (const ref of [prior, next]) {
    validateRef(ref); requireScope(c, ref);
    invariant(Object.keys(ref).sort().join(",") === "id,kind,projectId,revision,tenantId" &&
      Number.isSafeInteger(ref.revision) && ref.revision > 0,
      "invalid_reference", "Exact positive reference required");
  }
  invariant(prior.kind === next.kind && prior.id === next.id && next.revision === prior.revision + 1,
    "invalid_impact", "Exact consecutive editions of one Knowledge record required");
  const knowledge = inspectKnowledge(c, capture.knowledge), plans = inspectPlans(c, capture.plans);
  invariant(knowledge.every(r => r.purpose === c.purpose), "purpose_denied", "Captured Knowledge purpose differs");
  const oldRecord = knowledge.find(r => same(r.ref, prior));
  const newRecord = knowledge.find(r => same(r.ref, next));
  invariant(oldRecord && newRecord && same(newRecord.supersedes, prior), "missing_reference", "Both actual predecessor editions required");
  invariant(!knowledge.some(r => r.ref.kind === next.kind && r.ref.id === next.id && r.ref.revision > next.revision),
    "stale_reference", "Select latest successor in capture");
  let nodes = 0, edges = 0;
  const rows: CapturedPlanCorrectionImpact["plans"][number][] = [];
  for (const plan of plans) {
    invariant(plan.purpose === c.purpose, "purpose_denied", "Included plan purpose differs");
    const review = reviewPlanKnowledge(c, capture.knowledge, capture.plans, plan.ref);
    nodes += review.nodes.length; edges += review.edges.length;
    invariant(nodes <= 4096 && edges <= 8192, "impact_full", "Whole impact graph budget exceeded");
    // Every older observed edition of the corrected logical record needs explicit review.
    const affectedRefs = review.nodes.filter(n => n.ref.kind === prior.kind && n.ref.id === prior.id &&
      n.ref.revision <= prior.revision).map(n => n.ref);
    rows.push({ plan: plan.ref, latestPlan: review.latestPlan,
      status: affectedRefs.length ? "review-required" : review.nodes.some(n => n.status === "missing-edition")
        ? "indeterminate" : "no-captured-dependency", affectedRefs, review });
  }
  const result: CapturedPlanCorrectionImpact = {
    profile: "captured-plan-correction-impact-v1", visibility: "private",
    tenantId: c.tenantId, projectId: c.projectId, purpose: c.purpose,
    before: prior, after: next, planningRecordCount: plans.length, knowledgeRecordCount: knowledge.length,
    plans: rows, unloaded: ["current-source-permissions", "findings", "draft-outputs", "raw-audit-events"],
  };
  invariant(Buffer.byteLength(canonical(result)) <= 512 * 1024, "impact_full", "Complete impact view exceeds budget");
  return structuredClone(result);
}
