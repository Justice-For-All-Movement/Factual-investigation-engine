// Domain shapes and input normalisation for the factual investigation engine. Pure: no I/O.
import { invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { ATTEMPT_KINDS, bad, idList, jsonValue, links, list, num, obj, oneOf, optRef, optText, refList, refOf, text } from './store.ts';
import type { AttemptKind, SourceLink } from './store.ts';
import type { StatementLabel } from './ports.ts';

export const LABELS: readonly StatementLabel[] = ['allegation', 'attributed_testimony', 'verified_fact', 'inference', 'unknown'];
export type Lane = Readonly<{ id: string; name: string; targetShare: number; attemptKinds: readonly AttemptKind[] }>;
export type Policy = Readonly<{
  requireDistinctReviewer: boolean;
  autoAccept: Readonly<{ questions: Readonly<{ enabled: boolean; max: number; allowMaterial: boolean }>; steps: Readonly<{ enabled: boolean; max: number; actions: readonly string[] }> }>;
}>;
export type InvestigationData = Readonly<{
  title: string; originRef: string; scopeStatement: string; compartment: string | null;
  /** The account as received, kept apart from analysis. It is never edited by findings. */
  originalAccount: Readonly<{ ref: string | null; summary: string; label: StatementLabel }>;
  lanes: readonly Lane[]; policy: Policy; urgency: string | null; contactConstraints: string | null;
  closures: readonly Readonly<{ at: string; by: string; rationale: string; packageVersion: number; packageDigest: string; reopeningTriggers: readonly string[] }>[];
  reopenings: readonly Readonly<{ at: string; by: string; reason: string; newInformationRefs: readonly string[] }>[];
  reviewRequests: readonly Readonly<{ at: string; by: string; ready: boolean; blockers: number }>[];
  autoAccepted: Readonly<{ questions: number; steps: number }>; gapDigest: string | null;
}>;
export const DEFAULT_LANES: readonly Lane[] = [
  { id: 'documentary', name: 'Documentary research', targetShare: 0.5, attemptKinds: ['search', 'acquisition', 'processing', 'knowledge', 'verification'] },
  { id: 'outreach', name: 'Interviews and correspondence', targetShare: 0.5, attemptKinds: ['contact'] },
];
export function normLanes(v: unknown): Lane[] {
  if (v === undefined || v === null) return [...DEFAULT_LANES];
  const lanes = list(v, 'lanes', 12).map((raw) => {
    const o = obj(raw, 'lane');
    const id = text(o.id, 'lane.id', 64);
    invariant(/^[a-z][a-z0-9_-]*$/.test(id), 'invalid_input', 'lane.id must be a lowercase identifier');
    return { id, name: text(o.name, 'lane.name', 200), targetShare: num(o.targetShare, 'lane.targetShare', 0, 1), attemptKinds: [...new Set(list(o.attemptKinds, 'lane.attemptKinds', 10).map((k) => oneOf(k, ATTEMPT_KINDS, 'lane.attemptKinds')))] };
  });
  invariant(lanes.length >= 1 && new Set(lanes.map((l) => l.id)).size === lanes.length, 'invalid_input', 'At least one lane with distinct ids is required');
  invariant(Math.abs(lanes.reduce((s, l) => s + l.targetShare, 0) - 1) < 0.001, 'invalid_input', 'Lane target shares must sum to 1');
  return lanes;
}
export function normPolicy(v: unknown, engine: { requireDistinctReviewer: boolean; autoAcceptCeiling: number }, allowedActions: readonly string[]): Policy {
  const o = v === undefined || v === null ? {} : obj(v, 'policy');
  const aa = o.autoAccept === undefined || o.autoAccept === null ? {} : obj(o.autoAccept, 'policy.autoAccept');
  const qs = aa.questions === undefined || aa.questions === null ? {} : obj(aa.questions, 'policy.autoAccept.questions');
  const st = aa.steps === undefined || aa.steps === null ? {} : obj(aa.steps, 'policy.autoAccept.steps');
  return {
    // An investigation may tighten but never loosen the deployment's reviewer rule.
    requireDistinctReviewer: engine.requireDistinctReviewer || o.requireDistinctReviewer !== false,
    autoAccept: {
      questions: { enabled: qs.enabled === true, max: Math.min(num(qs.max, 'autoAccept.questions.max', 0, 1000, 0), engine.autoAcceptCeiling), allowMaterial: qs.allowMaterial === true },
      steps: { enabled: st.enabled === true, max: Math.min(num(st.max, 'autoAccept.steps.max', 0, 1000, 0), engine.autoAcceptCeiling), actions: list(st.actions, 'autoAccept.steps.actions', 50).map((a) => oneOf(a, allowedActions, 'autoAccept.steps.actions')) },
    },
  };
}

export const QUESTION_STATUSES = ['open', 'in_progress', 'answered', 'unresolvable', 'out_of_scope'] as const;
export type QuestionData = Readonly<{
  parentId: string | null; text: string; material: boolean; whyMaterial: string | null; stopCondition: string | null;
  claimRefs: readonly string[]; findingIds: readonly string[]; answer: string | null; answerLabel: StatementLabel | null; rationale: string | null;
  origin: 'human' | 'proposal'; dispositionBy: string | null; dispositionAt: string | null;
}>;
export function normQuestion(raw: Record<string, unknown>): Omit<QuestionData, 'findingIds' | 'answer' | 'answerLabel' | 'rationale' | 'origin' | 'dispositionBy' | 'dispositionAt'> {
  invariant(typeof raw.material === 'boolean', 'invalid_input', 'material must be stated explicitly as true or false');
  const whyMaterial = optText(raw.whyMaterial, 'whyMaterial');
  invariant(!raw.material || whyMaterial !== null, 'invalid_input', 'A material question needs whyMaterial');
  const claimRefs = refList(raw.claimRefs, 'claimRefs');
  return { parentId: optText(raw.parentId, 'parentId', 128), text: text(raw.text, 'text'), material: raw.material, whyMaterial, stopCondition: optText(raw.stopCondition, 'stopCondition'), claimRefs };
}

export const HYPOTHESIS_STATUSES = ['open', 'supported', 'contradicted', 'refuted', 'inconclusive', 'withdrawn'] as const;
export type HypothesisData = Readonly<{
  questionId: string; explanation: string;
  predictedObservations: readonly Readonly<{ id: string; text: string; observed: 'yes' | 'no' | 'not_tested'; note: string | null }>[];
  contraryTest: string | null; supporting: readonly SourceLink[]; contradicting: readonly SourceLink[]; statusRationale: string | null;
}>;
export function normHypothesis(raw: Record<string, unknown>, questionId: string): { status: string; data: HypothesisData } {
  const status = oneOf(raw.status ?? 'open', HYPOTHESIS_STATUSES, 'status');
  const statusRationale = optText(raw.statusRationale, 'statusRationale');
  invariant(status === 'open' || statusRationale !== null, 'invalid_input', 'A hypothesis status other than open needs statusRationale');
  const predictedObservations = list(raw.predictedObservations, 'predictedObservations', 50).map((p, i) => {
    const o = typeof p === 'string' ? { text: p } as Record<string, unknown> : obj(p, 'predictedObservation');
    return { id: optText(o.id, 'predictedObservation.id', 64) ?? `po${i + 1}`, text: text(o.text, 'predictedObservation.text'), observed: oneOf(o.observed ?? 'not_tested', ['yes', 'no', 'not_tested'] as const, 'observed'), note: optText(o.note, 'predictedObservation.note') };
  });
  return { status, data: { questionId, explanation: text(raw.explanation, 'explanation'), predictedObservations, contraryTest: optText(raw.contraryTest, 'contraryTest'), supporting: links(raw.supporting, 'supporting', false), contradicting: links(raw.contradicting, 'contradicting', false), statusRationale } };
}

export const LEAD_STATUSES = ['new', 'assessing', 'active', 'exhausted', 'dismissed', 'converted'] as const;
export type LeadData = Readonly<{
  kind: 'documentary' | 'person' | 'dataset'; description: string; origin: Readonly<{ type: string; ref: string | null }>; priority: number;
  assessment: string | null; questionIds: readonly string[]; lane: string | null; linkedRefs: readonly string[];
}>;
export function normLead(raw: Record<string, unknown>): { status: string; data: LeadData } {
  const origin = obj(raw.origin ?? { type: 'manual' }, 'origin');
  const status = oneOf(raw.status ?? 'new', LEAD_STATUSES, 'status');
  const assessment = optText(raw.assessment, 'assessment');
  invariant(!['exhausted', 'dismissed'].includes(status) || assessment !== null, 'invalid_input', 'An exhausted or dismissed lead needs an assessment saying why');
  return { status, data: { kind: oneOf(raw.kind, ['documentary', 'person', 'dataset'] as const, 'kind'), description: text(raw.description, 'description'), origin: { type: text(origin.type, 'origin.type', 200), ref: optRef(origin.ref, 'origin.ref') }, priority: Math.round(num(raw.priority, 'priority', 1, 5, 3)), assessment, questionIds: idList(raw.questionIds, 'questionIds'), lane: optText(raw.lane, 'lane', 64), linkedRefs: refList(raw.linkedRefs, 'linkedRefs') } };
}

export const PLAN_KINDS = ['documentary_research', 'interview', 'correspondence', 'processing', 'knowledge', 'verification'] as const;
export const PLAN_STATUSES = ['planned', 'running', 'done', 'failed', 'cancelled', 'skipped'] as const;
export type PlanItemData = Readonly<{
  kind: typeof PLAN_KINDS[number]; questionId: string; hypothesisId: string | null; leadId: string | null; lane: string | null;
  description: string; action: string | null; params: Json; statusNote: string | null; origin: 'human' | 'proposal';
}>;
export function normPlanItem(raw: Record<string, unknown>, actions: readonly string[]): { status: string; data: Omit<PlanItemData, 'origin'> } {
  const status = oneOf(raw.status ?? 'planned', PLAN_STATUSES, 'status');
  const statusNote = optText(raw.statusNote, 'statusNote');
  invariant(!['cancelled', 'skipped', 'failed'].includes(status) || statusNote !== null, 'invalid_input', 'A cancelled, skipped or failed plan item needs statusNote');
  const action = raw.action === undefined || raw.action === null ? null : oneOf(raw.action, actions, 'action');
  return { status, data: { kind: oneOf(raw.kind, PLAN_KINDS, 'kind'), questionId: text(raw.questionId, 'questionId', 128), hypothesisId: optText(raw.hypothesisId, 'hypothesisId', 128), leadId: optText(raw.leadId, 'leadId', 128), lane: optText(raw.lane, 'lane', 64), description: text(raw.description, 'description'), action, params: jsonValue(obj(raw.params ?? {}, 'params'), 'params'), statusNote } };
}

export const CHECKLIST = ['primary_source_checked', 'independence_by_source_family', 'counter_evidence_searched', 'alternative_explanations_addressed', 'subject_response_sought', 'dates_identities_confirmed'] as const;
export type ChecklistKey = typeof CHECKLIST[number];
export type ChecklistItem = Readonly<{ status: 'done' | 'not_done' | 'not_applicable' | 'unset'; note: string | null }>;
export const CLASSIFICATIONS = ['established', 'disputed', 'unknown', 'refuted'] as const;
export const CONFIDENCE = ['well_supported', 'probable', 'possible', 'uncertain'] as const;
export type FindingData = Readonly<{
  statement: string; label: StatementLabel; classification: typeof CLASSIFICATIONS[number]; questionIds: readonly string[];
  supporting: readonly SourceLink[]; contradicting: readonly SourceLink[]; limitations: readonly string[];
  /** Confidence is expressed in words with a stated basis; numeric scores are rejected. */
  confidence: Readonly<{ level: typeof CONFIDENCE[number]; basis: string }>;
  checklist: Readonly<Record<ChecklistKey, ChecklistItem>>;
  authors: readonly string[]; submittedBy: string | null;
  reviews: readonly Readonly<{ at: string; by: string; decision: 'approve' | 'return'; notes: string | null; revision: number; renewed: boolean }>[];
  withdrawal: Readonly<{ at: string; by: string; rationale: string }> | null;
}>;
export function normFinding(raw: Record<string, unknown>): Pick<FindingData, 'statement' | 'label' | 'classification' | 'questionIds' | 'supporting' | 'contradicting' | 'limitations' | 'confidence' | 'checklist'> {
  const c = obj(raw.confidence, 'confidence');
  invariant(typeof c.level === 'string', 'invalid_input', 'confidence.level must be a word, not a score');
  const cl = raw.checklist === undefined || raw.checklist === null ? {} : obj(raw.checklist, 'checklist');
  for (const k of Object.keys(cl)) if (!(CHECKLIST as readonly string[]).includes(k)) bad(`Unknown checklist item ${k}`);
  const checklist = Object.fromEntries(CHECKLIST.map((k) => {
    if (cl[k] === undefined || cl[k] === null) return [k, { status: 'unset', note: null }];
    const o = obj(cl[k], `checklist.${k}`);
    const status = oneOf(o.status, ['done', 'not_done', 'not_applicable', 'unset'] as const, `checklist.${k}.status`);
    const note = optText(o.note, `checklist.${k}.note`, 2000);
    invariant(status === 'done' || status === 'unset' || note !== null, 'invalid_input', `checklist.${k}: not_done and not_applicable need a note`);
    return [k, { status, note }];
  })) as Record<ChecklistKey, ChecklistItem>;
  return {
    statement: text(raw.statement, 'statement'), label: oneOf(raw.label, LABELS, 'label'), classification: oneOf(raw.classification, CLASSIFICATIONS, 'classification'),
    questionIds: idList(raw.questionIds, 'questionIds'), supporting: links(raw.supporting, 'supporting', true), contradicting: links(raw.contradicting, 'contradicting', true),
    limitations: list(raw.limitations, 'limitations', 50).map((l) => text(l, 'limitation', 2000)),
    confidence: { level: oneOf(c.level, CONFIDENCE, 'confidence.level'), basis: text(c.basis, 'confidence.basis', 2000) }, checklist,
  };
}
/** What stops a finding from going to review. An empty list means it may be submitted. */
export function findingDefects(f: FindingData): string[] {
  const out: string[] = [];
  for (const k of CHECKLIST) if (f.checklist[k].status === 'unset') out.push(`verification checklist item ${k} has not been recorded`);
  if (f.limitations.length === 0) out.push('limitations must be stated explicitly (state what was checked if none were identified)');
  if (f.questionIds.length === 0) out.push('the finding must name the question(s) it answers');
  if (f.classification === 'established' || f.classification === 'refuted') {
    if (f.classification === 'established' && f.supporting.length === 0) out.push('an established finding needs at least one supporting source');
    if (f.classification === 'refuted' && f.contradicting.length === 0) out.push('a refuted finding needs at least one contradicting source');
    if (f.checklist.primary_source_checked.status !== 'done') out.push(`a finding classified ${f.classification} requires the primary source to have been checked`);
    if (f.checklist.counter_evidence_searched.status !== 'done') out.push(`a finding classified ${f.classification} requires a search for counter-evidence`);
  }
  if (f.classification === 'disputed' && (f.supporting.length === 0 || f.contradicting.length === 0)) out.push('a disputed finding cites both the supporting and the contradicting sources');
  if (f.label === 'verified_fact' && f.classification !== 'established') out.push('only an established finding may be labelled verified_fact');
  if (f.label === 'unknown' && f.classification !== 'unknown') out.push('a statement labelled unknown must be classified unknown');
  return out;
}

export type ContradictionData = Readonly<{
  description: string; accountExcerpt: string | null; accountRef: string | null; contradicting: readonly SourceLink[];
  questionId: string | null; findingId: string | null; resolutionNote: string | null;
}>;
export function normContradiction(raw: Record<string, unknown>): { status: string; data: ContradictionData } {
  const status = oneOf(raw.status ?? 'open', ['open', 'explained', 'unresolved'] as const, 'status');
  const resolutionNote = optText(raw.resolutionNote, 'resolutionNote');
  invariant(status === 'open' || resolutionNote !== null, 'invalid_input', 'An explained or unresolved contradiction needs resolutionNote');
  const contradicting = links(raw.contradicting, 'contradicting', true);
  invariant(contradicting.length >= 1, 'invalid_input', 'A contradiction cites at least one contradicting source');
  return { status, data: { description: text(raw.description, 'description'), accountExcerpt: optText(raw.accountExcerpt, 'accountExcerpt'), accountRef: optRef(raw.accountRef, 'accountRef'), contradicting, questionId: optText(raw.questionId, 'questionId', 128), findingId: optText(raw.findingId, 'findingId', 128), resolutionNote } };
}
export type UnknownData = Readonly<{ description: string; whyUnknown: string; whatWouldResolve: string | null; questionId: string | null; attemptIds: readonly string[]; resolutionNote: string | null }>;
export function normUnknown(raw: Record<string, unknown>): { status: string; data: UnknownData } {
  const status = oneOf(raw.status ?? 'open', ['open', 'resolved'] as const, 'status');
  const resolutionNote = optText(raw.resolutionNote, 'resolutionNote');
  invariant(status === 'open' || resolutionNote !== null, 'invalid_input', 'A resolved unknown needs resolutionNote');
  return { status, data: { description: text(raw.description, 'description'), whyUnknown: text(raw.whyUnknown, 'whyUnknown'), whatWouldResolve: optText(raw.whatWouldResolve, 'whatWouldResolve'), questionId: optText(raw.questionId, 'questionId', 128), attemptIds: idList(raw.attemptIds, 'attemptIds'), resolutionNote } };
}

export type ProposalData = Readonly<{
  type: 'question' | 'step'; item: Json; rationale: string; proposedBy: Readonly<{ id: string; kind: string }>; source: string | null;
  decision: Readonly<{ by: string; at: string; rationale: string | null; auto: boolean; createdRef: string | null }> | null;
}>;
export type StepData = Readonly<{
  key: string; action: string; executable: boolean; title: string; rationale: string; derivedFrom: string; priority: number;
  questionId: string | null; hypothesisId: string | null; leadId: string | null; planItemId: string | null; findingId: string | null;
  lane: string | null; params: Json; runCount: number; jobId: string | null; lastOutcome: string | null; lastAttemptId: string | null; result: Json; refs: readonly string[];
}>;
export { refOf };
