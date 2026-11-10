// Factual investigation engine (E08) service layer.
// Owns schema e08_investigation. Other engines are reached only through ports and named only by universal reference.
import { DomainError, digest, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import {
  SERVICE_KIT_VERSION, appendAudit, controlJob as kitControlJob, emitEvent, enqueueJob, getJob as kitGetJob, idempotent, listAudit, parseUref, readEvents,
  requireCapability, runJobsOnce, runMigrations, standardRoutes, uref, urefMatches,
} from '../service-kit.ts';
import type { AuditRecord, EngineEvent, EngineManifestV1, Inspection, Job, ObjectStore, Route, SearchHit, ServiceContext, Sql, StandardEngine, UpstreamChange } from '../service-kit.ts';
import {
  ATTEMPT_KINDS, EID, KINDS, NOT_OBTAINED, OUTCOMES, SCHEMA, bump, collectRefs, flagRec, idList, insertAttempt, insertRec, jsonValue, list, listAttemptRows, listRecs, loadRec, migrations,
  notFound, num, obj, oneOf, optRef, optText, refList, refOf, scope, text, toAttempt, updateRec,
} from './store.ts';
import type { Attempt, AttemptInput, AttemptKind, Kind, Outcome, Rec, StaleReason } from './store.ts';
import {
  LABELS, QUESTION_STATUSES, findingDefects, normContradiction, normFinding, normHypothesis, normLanes, normLead, normPlanItem, normPolicy, normQuestion, normUnknown,
} from './model.ts';
import type { ContradictionData, FindingData, HypothesisData, InvestigationData, LeadData, PlanItemData, ProposalData, QuestionData, StepData, UnknownData } from './model.ts';
import { assemblePackage, closureCheck, effortReport, renderHtml, renderMarkdown } from './package.ts';
import type { ChronologyResult, ClosureCheck, EffortReport, EvidenceIndexEntry, Loaded } from './package.ts';
import type { ContactLead, DiscoveryItem, InvestigationPorts, PortEffort } from './ports.ts';

export { SCHEMA, migrations } from './store.ts';
export type { Attempt, AttemptInput, Rec, SourceLink, StaleReason } from './store.ts';
export type * from './model.ts';
export type * from './ports.ts';
export type { ClosureCheck, EffortReport, LaneEffort } from './package.ts';

const S = SCHEMA;
export const manifest: EngineManifestV1 = {
  id: EID, name: 'factual-investigation', version: '1.0.0', kit: SERVICE_KIT_VERSION,
  capabilities: ['investigation:read', 'investigation:write', 'investigation:plan', 'investigation:execute', 'investigation:contact', 'investigation:approve', 'investigation:events'],
  emits: ['investigation.opened', 'investigation.question_opened', 'investigation.outreach_required', 'investigation.lead_exhausted', 'investigation.finding_proposed', 'investigation.finding_approved', 'investigation.finding_returned',
    'investigation.finding_stale', 'investigation.finding_blocked', 'investigation.step_completed', 'investigation.package_built', 'investigation.package_stale', 'investigation.package_blocked', 'investigation.review_ready', 'investigation.closed', 'investigation.reopened'],
  consumes: ['source_corrected', 'source_superseded', 'source_removed', 'permission_withdrawn', 'permission_changed', 'claim_changed', 'content_changed', 'rights_changed'],
};
export function migrate(sql: Sql): Promise<string[]> { return runMigrations(sql, S, migrations); }

/** Executable step actions: which port performs them, how the attempt is classified, and whether they change anything elsewhere. */
export const ACTIONS: Readonly<Record<string, Readonly<{ port: 'discovery' | 'evidence' | 'processing' | 'knowledge' | 'correspondence'; kind: AttemptKind; effect: boolean }>>> = {
  'discovery.search_source': { port: 'discovery', kind: 'search', effect: false },
  'discovery.start_collection': { port: 'discovery', kind: 'acquisition', effect: true },
  'discovery.get_coverage': { port: 'discovery', kind: 'acquisition', effect: false },
  'evidence.describe': { port: 'evidence', kind: 'verification', effect: false },
  'processing.request': { port: 'processing', kind: 'processing', effect: true },
  'processing.get_text': { port: 'processing', kind: 'processing', effect: false },
  'processing.search': { port: 'processing', kind: 'search', effect: false },
  'knowledge.propose_claim': { port: 'knowledge', kind: 'knowledge', effect: true },
  'knowledge.create_link': { port: 'knowledge', kind: 'knowledge', effect: true },
  'knowledge.get_source_families': { port: 'knowledge', kind: 'verification', effect: false },
  'knowledge.get_impact': { port: 'knowledge', kind: 'knowledge', effect: false },
  'knowledge.get_graph': { port: 'knowledge', kind: 'knowledge', effect: false },
  'correspondence.create_contact_plan': { port: 'correspondence', kind: 'contact', effect: true },
  'correspondence.draft_inquiry': { port: 'correspondence', kind: 'contact', effect: true },
  'correspondence.get_thread_state': { port: 'correspondence', kind: 'contact', effect: false },
};
const ACTION_NAMES = Object.keys(ACTIONS);
const PORT_ENGINE: Readonly<Record<string, string>> = { discovery: 'DiscoveryPort (E04)', evidence: 'EvidencePort (E05)', processing: 'ProcessingPort (E06)', knowledge: 'KnowledgePort (E07)', correspondence: 'CorrespondencePort (E03)' };
export const STEP_JOB = 'investigation.step';

export type EngineConfig = Readonly<{
  /** Default true. When true no investigation may let an author review their own finding. */
  requireDistinctReviewer?: boolean;
  /** Upper bound on policy auto-acceptance of proposals per investigation and type. Default 25. */
  autoAcceptCeiling?: number;
  /** Declared cost of an action. A costed action is refused unless a BudgetPort reserves it. */
  stepCosts?: Readonly<Record<string, Readonly<{ category: string; amount: number; unit: string }>>>;
  leaseMs?: number;
  maxLeadsPerStep?: number;
}>;
export type EngineDeps = Readonly<{ sql: Sql; objects?: ObjectStore; ports?: InvestigationPorts; config?: EngineConfig }>;
export type InvestigationOverview = Readonly<Loaded & { closure: ClosureCheck; effort: EffortReport; changeSeq: number; packages: readonly PackageSummary[] }>;
export type PackageSummary = Readonly<{ ref: string; investigationId: string; version: number; digest: string; builtAt: string; builtBy: string; stale: boolean; blocked: boolean; staleReasons: readonly StaleReason[]; current: boolean }>;
export type InvestigationPackage = PackageSummary & Readonly<{ content: Record<string, Json> | null; markdown: string | null; html: string | null }>;
export type NextSteps = Readonly<{ investigationId: string; steps: readonly Rec<StepData>[]; waiting: readonly Rec<StepData>[]; retryable: readonly Rec<StepData>[]; inFlight: readonly Rec<StepData>[]; notes: readonly string[] }>;
type Body = Record<string, unknown>;
type ActionResult = { outcome: Outcome; detail: string; target: string; refs: string[]; result: Json; effort?: PortEffort | undefined; waiting?: boolean; extra?: AttemptInput[]; items?: readonly DiscoveryItem[]; contacts?: readonly ContactLead[]; claimRef?: string };

export type InvestigationEngine = ReturnType<typeof createEngine>;

export function createEngine(deps: EngineDeps) {
  const sql = deps.sql, ports = deps.ports ?? {}, config = deps.config ?? {};
  const engineRules = { requireDistinctReviewer: config.requireDistinctReviewer !== false, autoAcceptCeiling: config.autoAcceptCeiling ?? 25 };

  // ── plumbing ──
  function cmd<T>(ctx: ServiceContext, capability: string, op: string, input: unknown, fn: (tx: Sql) => Promise<T>): Promise<T> {
    requireCapability(ctx, capability);
    const key = input !== null && typeof input === 'object' ? (input as Body).idempotencyKey : undefined;
    invariant(key === undefined || typeof key === 'string', 'invalid_input', 'Invalid idempotency key');
    return sql.tx((tx) => idempotent(tx, S, ctx, key as string | undefined, { op, input }, async () => JSON.parse(JSON.stringify(await fn(tx))) as Json)) as unknown as Promise<T>;
  }
  const emit = (tx: Sql, ctx: ServiceContext, type: string, subject: string, payload: Json): Promise<EngineEvent> => emitEvent(tx, S, ctx, type, subject, payload);
  /** mode: read | lock (row lock) | mutate (row lock and the investigation must not be closed). */
  async function inv(q: Sql, ctx: ServiceContext, id: string, mode: 'read' | 'lock' | 'mutate' = 'read'): Promise<Rec<InvestigationData>> {
    const rec = await loadRec<InvestigationData>(q, ctx, 'investigation', id, mode !== 'read');
    if (mode === 'mutate' && rec.state === 'closed') throw new DomainError('invalid_state', 'The investigation is closed; reopen it with a reason before changing it');
    return rec;
  }
  async function child<T>(q: Sql, ctx: ServiceContext, kind: Kind, id: string, mode: 'read' | 'lock' | 'mutate' = 'read'): Promise<[Rec<T>, Rec<InvestigationData>]> {
    const first = await loadRec<T>(q, ctx, kind, id);
    const i = await inv(q, ctx, first.investigationId, mode);
    return [mode === 'read' ? first : await loadRec<T>(q, ctx, kind, id, true), i];
  }
  /** A referenced record must exist inside the same investigation. */
  async function need<T>(q: Sql, ctx: ServiceContext, kind: Kind, id: string | null, investigationId: string): Promise<Rec<T> | null> {
    if (id === null) return null;
    let rec: Rec<T>;
    try { rec = await loadRec<T>(q, ctx, kind, id); } catch { throw new DomainError('invalid_input', `Unknown ${kind} ${id}`); }
    invariant(rec.investigationId === investigationId, 'invalid_input', `Unknown ${kind} ${id}`);
    return rec;
  }
  function laneFor(i: Rec<InvestigationData>, kind: AttemptKind, explicit: string | null | undefined): string | null {
    if (explicit !== undefined && explicit !== null) { invariant(i.data.lanes.some((l) => l.id === explicit), 'invalid_input', `Unknown lane ${explicit}`); return explicit; }
    return i.data.lanes.find((l) => l.attemptKinds.includes(kind))?.id ?? null;
  }
  const logAttempt = (tx: Sql, ctx: ServiceContext, i: Rec<InvestigationData>, a: AttemptInput): Promise<Attempt> => insertAttempt(tx, ctx, i.id, i.data.compartment, { ...a, lane: laneFor(i, a.kind, a.lane) });
  async function load(q: Sql, ctx: ServiceContext, id: string): Promise<Loaded> {
    const investigation = await inv(q, ctx, id);
    const l = <T>(kind: Kind): Promise<Rec<T>[]> => listRecs<T>(q, ctx, kind, id);
    return { investigation, questions: await l<QuestionData>('question'), hypotheses: await l<HypothesisData>('hypothesis'), leads: await l<LeadData>('lead'), planItems: await l<PlanItemData>('plan_item'), findings: await l<FindingData>('finding'),
      contradictions: await l<ContradictionData>('contradiction'), unknowns: await l<UnknownData>('unknown'), proposals: await l<ProposalData>('proposal'), steps: await l<StepData>('step'), attempts: await listAttemptRows(q, ctx, id) };
  }
  async function changeSeq(q: Sql, ctx: ServiceContext, id: string): Promise<number> {
    return Number(((await q.query<{ change_seq: string }>(`select change_seq::text as change_seq from ${S}.counters where tenant_id=$1 and project_id=$2 and investigation_id=$3`, [...scope(ctx), id]))[0] as { change_seq: string }).change_seq);
  }
  const pkgSummary = (r: Record<string, unknown>, seq: number): PackageSummary => ({ ref: uref(EID, 'investigation_package', r.investigation_id as string, r.version as number), investigationId: r.investigation_id as string, version: r.version as number, digest: r.digest as string, builtAt: new Date(r.built_at as Date).toISOString(), builtBy: r.built_by as string, stale: r.stale as boolean, blocked: r.blocked as boolean, staleReasons: r.stale_reasons as StaleReason[], current: Number(r.change_seq) === seq && !(r.stale as boolean) && !(r.blocked as boolean) });
  async function packagesOf(q: Sql, ctx: ServiceContext, id: string): Promise<PackageSummary[]> {
    const seq = await changeSeq(q, ctx, id);
    return (await q.query(`select investigation_id, version, digest, built_at, built_by, stale, blocked, stale_reasons, change_seq::text as change_seq from ${S}.packages where tenant_id=$1 and project_id=$2 and investigation_id=$3 order by version`, [...scope(ctx), id])).map((r) => pkgSummary(r, seq));
  }

  // ── questions ──
  async function createQuestion(tx: Sql, ctx: ServiceContext, i: Rec<InvestigationData>, raw: Body, origin: 'human' | 'proposal'): Promise<Rec<QuestionData>> {
    const n = normQuestion(raw);
    await need(tx, ctx, 'question', n.parentId, i.id);
    const q = await insertRec<QuestionData>(tx, ctx, 'question', i.id, i.data.compartment, 'open', { ...n, findingIds: [], answer: null, answerLabel: null, rationale: null, origin, dispositionBy: null, dispositionAt: null }, 'question opened');
    await bump(tx, ctx, i.id);
    await emit(tx, ctx, 'investigation.question_opened', uref(EID, 'question', q.id), { investigationId: i.id, material: n.material, parentId: n.parentId, origin });
    return q;
  }
  async function createPlanItem(tx: Sql, ctx: ServiceContext, i: Rec<InvestigationData>, raw: Body, origin: 'human' | 'proposal'): Promise<Rec<PlanItemData>> {
    const n = normPlanItem(raw, ACTION_NAMES);
    await need(tx, ctx, 'question', n.data.questionId, i.id); await need(tx, ctx, 'hypothesis', n.data.hypothesisId, i.id); await need(tx, ctx, 'lead', n.data.leadId, i.id);
    if (n.data.lane !== null) laneFor(i, 'other', n.data.lane);
    const p = await insertRec<PlanItemData>(tx, ctx, 'plan_item', i.id, i.data.compartment, n.status, { ...n.data, origin }, 'plan item added');
    await bump(tx, ctx, i.id);
    if (n.data.kind === 'interview' || n.data.kind === 'correspondence') await emit(tx, ctx, 'investigation.outreach_required', uref(EID, 'question', n.data.questionId), { investigationId: i.id, planItemId: p.id, kind: n.data.kind });
    return p;
  }

  // ── executing one step through a port ──
  async function perform(ctx: ServiceContext, action: string, params: Body, at: { subject: string; question: string | null; idem: string }): Promise<ActionResult> {
    const spec = ACTIONS[action];
    if (spec === undefined) return { outcome: 'failed', detail: `Unknown action ${action}`, target: action, refs: [], result: null };
    const missing = (): ActionResult => ({ outcome: 'unavailable', detail: `${PORT_ENGINE[spec.port]} is not configured in this deployment`, target: action, refs: [], result: null });
    switch (action) {
      case 'discovery.search_source': {
        if (ports.discovery === undefined) return missing();
        const query = text(params.query, 'query', 2000), sourceId = optText(params.sourceId, 'sourceId', 300);
        const r = await ports.discovery.searchSource(ctx, { query, ...(sourceId === null ? {} : { sourceId }), limit: Math.round(num(params.limit, 'limit', 1, 200, 25)) });
        const restricted = r.restricted ?? [];
        const extra: AttemptInput[] = restricted.map((s) => ({ kind: 'search', target: `source ${s}`, method: action, outcome: 'access_restricted', detail: `Source could not be searched for: ${query}` }));
        return { outcome: r.items.length > 0 ? 'succeeded' : restricted.length > 0 && r.searched.length === 0 ? 'access_restricted' : 'zero_result', detail: `${r.items.length} item(s) from ${r.searched.length} source(s) searched${restricted.length > 0 ? `; ${restricted.length} source(s) access-restricted` : ''}`, target: `${sourceId ?? 'configured sources'}: ${query}`, refs: r.items.flatMap((x) => [x.ref, ...(x.evidenceRef === undefined ? [] : [x.evidenceRef])]), result: { items: r.items.length, searched: [...r.searched], restricted: [...restricted] }, effort: r.effort, items: r.items, extra: r.items.length > 0 || r.searched.length === 0 ? extra : extra };
      }
      case 'discovery.start_collection': {
        if (ports.discovery === undefined) return missing();
        const query = text(params.query, 'query', 2000);
        const r = await ports.discovery.startCollectionRun(ctx, { subject: at.subject, objective: optText(params.objective, 'objective') ?? at.question ?? query, query, sourceIds: list(params.sourceIds, 'sourceIds', 100).map((s) => text(s, 'sourceId', 300)), idempotencyKey: at.idem });
        return { outcome: 'succeeded', detail: `collection run ${r.state}`, target: query, refs: [refOf(r.runRef, 'runRef')], result: { runRef: r.runRef, state: r.state }, effort: r.effort };
      }
      case 'discovery.get_coverage': {
        if (ports.discovery === undefined) return missing();
        const runRef = refOf(params.runRef, 'runRef');
        const r = await ports.discovery.getCoverage(ctx, runRef);
        const running = r.state === 'queued' || r.state === 'running';
        const extra: AttemptInput[] = running ? [] : r.sources.filter((s) => s.status !== 'searched').map((s) => ({ kind: 'acquisition', target: `source ${s.sourceId}`, method: action, outcome: (s.status === 'not_attempted' ? 'unavailable' : s.status) as Outcome, detail: s.note ?? `Source reported ${s.status} in ${runRef}`, refs: [runRef] }));
        const outcome: Outcome = running ? 'partial' : r.state !== 'completed' ? 'failed' : r.items.length > 0 ? (extra.length > 0 ? 'partial' : 'succeeded') : r.sources.some((s) => s.status === 'access_restricted') ? 'access_restricted' : 'zero_result';
        return { outcome, detail: running ? `run is ${r.state}; coverage not final` : `run ${r.state}: ${r.items.length} item(s), ${r.contactLeads.length} contact lead(s), ${extra.length} source(s) not obtained`, target: runRef, refs: [runRef, ...r.items.flatMap((x) => [x.ref, ...(x.evidenceRef === undefined ? [] : [x.evidenceRef])]), ...r.contactLeads.map((c) => c.ref)], result: { state: r.state, sources: r.sources as unknown as Json, items: r.items.length, contactLeads: r.contactLeads.length }, effort: r.effort, waiting: running, extra, items: running ? [] : r.items, contacts: running ? [] : r.contactLeads };
      }
      case 'evidence.describe': {
        if (ports.evidence === undefined) return missing();
        const ref = refOf(params.ref, 'ref');
        const r = await ports.evidence.describe(ctx, ref);
        if (r === null) return { outcome: 'access_restricted', detail: 'Evidence version is not present or not accessible in this scope', target: ref, refs: [ref], result: null };
        return { outcome: r.available ? 'succeeded' : 'unavailable', detail: r.available ? `sha256 ${r.sha256}` : 'Evidence bytes are not available', target: ref, refs: [ref], result: { sha256: r.sha256, size: r.size, mediaType: r.mediaType, available: r.available } };
      }
      case 'processing.request': {
        if (ports.processing === undefined) return missing();
        const evidenceRef = refOf(params.evidenceRef, 'evidenceRef');
        const r = await ports.processing.requestProcessing(ctx, { evidenceRef, operations: list(params.operations, 'operations', 20).map((o) => text(o, 'operation', 100)), idempotencyKey: at.idem });
        return { outcome: 'succeeded', detail: `processing ${r.state}`, target: evidenceRef, refs: [evidenceRef, refOf(r.jobRef, 'jobRef')], result: { jobRef: r.jobRef, state: r.state, evidenceRef }, effort: r.effort };
      }
      case 'processing.get_text': {
        if (ports.processing === undefined) return missing();
        const evidenceRef = refOf(params.evidenceRef, 'evidenceRef');
        const r = await ports.processing.getText(ctx, evidenceRef);
        if (!r.available) return { outcome: 'unavailable', detail: r.reason ?? 'No text is available for this evidence version', target: evidenceRef, refs: [evidenceRef], result: { available: false }, waiting: params.await === true };
        return { outcome: (r.text ?? '').trim() === '' && (r.segments ?? []).length === 0 ? 'zero_result' : 'succeeded', detail: `${(r.text ?? '').length} character(s), ${(r.segments ?? []).length} segment(s)`, target: evidenceRef, refs: [evidenceRef, ...(r.derivativeRef === undefined ? [] : [r.derivativeRef])], result: { available: true, characters: (r.text ?? '').length, segments: (r.segments ?? []).length, derivativeRef: r.derivativeRef ?? null } };
      }
      case 'processing.search': {
        if (ports.processing === undefined) return missing();
        const query = text(params.query, 'query', 2000);
        const r = await ports.processing.search(ctx, { query, evidenceRefs: refList(params.evidenceRefs, 'evidenceRefs'), limit: Math.round(num(params.limit, 'limit', 1, 200, 25)) });
        return { outcome: r.hits.length > 0 ? 'succeeded' : 'zero_result', detail: `${r.hits.length} hit(s)`, target: query, refs: [...new Set(r.hits.map((h) => h.evidenceRef))], result: { hits: r.hits.slice(0, 50).map((h) => ({ evidenceRef: h.evidenceRef, selector: h.selector })) } };
      }
      case 'knowledge.propose_claim': {
        if (ports.knowledge === undefined) return missing();
        const statement = text(params.statement, 'statement');
        const r = await ports.knowledge.proposeClaim(ctx, { subject: at.subject, statement, label: oneOf(params.label ?? 'allegation', LABELS, 'label'), sources: list(params.sources, 'sources', 50).map((s) => { const o = obj(s, 'source'); return { ref: refOf(o.ref, 'source.ref'), ...(o.selector === undefined || o.selector === null ? {} : { selector: jsonValue(o.selector, 'selector', 4000) }) }; }), idempotencyKey: at.idem });
        return { outcome: 'succeeded', detail: `claim ${r.state}`, target: statement.slice(0, 300), refs: [refOf(r.claimRef, 'claimRef')], result: { claimRef: r.claimRef, state: r.state }, claimRef: r.claimRef };
      }
      case 'knowledge.create_link': {
        if (ports.knowledge === undefined) return missing();
        const from = refOf(params.from, 'from'), to = refOf(params.to, 'to');
        const r = await ports.knowledge.createLink(ctx, { from, to, relation: text(params.relation, 'relation', 100), idempotencyKey: at.idem });
        return { outcome: 'succeeded', detail: 'link recorded', target: `${from} → ${to}`, refs: [from, to, refOf(r.linkRef, 'linkRef')], result: { linkRef: r.linkRef } };
      }
      case 'knowledge.get_source_families': {
        if (ports.knowledge === undefined) return missing();
        const refs = refList(params.refs, 'refs');
        const r = await ports.knowledge.getSourceFamilies(ctx, refs);
        return { outcome: r.length === 0 ? 'zero_result' : 'succeeded', detail: `${refs.length} source(s) fall into ${r.length} independent source famil${r.length === 1 ? 'y' : 'ies'}`, target: `${refs.length} source(s)`, refs, result: { families: r as unknown as Json, independent: r.length } };
      }
      case 'knowledge.get_impact': {
        if (ports.knowledge === undefined) return missing();
        const ref = refOf(params.ref, 'ref');
        const r = await ports.knowledge.getImpact(ctx, ref);
        return { outcome: 'succeeded', detail: `${r.dependents.length} dependent(s)`, target: ref, refs: [ref, ...r.dependents], result: { dependents: [...r.dependents] } };
      }
      case 'knowledge.get_graph': {
        if (ports.knowledge === undefined) return missing();
        const claimRefs = refList(params.claimRefs, 'claimRefs');
        const r = await ports.knowledge.getGraph(ctx, { claimRefs });
        return { outcome: r.nodes.length === 0 ? 'zero_result' : 'succeeded', detail: `${r.nodes.length} node(s), ${r.edges.length} edge(s)`, target: `${claimRefs.length} claim(s)`, refs: claimRefs, result: { nodes: r.nodes.length, edges: r.edges.length } };
      }
      case 'correspondence.create_contact_plan': {
        if (ports.correspondence === undefined) return missing();
        const contactLeadRef = optRef(params.contactLeadRef, 'contactLeadRef');
        const r = await ports.correspondence.createContactPlan(ctx, { subject: at.subject, question: optText(params.question, 'question') ?? at.question ?? bad('question is required'), ...(contactLeadRef === null ? {} : { contactLeadRef }), purpose: optText(params.purpose, 'purpose') ?? 'Seek information and a response for an investigation question', idempotencyKey: at.idem });
        return { outcome: 'succeeded', detail: `contact plan ${r.state}; nothing has been sent`, target: contactLeadRef ?? 'contact to be identified', refs: [refOf(r.planRef, 'planRef'), ...(contactLeadRef === null ? [] : [contactLeadRef])], result: { planRef: r.planRef, state: r.state } };
      }
      case 'correspondence.draft_inquiry': {
        if (ports.correspondence === undefined) return missing();
        const contactPlanRef = optRef(params.contactPlanRef, 'contactPlanRef'), contactLeadRef = optRef(params.contactLeadRef, 'contactLeadRef');
        const questions = list(params.questions, 'questions', 30).map((q) => text(q, 'question'));
        const r = await ports.correspondence.draftInquiry(ctx, { subject: at.subject, questions: questions.length > 0 ? questions : [at.question ?? bad('questions are required')], ...(contactPlanRef === null ? {} : { contactPlanRef }), ...(contactLeadRef === null ? {} : { contactLeadRef }), idempotencyKey: at.idem });
        return { outcome: 'succeeded', detail: `inquiry draft ${r.state}; not sent by this engine`, target: contactLeadRef ?? contactPlanRef ?? 'inquiry', refs: [refOf(r.draftRef, 'draftRef'), ...(r.threadRef === undefined ? [] : [refOf(r.threadRef, 'threadRef')])], result: { draftRef: r.draftRef, threadRef: r.threadRef ?? null, state: r.state } };
      }
      case 'correspondence.get_thread_state': {
        if (ports.correspondence === undefined) return missing();
        const threadRef = refOf(params.threadRef, 'threadRef');
        const r = await ports.correspondence.getThreadState(ctx, threadRef);
        const refused = ['refused', 'declined', 'bounced', 'undeliverable'].includes(r.state), closed = ['closed', 'expired', 'no_response'].includes(r.state);
        const outcome: Outcome = r.replies.length > 0 ? 'succeeded' : refused ? 'refused' : closed ? 'zero_result' : 'partial';
        return { outcome, detail: `thread ${r.state}; ${r.replies.length} repl${r.replies.length === 1 ? 'y' : 'ies'}`, target: threadRef, refs: [threadRef, ...r.replies.flatMap((x) => [x.ref, ...(x.evidenceRef === undefined ? [] : [x.evidenceRef])])], result: { state: r.state, replies: r.replies as unknown as Json }, waiting: outcome === 'partial' };
      }
      default: return { outcome: 'failed', detail: `Unknown action ${action}`, target: action, refs: [], result: null };
    }
  }
  function bad(message: string): never { throw new DomainError('invalid_input', message); }
  /** Port failures become recorded outcomes. Messages of non-domain errors are not stored: they can carry provider detail. */
  function failure(error: unknown, action: string, effect: boolean): ActionResult {
    if (error instanceof DomainError) {
      const c = error.code;
      const outcome: Outcome = ['forbidden', 'consent_denied', 'budget_exhausted', 'grant_invalid', 'unauthenticated'].includes(c) ? 'refused' : ['not_found', 'scope_denied', 'access_restricted'].includes(c) ? 'access_restricted' : ['unavailable', 'provider_unavailable', 'rate_limited'].includes(c) ? 'unavailable' : 'failed';
      return { outcome, detail: `${c}: ${error.message}`.slice(0, 500), target: action, refs: [], result: { error: c } };
    }
    return { outcome: effect ? 'uncertain' : 'failed', detail: effect ? 'The call ended without a definite answer; the external outcome is unknown and must be reconciled by re-running the step' : 'The call failed without a definite answer', target: action, refs: [], result: { error: 'port_error' } };
  }

  async function runStepJob(job: Job): Promise<Json> {
    const payload = job.payload as { stepId: string };
    const ctx: ServiceContext = { ...job.ctx, now: new Date().toISOString() };
    const stillMine = async (): Promise<void> => {
      const j = await kitGetJob(sql, S, ctx, job.id);
      if (j === null || j.state !== 'leased' || j.generation !== job.generation || j.leaseOwner !== job.leaseOwner) throw new DomainError('lease_lost', 'Job was paused, cancelled or taken over');
    };
    const begin = await sql.tx(async (tx) => {
      const [step, i] = await child<StepData>(tx, ctx, 'step', payload.stepId, 'lock');
      if (step.data.jobId !== job.id || !['queued', 'running'].includes(step.state)) return null;
      if (i.state === 'closed') { await updateRec(tx, ctx, step, { state: 'cancelled' }, 'investigation closed before the step ran'); return null; }
      const question = step.data.questionId === null ? null : (await loadRec<QuestionData>(tx, ctx, 'question', step.data.questionId)).data.text;
      return { step: step.state === 'queued' ? await updateRec(tx, ctx, step, { state: 'running' }, 'step started') : step, question };
    });
    if (begin === null) return { skipped: true };
    const { step } = begin, spec = ACTIONS[step.data.action], stepRef = uref(EID, 'step', step.id);
    await stillMine();
    let result: ActionResult | undefined;
    let reservation: string | undefined;
    const cost = config.stepCosts?.[step.data.action];
    try {
      requireCapability(ctx, 'investigation:execute');
      if (spec?.port === 'correspondence') requireCapability(ctx, 'investigation:contact');
      if (ports.authorization !== undefined) {
        const decision = await ports.authorization.authorize(ctx, { capability: spec?.port === 'correspondence' ? 'investigation:contact' : 'investigation:execute', resource: stepRef });
        if (!decision.allowed) throw new DomainError('forbidden', `Authorization denied: ${decision.reason}`);
      }
      if (cost !== undefined) {
        if (ports.budget === undefined) throw new DomainError('budget_exhausted', 'This action has a declared cost and no BudgetPort is configured to reserve it');
        reservation = (await ports.budget.reserve(ctx, { category: cost.category, amount: cost.amount, unit: cost.unit, subject: stepRef, idempotencyKey: `${step.id}:${step.data.runCount}` })).reservationId;
      }
      await stillMine(); // pause and cancel are honoured immediately before the side effect
      result = await perform(ctx, step.data.action, obj(step.data.params ?? {}, 'params'), { subject: uref(EID, 'investigation', step.investigationId), question: begin.question, idem: `${EID}:step:${step.id}` });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'lease_lost') { if (reservation !== undefined) await ports.budget?.release(ctx, reservation, 'step paused or cancelled before execution'); throw error; }
      result = failure(error, step.data.action, spec?.effect === true);
    }
    const r = result;
    let spent = 0;
    if (reservation !== undefined && ports.budget !== undefined) {
      if (['succeeded', 'partial', 'zero_result', 'uncertain'].includes(r.outcome)) { await ports.budget.commit(ctx, reservation, { amount: (cost as { amount: number }).amount, detail: { step: stepRef, outcome: r.outcome } }); spent = (cost as { amount: number }).amount; }
      else await ports.budget.release(ctx, reservation, `step outcome ${r.outcome}`);
    }
    return sql.tx(async (tx) => {
      const [cur, i] = await child<StepData>(tx, ctx, 'step', step.id, 'lock');
      if (cur.data.jobId !== job.id || !['running', 'cancelled', 'queued'].includes(cur.state)) return { skipped: true };
      const base = { questionId: cur.data.questionId, hypothesisId: cur.data.hypothesisId, leadId: cur.data.leadId, planItemId: cur.data.planItemId, stepId: cur.id, lane: cur.data.lane };
      const attempt = await logAttempt(tx, ctx, i, { ...base, kind: spec?.kind ?? 'other', target: r.target, method: cur.data.action, outcome: r.outcome, detail: cur.state === 'cancelled' ? `${r.detail} (completed after the step was cancelled)` : r.detail, refs: [...new Set(r.refs)].slice(0, 500), effort: { timeMinutes: r.effort?.timeMinutes ?? 0, attempts: 1, costUnits: (r.effort?.costUnits ?? 0) + spent } });
      for (const x of r.extra ?? []) await logAttempt(tx, ctx, i, { ...base, ...x, effort: { attempts: 0 } });
      const existing = (await listRecs<LeadData>(tx, ctx, 'lead', i.id)).flatMap((l) => l.data.linkedRefs);
      const fresh = [...(r.items ?? []).map((it) => ({ kind: 'documentary' as const, description: it.title, refs: [it.ref, ...(it.evidenceRef === undefined ? [] : [it.evidenceRef])] })), ...(r.contacts ?? []).map((c) => ({ kind: 'person' as const, description: c.role === undefined ? c.label : `${c.label} (${c.role})`, refs: [c.ref] }))]
        .filter((l) => !existing.includes(l.refs[0] as string)).slice(0, config.maxLeadsPerStep ?? 25);
      for (const l of fresh) await insertRec<LeadData>(tx, ctx, 'lead', i.id, i.data.compartment, 'new', { kind: l.kind, description: l.description.slice(0, 4000) || 'Untitled item', origin: { type: cur.data.action, ref: null }, priority: 3, assessment: null, questionIds: cur.data.questionId === null ? [] : [cur.data.questionId], lane: null, linkedRefs: l.refs }, `lead from ${cur.data.action}`);
      if (r.claimRef !== undefined && cur.data.questionId !== null) {
        const q = await loadRec<QuestionData>(tx, ctx, 'question', cur.data.questionId, true);
        if (!q.data.claimRefs.includes(r.claimRef)) await updateRec(tx, ctx, q, { data: { ...q.data, claimRefs: [...q.data.claimRefs, r.claimRef] } }, 'claim proposed for this question');
      }
      const state = cur.state === 'cancelled' ? 'cancelled' : r.waiting === true ? 'waiting' : ['succeeded', 'partial', 'zero_result', 'access_restricted'].includes(r.outcome) ? 'done' : r.outcome === 'uncertain' ? 'uncertain' : r.outcome === 'failed' ? 'failed' : 'blocked';
      if (cur.data.planItemId !== null) {
        const p = await loadRec<PlanItemData>(tx, ctx, 'plan_item', cur.data.planItemId, true);
        const ps = state === 'done' ? 'done' : state === 'failed' ? 'failed' : state === 'waiting' ? 'running' : 'planned';
        if (['planned', 'running'].includes(p.state) && p.state !== ps) await updateRec(tx, ctx, p, { state: ps, data: { ...p.data, statusNote: `${cur.data.action}: ${r.outcome}` } }, `step ${r.outcome}`);
      }
      await updateRec(tx, ctx, cur, { state, data: { ...cur.data, lastOutcome: r.outcome, lastAttemptId: attempt.id, result: r.result, refs: [...new Set(r.refs)].slice(0, 500) } }, `step ${r.outcome}`);
      await emit(tx, ctx, 'investigation.step_completed', stepRef, { investigationId: i.id, action: cur.data.action, outcome: r.outcome, state, attemptId: attempt.id });
      return { stepId: cur.id, state, outcome: r.outcome, attemptId: attempt.id, refs: [...new Set(r.refs)].slice(0, 100) };
    });
  }

  // ── planner ──
  type Derived = Pick<StepData, 'action' | 'title' | 'rationale' | 'derivedFrom' | 'priority' | 'questionId' | 'hypothesisId' | 'leadId' | 'planItemId' | 'findingId' | 'lane' | 'params'>;
  function derive(s: Loaded, gaps: readonly { id: string; kind: string; description: string; claimRef?: string; evidenceRef?: string; contactLeadRef?: string }[]): Derived[] {
    const out: Derived[] = [];
    const none = { questionId: null, hypothesisId: null, leadId: null, planItemId: null, findingId: null, lane: null, params: {} as Json };
    const material = new Set(s.questions.filter((q) => q.data.material).map((q) => q.id));
    for (const f of s.findings) {
      if (f.state === 'approved' && f.stale && !f.blocked) out.push({ ...none, action: 'manual.re_review_finding', findingId: f.id, priority: 10, derivedFrom: 'stale_finding', title: `Renew the review of a stale finding: ${f.data.statement}`, rationale: f.staleReasons.filter((r) => r.resolved !== true).map((r) => `${r.kind}: ${r.reason}`).join('; ') });
      if (f.blocked && f.state !== 'withdrawn') out.push({ ...none, action: 'manual.revise_blocked_finding', findingId: f.id, priority: 11, derivedFrom: 'blocked_finding', title: `Revise or withdraw a finding whose source permission was withdrawn: ${f.data.statement}`, rationale: 'A cited source may no longer be used.' });
      if (f.state === 'in_review') out.push({ ...none, action: 'manual.review_finding', findingId: f.id, priority: 15, derivedFrom: 'finding_in_review', title: `Review finding: ${f.data.statement}`, rationale: 'Submitted and awaiting a reviewer other than its author.' });
      if (f.state === 'returned') out.push({ ...none, action: 'manual.revise_finding', findingId: f.id, priority: 16, derivedFrom: 'finding_returned', title: `Revise returned finding: ${f.data.statement}`, rationale: f.data.reviews.at(-1)?.notes ?? 'Returned by the reviewer.' });
      if (f.state === 'draft') { const defects = findingDefects(f.data); if (defects.length > 0) out.push({ ...none, action: 'manual.complete_verification', findingId: f.id, priority: 80, derivedFrom: 'finding_draft', title: `Complete verification of draft finding: ${f.data.statement}`, rationale: defects.join('; ') }); }
    }
    for (const q of s.questions) {
      if (q.state !== 'open' && q.state !== 'in_progress') continue;
      const p = q.data.material ? 20 : 70, base = { ...none, questionId: q.id };
      const hyps = s.hypotheses.filter((h) => h.data.questionId === q.id && h.state !== 'withdrawn');
      const items = s.planItems.filter((x) => x.data.questionId === q.id && x.state !== 'cancelled');
      const leads = s.leads.filter((l) => l.data.questionIds.includes(q.id));
      const tried = s.attempts.filter((a) => a.questionId === q.id);
      if (hyps.length === 0) out.push({ ...base, action: 'manual.formulate_explanations', priority: p, derivedFrom: 'open_question', title: `Formulate competing explanations for: ${q.data.text}`, rationale: 'The question has no recorded explanation to test.' });
      else if (hyps.length === 1) out.push({ ...base, action: 'manual.add_competing_explanation', priority: p + 1, derivedFrom: 'open_question', title: `Add at least one competing explanation for: ${q.data.text}`, rationale: 'A single explanation cannot be weighed against an alternative.' });
      for (const h of hyps) if (h.state === 'open' && h.data.supporting.length + h.data.contradicting.length === 0 && !items.some((x) => x.data.hypothesisId === h.id) && !tried.some((a) => a.hypothesisId === h.id))
        out.push({ ...base, hypothesisId: h.id, action: 'manual.design_test', priority: p + 2, derivedFrom: 'untested_hypothesis', title: `Plan a test for the explanation: ${h.data.explanation}`, rationale: h.data.contraryTest === null ? 'No plan item, attempt or evidence tests this explanation.' : `No plan item, attempt or evidence tests this explanation. Contrary test: ${h.data.contraryTest}` });
      if (items.length === 0 && leads.length === 0 && tried.length === 0) out.push({ ...base, action: 'discovery.search_source', priority: p + 3, derivedFrom: 'open_question', params: { query: q.data.text }, title: `Search configured sources for: ${q.data.text}`, rationale: 'Nothing has been planned or attempted for this question yet.' });
      if (hyps.length > 0 && !items.some((x) => ['planned', 'running'].includes(x.state)) && (items.length > 0 || tried.length > 0)) out.push({ ...base, action: 'manual.record_disposition', priority: p + 9, derivedFrom: 'open_question', title: `Record a disposition for: ${q.data.text}`, rationale: 'Planned work is finished: answer the question from approved findings, or record it as unresolvable or out of scope with a rationale.' });
    }
    for (const x of s.planItems) if (x.state === 'planned') out.push({ ...none, questionId: x.data.questionId, hypothesisId: x.data.hypothesisId, leadId: x.data.leadId, planItemId: x.id, lane: x.data.lane, action: x.data.action ?? 'manual.perform_plan_item', params: x.data.action === null ? {} : x.data.params, priority: material.has(x.data.questionId) ? 40 : 75, derivedFrom: 'plan_item', title: x.data.description, rationale: `Unexecuted ${x.data.kind} plan item.` });
    for (const g of gaps) {
      const q = g.claimRef === undefined ? undefined : s.questions.find((x) => x.data.claimRefs.some((c) => urefMatches(c, g.claimRef as string) || urefMatches(g.claimRef as string, c)));
      const base = { ...none, questionId: q?.id ?? null, priority: 50, derivedFrom: 'knowledge_gap', rationale: `Gap reported by the knowledge engine (${g.kind}${g.claimRef === undefined ? '' : `, ${g.claimRef}`}).` };
      if (['no_subject_response', 'response_missing', 'needs_response'].includes(g.kind)) out.push({ ...base, action: 'correspondence.create_contact_plan', params: { question: g.description, ...(g.contactLeadRef === undefined ? {} : { contactLeadRef: g.contactLeadRef }), gapId: g.id }, title: `Plan contact to seek a response: ${g.description}` });
      else if (g.kind === 'unprocessed' && g.evidenceRef !== undefined) out.push({ ...base, action: 'processing.request', params: { evidenceRef: g.evidenceRef, operations: ['text'], gapId: g.id }, title: `Process evidence to close a gap: ${g.description}` });
      else if (['missing_source', 'unsupported', 'single_source_family', 'independence', 'no_primary_source', 'missing_date'].includes(g.kind)) out.push({ ...base, action: 'discovery.search_source', params: { query: g.description, gapId: g.id }, title: `Search for ${['single_source_family', 'independence'].includes(g.kind) ? 'an independent source' : 'a source'}: ${g.description}` });
      else out.push({ ...base, action: 'manual.resolve_gap', params: { gapId: g.id, kind: g.kind }, title: `Resolve gap: ${g.description}` });
    }
    for (const l of s.leads) {
      if (l.state === 'new') out.push({ ...none, leadId: l.id, questionId: l.data.questionIds[0] ?? null, action: 'manual.assess_lead', priority: 60 - l.data.priority, derivedFrom: 'lead', title: `Assess ${l.data.kind} lead: ${l.data.description}`, rationale: 'New lead not yet assessed.' });
      const contact = l.data.linkedRefs.find((r) => /^E0[34]:/.test(r));
      if (l.state === 'active' && l.data.kind === 'person' && contact !== undefined && l.data.questionIds[0] !== undefined && !s.planItems.some((x) => x.data.leadId === l.id))
        out.push({ ...none, leadId: l.id, questionId: l.data.questionIds[0], action: 'correspondence.create_contact_plan', params: { contactLeadRef: contact }, priority: 62, derivedFrom: 'lead', title: `Plan contact with: ${l.data.description}`, rationale: 'Active person lead with no interview or correspondence plan.' });
    }
    for (const st of s.steps) {
      if (st.state !== 'done') continue;
      const res = (st.data.result ?? {}) as Record<string, Json>;
      const base = { ...none, questionId: st.data.questionId, lane: st.data.lane, derivedFrom: 'follow_up', rationale: `Follow-up of ${st.data.action}.` };
      if (st.data.action === 'discovery.start_collection' && typeof res.runRef === 'string') out.push({ ...base, action: 'discovery.get_coverage', params: { runRef: res.runRef }, priority: 45, title: `Collect coverage, items and contact leads of ${res.runRef}` });
      if (st.data.action === 'processing.request' && typeof res.evidenceRef === 'string') out.push({ ...base, action: 'processing.get_text', params: { evidenceRef: res.evidenceRef, await: true }, priority: 46, title: `Read processed text of ${res.evidenceRef}` });
      if (st.data.action === 'correspondence.draft_inquiry' && typeof res.threadRef === 'string') out.push({ ...base, action: 'correspondence.get_thread_state', params: { threadRef: res.threadRef }, priority: 65, title: `Check for replies in ${res.threadRef}` });
    }
    return out;
  }

  // ── upstream ──
  async function gatherPorts(ctx: ServiceContext, s: Loaded): Promise<{ evidence: EvidenceIndexEntry[]; chronology: ChronologyResult; notes: string[]; attempts: AttemptInput[] }> {
    const notes: string[] = [], attempts: AttemptInput[] = [];
    const cited = new Map<string, Set<string>>();
    const add = (ref: string, by: string): void => { if (ref.startsWith('E05:')) { if (!cited.has(ref)) cited.set(ref, new Set()); (cited.get(ref) as Set<string>).add(by); } };
    for (const f of s.findings) if (f.state === 'approved' && !f.blocked) for (const l of [...f.data.supporting, ...f.data.contradicting]) add(l.ref, uref(EID, 'finding', f.id));
    for (const c of s.contradictions) for (const l of c.data.contradicting) add(l.ref, uref(EID, 'contradiction', c.id));
    for (const h of s.hypotheses) for (const l of [...h.data.supporting, ...h.data.contradicting]) add(l.ref, uref(EID, 'hypothesis', h.id));
    if (s.investigation.data.originalAccount.ref !== null) add(s.investigation.data.originalAccount.ref, 'original account');
    const evidence: EvidenceIndexEntry[] = [];
    const empty = { verified: false, available: null, sha256: null, size: null, mediaType: null, filename: null, origin: null, custodySummary: null };
    let failed = 0;
    for (const [ref, by] of [...cited].sort(([a], [b]) => a.localeCompare(b))) {
      const citedBy = [...by].sort();
      if (ports.evidence === undefined) { evidence.push({ ...empty, ref, note: 'EvidencePort not configured: digest, origin and custody were not verified', citedBy }); continue; }
      try {
        const d = await ports.evidence.describe(ctx, ref);
        if (d === null) { failed++; evidence.push({ ...empty, ref, note: 'not present or not accessible to the package builder', citedBy }); attempts.push({ kind: 'verification', target: ref, method: 'evidence.describe', outcome: 'access_restricted', detail: 'Cited evidence version could not be described for the evidence index', refs: [ref], effort: { attempts: 0 } }); continue; }
        const prov = ports.evidence.describeProvenance === undefined ? null : await ports.evidence.describeProvenance(ctx, ref);
        evidence.push({ ref, verified: true, available: d.available, sha256: d.sha256, size: d.size, mediaType: d.mediaType, filename: d.filename, origin: prov?.origin ?? d.origin ?? null, custodySummary: prov?.custodySummary ?? d.custodySummary ?? null, note: prov === null && d.origin === undefined ? 'origin and custody were not provided by the evidence port' : null, citedBy });
      } catch (error) { failed++; const f = failure(error, 'evidence.describe', false); evidence.push({ ...empty, ref, note: `could not be described (${f.outcome})`, citedBy }); attempts.push({ kind: 'verification', target: ref, method: 'evidence.describe', outcome: f.outcome, detail: f.detail, refs: [ref], effort: { attempts: 0 } }); }
    }
    if (cited.size > 0) {
      if (ports.evidence === undefined) { notes.push('The evidence index is unverified: no EvidencePort is configured, so digests, origin and custody are not included.'); attempts.push({ kind: 'verification', target: `${cited.size} cited evidence version(s)`, method: 'evidence.describe', outcome: 'unavailable', detail: 'EvidencePort (E05) is not configured in this deployment' }); }
      else { attempts.push({ kind: 'verification', target: `${cited.size} cited evidence version(s)`, method: 'evidence.describe', outcome: failed === 0 ? 'succeeded' : failed === cited.size ? 'failed' : 'partial', detail: `Evidence index built: ${cited.size - failed} described, ${failed} not described` }); if (failed > 0) notes.push(`${failed} cited evidence version(s) could not be described for the evidence index.`); }
    }
    const claimRefs = [...new Set([...s.questions.flatMap((q) => q.data.claimRefs), ...s.findings.flatMap((f) => [...f.data.supporting, ...f.data.contradicting].map((l) => l.ref))].filter((r) => r.startsWith('E07:')))].sort();
    let chronology: ChronologyResult;
    if (ports.knowledge === undefined) { chronology = { available: false, reason: 'KnowledgePort (E07) is not configured in this deployment', entries: [] }; notes.push('No factual chronology: KnowledgePort is not configured.'); }
    else try {
      const entries = [...await ports.knowledge.getChronology(ctx, { subject: uref(EID, 'investigation', s.investigation.id), claimRefs })].sort((a, b) => a.at.localeCompare(b.at) || a.claimRef.localeCompare(b.claimRef));
      chronology = { available: true, reason: null, entries };
      attempts.push({ kind: 'knowledge', target: `${claimRefs.length} claim(s)`, method: 'knowledge.get_chronology', outcome: entries.length === 0 ? 'zero_result' : 'succeeded', detail: `${entries.length} chronology entr${entries.length === 1 ? 'y' : 'ies'}`, effort: { attempts: 1 } });
    } catch (error) { const f = failure(error, 'knowledge.get_chronology', false); chronology = { available: false, reason: `chronology request ${f.outcome}`, entries: [] }; notes.push('No factual chronology: the knowledge engine did not return one.'); attempts.push({ kind: 'knowledge', target: `${claimRefs.length} claim(s)`, method: 'knowledge.get_chronology', outcome: f.outcome, detail: f.detail }); }
    return { evidence, chronology, notes, attempts };
  }

  const engine = {
    manifest,

    // ───────────── investigations ─────────────
    openInvestigation(ctx: ServiceContext, input: { title: string; originRef: string; scopeStatement: string; originalAccount: { ref?: string | null; summary: string; label?: string }; lanes?: unknown; policy?: unknown; urgency?: string | null; contactConstraints?: string | null; compartment?: string | null; idempotencyKey?: string }): Promise<Rec<InvestigationData>> {
      return cmd(ctx, 'investigation:write', 'openInvestigation', input, async (tx) => {
        const raw = obj(input, 'input'), acct = obj(raw.originalAccount, 'originalAccount');
        const compartment = optText(raw.compartment, 'compartment', 128);
        if (compartment !== null && !ctx.compartments.includes(compartment)) throw new DomainError('forbidden', 'Cannot open an investigation in a compartment the caller does not hold');
        const label = oneOf(acct.label ?? 'allegation', LABELS, 'originalAccount.label');
        invariant(label === 'allegation' || label === 'attributed_testimony', 'invalid_input', 'The original account is recorded as an allegation or attributed testimony, never as a verified fact');
        const data: InvestigationData = { title: text(raw.title, 'title', 500), originRef: refOf(raw.originRef, 'originRef'), scopeStatement: text(raw.scopeStatement, 'scopeStatement', 8000), compartment,
          originalAccount: { ref: optRef(acct.ref, 'originalAccount.ref'), summary: text(acct.summary, 'originalAccount.summary', 8000), label }, lanes: normLanes(raw.lanes), policy: normPolicy(raw.policy, engineRules, ACTION_NAMES),
          urgency: optText(raw.urgency, 'urgency', 500), contactConstraints: optText(raw.contactConstraints, 'contactConstraints'), closures: [], reopenings: [], reviewRequests: [], autoAccepted: { questions: 0, steps: 0 }, gapDigest: null };
        const rec = await insertRec<InvestigationData>(tx, ctx, 'investigation', 'pending', compartment, 'open', data, 'investigation opened');
        await tx.query(`update ${S}.records set investigation_id=id where tenant_id=$1 and project_id=$2 and kind='investigation' and id=$3`, [...scope(ctx), rec.id]);
        await tx.query(`insert into ${S}.counters (tenant_id, project_id, investigation_id) values ($1,$2,$3)`, [...scope(ctx), rec.id]);
        await emit(tx, ctx, 'investigation.opened', uref(EID, 'investigation', rec.id), { originRef: data.originRef });
        return { ...rec, investigationId: rec.id };
      });
    },
    async getInvestigation(ctx: ServiceContext, id: string): Promise<Rec<InvestigationData>> { requireCapability(ctx, 'investigation:read'); return inv(sql, ctx, id); },
    async listInvestigations(ctx: ServiceContext, options: { state?: string; originRef?: string; limit?: number } = {}): Promise<Rec<InvestigationData>[]> {
      requireCapability(ctx, 'investigation:read');
      const rows = await sql.query<{ id: string }>(`select id from ${S}.records where tenant_id=$1 and project_id=$2 and kind='investigation' and (compartment is null or compartment = any($3)) and ($4::text is null or state=$4) and ($5::text is null or data->>'originRef'=$5) order by seq desc limit ${Math.min(Math.max(Math.round(options.limit ?? 50), 1), 200)}`, [...scope(ctx), [...ctx.compartments], options.state ?? null, options.originRef ?? null]);
      return Promise.all(rows.map((r) => inv(sql, ctx, r.id)));
    },
    updateInvestigation(ctx: ServiceContext, id: string, patch: { title?: string; scopeStatement?: string; lanes?: unknown; policy?: unknown; urgency?: string | null; contactConstraints?: string | null; expectedRevision?: number; idempotencyKey?: string }): Promise<Rec<InvestigationData>> {
      return cmd(ctx, 'investigation:write', 'updateInvestigation', { id, patch }, async (tx) => {
        const i = await inv(tx, ctx, id, 'mutate'), p = obj(patch, 'patch');
        invariant(p.originalAccount === undefined && p.originRef === undefined, 'invalid_input', 'The origin and the original account are fixed when the investigation is opened');
        const data: InvestigationData = { ...i.data, title: p.title === undefined ? i.data.title : text(p.title, 'title', 500), scopeStatement: p.scopeStatement === undefined ? i.data.scopeStatement : text(p.scopeStatement, 'scopeStatement', 8000), lanes: p.lanes === undefined ? i.data.lanes : normLanes(p.lanes), policy: p.policy === undefined ? i.data.policy : normPolicy(p.policy, engineRules, ACTION_NAMES),
          urgency: p.urgency === undefined ? i.data.urgency : optText(p.urgency, 'urgency', 500), contactConstraints: p.contactConstraints === undefined ? i.data.contactConstraints : optText(p.contactConstraints, 'contactConstraints') };
        await bump(tx, ctx, id);
        return updateRec(tx, ctx, i, { data, expectedRevision: p.expectedRevision }, 'investigation settings revised');
      });
    },
    /** Everything recorded for one investigation, with the closure check and effort report. */
    async getOverview(ctx: ServiceContext, id: string): Promise<InvestigationOverview> {
      requireCapability(ctx, 'investigation:read');
      const s = await load(sql, ctx, id);
      return { ...s, closure: closureCheck(s), effort: effortReport(s.investigation, s.attempts), changeSeq: await changeSeq(sql, ctx, id), packages: await packagesOf(sql, ctx, id) };
    },
    async get<T = Record<string, unknown>>(ctx: ServiceContext, kind: Kind, id: string): Promise<Rec<T>> { requireCapability(ctx, 'investigation:read'); oneOf(kind, KINDS, 'kind'); return (await child<T>(sql, ctx, kind, id))[0]; },
    async list<T = Record<string, unknown>>(ctx: ServiceContext, investigationId: string, kind: Kind): Promise<Rec<T>[]> { requireCapability(ctx, 'investigation:read'); oneOf(kind, KINDS, 'kind'); await inv(sql, ctx, investigationId); return listRecs<T>(sql, ctx, kind, investigationId); },
    /** Every stored revision of one record, oldest first. */
    async revisions(ctx: ServiceContext, kind: Kind, id: string): Promise<{ revision: number; state: string; data: Json; actorId: string; at: string; summary: string }[]> {
      requireCapability(ctx, 'investigation:read'); oneOf(kind, KINDS, 'kind'); await child(sql, ctx, kind, id);
      return (await sql.query(`select revision, state, data, actor_id, at, summary from ${S}.record_revisions where tenant_id=$1 and project_id=$2 and kind=$3 and id=$4 order by revision`, [...scope(ctx), kind, id])).map((r) => ({ revision: r.revision as number, state: r.state as string, data: r.data as Json, actorId: r.actor_id as string, at: new Date(r.at as Date).toISOString(), summary: r.summary as string }));
    },

    // ───────────── question tree ─────────────
    addQuestion(ctx: ServiceContext, investigationId: string, input: { text: string; material: boolean; whyMaterial?: string | null; parentId?: string | null; stopCondition?: string | null; claimRefs?: readonly string[]; idempotencyKey?: string }): Promise<Rec<QuestionData>> {
      return cmd(ctx, 'investigation:write', 'addQuestion', { investigationId, input }, async (tx) => createQuestion(tx, ctx, await inv(tx, ctx, investigationId, 'mutate'), obj(input, 'input'), 'human'));
    },
    updateQuestion(ctx: ServiceContext, questionId: string, patch: { text?: string; material?: boolean; whyMaterial?: string | null; stopCondition?: string | null; claimRefs?: readonly string[]; materialityRationale?: string; expectedRevision?: number; idempotencyKey?: string }): Promise<Rec<QuestionData>> {
      return cmd(ctx, 'investigation:write', 'updateQuestion', { questionId, patch }, async (tx) => {
        const [q, i] = await child<QuestionData>(tx, ctx, 'question', questionId, 'mutate'), p = obj(patch, 'patch');
        const n = normQuestion({ ...q.data, ...p, parentId: q.data.parentId });
        // Demoting a material question is itself a disposition: it may not happen silently.
        if (q.data.material && !n.material) text(p.materialityRationale, 'materialityRationale (required to mark a material question as not material)');
        await bump(tx, ctx, i.id);
        return updateRec(tx, ctx, q, { data: { ...q.data, ...n }, expectedRevision: p.expectedRevision }, q.data.material && !n.material ? `materiality removed: ${String(p.materialityRationale)}` : 'question revised');
      });
    },
    /** Records where a question stands. `unresolvable` and `out_of_scope` need a rationale; `answered` needs an answer, its label and the finding(s) it rests on. */
    disposeQuestion(ctx: ServiceContext, questionId: string, input: { status: typeof QUESTION_STATUSES[number]; answer?: string; answerLabel?: string; findingIds?: readonly string[]; rationale?: string; whatWouldResolve?: string; idempotencyKey?: string }): Promise<Rec<QuestionData>> {
      return cmd(ctx, 'investigation:write', 'disposeQuestion', { questionId, input }, async (tx) => {
        const [q, i] = await child<QuestionData>(tx, ctx, 'question', questionId, 'mutate'), raw = obj(input, 'input');
        const status = oneOf(raw.status, QUESTION_STATUSES, 'status');
        let data: QuestionData = { ...q.data, answer: null, answerLabel: null, findingIds: [], rationale: optText(raw.rationale, 'rationale'), dispositionBy: ctx.actor.id, dispositionAt: ctx.now };
        if (status === 'answered') {
          const findingIds = idList(raw.findingIds, 'findingIds');
          invariant(findingIds.length >= 1, 'invalid_input', 'An answer rests on at least one finding');
          for (const f of findingIds) await need(tx, ctx, 'finding', f, i.id);
          data = { ...data, answer: text(raw.answer, 'answer', 8000), answerLabel: oneOf(raw.answerLabel, LABELS, 'answerLabel'), findingIds };
        } else if (status === 'unresolvable' || status === 'out_of_scope') {
          invariant(data.rationale !== null, 'invalid_input', `A question may be marked ${status} only with a recorded rationale`);
          if (status === 'unresolvable' && !(await listRecs<UnknownData>(tx, ctx, 'unknown', i.id)).some((u) => u.data.questionId === q.id))
            await insertRec<UnknownData>(tx, ctx, 'unknown', i.id, i.data.compartment, 'open', { description: q.data.text, whyUnknown: data.rationale, whatWouldResolve: optText(raw.whatWouldResolve, 'whatWouldResolve'), questionId: q.id, attemptIds: (await listAttemptRows(tx, ctx, i.id)).filter((a) => a.questionId === q.id).map((a) => a.id), resolutionNote: null }, 'registered from an unresolvable question');
        } else if (['answered', 'unresolvable', 'out_of_scope'].includes(q.state)) invariant(data.rationale !== null, 'invalid_input', 'Re-opening a question with a disposition needs a rationale');
        await bump(tx, ctx, i.id);
        const out = await updateRec(tx, ctx, q, { state: status, data }, `question ${status}`);
        if ((status === 'open' || status === 'in_progress') && ['answered', 'unresolvable', 'out_of_scope'].includes(q.state)) await emit(tx, ctx, 'investigation.question_opened', uref(EID, 'question', q.id), { investigationId: i.id, material: q.data.material, parentId: q.data.parentId, origin: 'reopened' });
        return out;
      });
    },

    // ───────────── competing explanations ─────────────
    addHypothesis(ctx: ServiceContext, questionId: string, input: { explanation: string; predictedObservations?: unknown; contraryTest?: string | null; supporting?: unknown; contradicting?: unknown; idempotencyKey?: string }): Promise<Rec<HypothesisData>> {
      return cmd(ctx, 'investigation:write', 'addHypothesis', { questionId, input }, async (tx) => {
        const [q, i] = await child<QuestionData>(tx, ctx, 'question', questionId, 'mutate');
        const n = normHypothesis(obj(input, 'input'), q.id);
        await bump(tx, ctx, i.id);
        return insertRec<HypothesisData>(tx, ctx, 'hypothesis', i.id, i.data.compartment, n.status, n.data, 'explanation recorded');
      });
    },
    updateHypothesis(ctx: ServiceContext, hypothesisId: string, patch: { explanation?: string; predictedObservations?: unknown; contraryTest?: string | null; supporting?: unknown; contradicting?: unknown; status?: string; statusRationale?: string; expectedRevision?: number; idempotencyKey?: string }): Promise<Rec<HypothesisData>> {
      return cmd(ctx, 'investigation:write', 'updateHypothesis', { hypothesisId, patch }, async (tx) => {
        const [h, i] = await child<HypothesisData>(tx, ctx, 'hypothesis', hypothesisId, 'mutate'), p = obj(patch, 'patch');
        const n = normHypothesis({ ...h.data, status: h.state, ...p }, h.data.questionId);
        await bump(tx, ctx, i.id);
        return updateRec(tx, ctx, h, { state: n.status, data: n.data, expectedRevision: p.expectedRevision }, n.status === h.state ? 'explanation revised' : `explanation ${n.status}`);
      });
    },

    // ───────────── leads ─────────────
    addLead(ctx: ServiceContext, investigationId: string, input: { kind: 'documentary' | 'person' | 'dataset'; description: string; origin?: { type: string; ref?: string | null }; priority?: number; questionIds?: readonly string[]; lane?: string | null; linkedRefs?: readonly string[]; idempotencyKey?: string }): Promise<Rec<LeadData>> {
      return cmd(ctx, 'investigation:write', 'addLead', { investigationId, input }, async (tx) => {
        const i = await inv(tx, ctx, investigationId, 'mutate'), n = normLead(obj(input, 'input'));
        for (const q of n.data.questionIds) await need(tx, ctx, 'question', q, i.id);
        if (n.data.lane !== null) laneFor(i, 'other', n.data.lane);
        await bump(tx, ctx, i.id);
        return insertRec<LeadData>(tx, ctx, 'lead', i.id, i.data.compartment, n.status, n.data, 'lead recorded');
      });
    },
    updateLead(ctx: ServiceContext, leadId: string, patch: { description?: string; priority?: number; status?: string; assessment?: string | null; questionIds?: readonly string[]; lane?: string | null; linkedRefs?: readonly string[]; expectedRevision?: number; idempotencyKey?: string }): Promise<Rec<LeadData>> {
      return cmd(ctx, 'investigation:write', 'updateLead', { leadId, patch }, async (tx) => {
        const [l, i] = await child<LeadData>(tx, ctx, 'lead', leadId, 'mutate'), p = obj(patch, 'patch');
        const n = normLead({ ...l.data, status: l.state, ...p, kind: l.data.kind, origin: l.data.origin });
        for (const q of n.data.questionIds) await need(tx, ctx, 'question', q, i.id);
        if (n.data.lane !== null) laneFor(i, 'other', n.data.lane);
        await bump(tx, ctx, i.id);
        const out = await updateRec(tx, ctx, l, { state: n.status, data: n.data, expectedRevision: p.expectedRevision }, n.status === l.state ? 'lead revised' : `lead ${n.status}`);
        if (n.status === 'exhausted' && l.state !== 'exhausted') await emit(tx, ctx, 'investigation.lead_exhausted', uref(EID, 'lead', l.id), { investigationId: i.id, questionIds: [...n.data.questionIds] });
        return out;
      });
    },

    // ───────────── research, interview and correspondence plan ─────────────
    addPlanItem(ctx: ServiceContext, investigationId: string, input: { kind: string; questionId: string; description: string; hypothesisId?: string | null; leadId?: string | null; lane?: string | null; action?: string | null; params?: unknown; idempotencyKey?: string }): Promise<Rec<PlanItemData>> {
      return cmd(ctx, 'investigation:write', 'addPlanItem', { investigationId, input }, async (tx) => createPlanItem(tx, ctx, await inv(tx, ctx, investigationId, 'mutate'), obj(input, 'input'), 'human'));
    },
    updatePlanItem(ctx: ServiceContext, planItemId: string, patch: { description?: string; status?: string; statusNote?: string | null; lane?: string | null; action?: string | null; params?: unknown; expectedRevision?: number; idempotencyKey?: string }): Promise<Rec<PlanItemData>> {
      return cmd(ctx, 'investigation:write', 'updatePlanItem', { planItemId, patch }, async (tx) => {
        const [x, i] = await child<PlanItemData>(tx, ctx, 'plan_item', planItemId, 'mutate'), p = obj(patch, 'patch');
        const n = normPlanItem({ ...x.data, status: x.state, ...p, questionId: x.data.questionId, kind: x.data.kind }, ACTION_NAMES);
        if (n.data.lane !== null) laneFor(i, 'other', n.data.lane);
        await bump(tx, ctx, i.id);
        return updateRec(tx, ctx, x, { state: n.status, data: { ...n.data, origin: x.data.origin }, expectedRevision: p.expectedRevision }, n.status === x.state ? 'plan item revised' : `plan item ${n.status}`);
      });
    },

    // ───────────── attempts log ─────────────
    /** Records one search, acquisition, contact, processing or verification attempt, including those that obtained nothing. Append-only; a correction is a new entry naming the one it corrects. */
    recordAttempt(ctx: ServiceContext, investigationId: string, input: AttemptInput & { idempotencyKey?: string }): Promise<Attempt> {
      return cmd(ctx, 'investigation:write', 'recordAttempt', { investigationId, input }, async (tx) => {
        const i = await inv(tx, ctx, investigationId, 'mutate'), raw = obj(input, 'input'), e = raw.effort === undefined || raw.effort === null ? {} : obj(raw.effort, 'effort');
        const a: AttemptInput = { kind: oneOf(raw.kind, ATTEMPT_KINDS, 'kind'), target: text(raw.target, 'target', 2000), method: text(raw.method, 'method', 500), outcome: oneOf(raw.outcome, OUTCOMES, 'outcome'), detail: optText(raw.detail, 'detail'), lane: optText(raw.lane, 'lane', 64),
          questionId: optText(raw.questionId, 'questionId', 128), hypothesisId: optText(raw.hypothesisId, 'hypothesisId', 128), leadId: optText(raw.leadId, 'leadId', 128), planItemId: optText(raw.planItemId, 'planItemId', 128), findingId: optText(raw.findingId, 'findingId', 128), refs: refList(raw.refs, 'refs'),
          effort: { timeMinutes: num(e.timeMinutes, 'effort.timeMinutes', 0, 1e6, 0), attempts: num(e.attempts, 'effort.attempts', 0, 1e4, 1), costUnits: num(e.costUnits, 'effort.costUnits', 0, 1e9, 0) }, corrects: optText(raw.corrects, 'corrects', 128) };
        invariant(!NOT_OBTAINED.includes(a.outcome) || (a.detail ?? '') !== '', 'invalid_input', 'An attempt that did not obtain what was sought needs a detail saying what happened');
        await need(tx, ctx, 'question', a.questionId ?? null, i.id); await need(tx, ctx, 'hypothesis', a.hypothesisId ?? null, i.id); await need(tx, ctx, 'lead', a.leadId ?? null, i.id); await need(tx, ctx, 'plan_item', a.planItemId ?? null, i.id); await need(tx, ctx, 'finding', a.findingId ?? null, i.id);
        if (a.corrects !== null && a.corrects !== undefined) invariant((await tx.query(`select 1 from ${S}.attempts where tenant_id=$1 and project_id=$2 and investigation_id=$3 and id=$4`, [...scope(ctx), i.id, a.corrects])).length === 1, 'invalid_input', 'Unknown attempt to correct');
        return logAttempt(tx, ctx, i, a);
      });
    },
    async listAttempts(ctx: ServiceContext, investigationId: string, options: { notObtained?: boolean; outcome?: string; questionId?: string } = {}): Promise<Attempt[]> {
      requireCapability(ctx, 'investigation:read'); await inv(sql, ctx, investigationId);
      return (await listAttemptRows(sql, ctx, investigationId)).filter((a) => (options.notObtained !== true || NOT_OBTAINED.includes(a.outcome)) && (options.outcome === undefined || a.outcome === options.outcome) && (options.questionId === undefined || a.questionId === options.questionId));
    },
    async effortReport(ctx: ServiceContext, investigationId: string): Promise<EffortReport> {
      requireCapability(ctx, 'investigation:read');
      return effortReport(await inv(sql, ctx, investigationId), await listAttemptRows(sql, ctx, investigationId));
    },

    // ───────────── findings ─────────────
    createFinding(ctx: ServiceContext, investigationId: string, input: { statement: string; label: string; classification: string; questionIds: readonly string[]; supporting?: unknown; contradicting?: unknown; limitations?: readonly string[]; confidence: { level: string; basis: string }; checklist?: unknown; idempotencyKey?: string }): Promise<Rec<FindingData>> {
      return cmd(ctx, 'investigation:write', 'createFinding', { investigationId, input }, async (tx) => {
        const i = await inv(tx, ctx, investigationId, 'mutate'), n = normFinding(obj(input, 'input'));
        for (const q of n.questionIds) await need(tx, ctx, 'question', q, i.id);
        await bump(tx, ctx, i.id);
        return insertRec<FindingData>(tx, ctx, 'finding', i.id, i.data.compartment, 'draft', { ...n, authors: [ctx.actor.id], submittedBy: null, reviews: [], withdrawal: null }, 'finding drafted');
      });
    },
    /** Any change to a finding creates a new draft revision: an approval never carries over to changed content. */
    reviseFinding(ctx: ServiceContext, findingId: string, patch: { statement?: string; label?: string; classification?: string; questionIds?: readonly string[]; supporting?: unknown; contradicting?: unknown; limitations?: readonly string[]; confidence?: { level: string; basis: string }; checklist?: unknown; expectedRevision?: number; idempotencyKey?: string }): Promise<Rec<FindingData>> {
      return cmd(ctx, 'investigation:write', 'reviseFinding', { findingId, patch }, async (tx) => {
        const [f, i] = await child<FindingData>(tx, ctx, 'finding', findingId, 'mutate'), p = obj(patch, 'patch');
        invariant(f.state !== 'withdrawn', 'invalid_state', 'A withdrawn finding cannot be revised');
        const n = normFinding({ ...f.data, ...p, checklist: { ...f.data.checklist, ...(p.checklist === undefined || p.checklist === null ? {} : obj(p.checklist, 'checklist')) } });
        for (const q of n.questionIds) await need(tx, ctx, 'question', q, i.id);
        await bump(tx, ctx, i.id);
        return updateRec(tx, ctx, f, { state: 'draft', clearStale: true, data: { ...f.data, ...n, authors: [...new Set([...f.data.authors, ctx.actor.id])], submittedBy: null }, expectedRevision: p.expectedRevision }, f.state === 'approved' ? 'approved finding revised: returns to draft' : 'finding revised');
      });
    },
    submitFinding(ctx: ServiceContext, findingId: string, input: { idempotencyKey?: string } = {}): Promise<Rec<FindingData>> {
      return cmd(ctx, 'investigation:write', 'submitFinding', { findingId, input }, async (tx) => {
        const [f, i] = await child<FindingData>(tx, ctx, 'finding', findingId, 'mutate');
        invariant(f.state === 'draft' || f.state === 'returned', 'invalid_state', `A finding in state ${f.state} cannot be submitted for review`);
        invariant(!f.blocked, 'invalid_state', 'The finding cites a source whose permission was withdrawn');
        const defects = findingDefects(f.data);
        invariant(defects.length === 0, 'invalid_state', `The finding is not ready for review: ${defects.join('; ')}`);
        await bump(tx, ctx, i.id);
        const out = await updateRec(tx, ctx, f, { state: 'in_review', data: { ...f.data, submittedBy: ctx.actor.id } }, 'submitted for review');
        await emit(tx, ctx, 'investigation.finding_proposed', uref(EID, 'finding', f.id, out.revision), { investigationId: i.id, classification: f.data.classification });
        return out;
      });
    },
    /** Approve or return a finding. Reviewers are humans holding investigation:approve; when policy requires, not an author or the submitter. A stale approved finding is re-reviewed here. */
    reviewFinding(ctx: ServiceContext, findingId: string, input: { decision: 'approve' | 'return'; notes?: string; idempotencyKey?: string }): Promise<Rec<FindingData>> {
      return cmd(ctx, 'investigation:approve', 'reviewFinding', { findingId, input }, async (tx) => {
        const [f, i] = await child<FindingData>(tx, ctx, 'finding', findingId, 'mutate'), raw = obj(input, 'input');
        const decision = oneOf(raw.decision, ['approve', 'return'] as const, 'decision'), notes = optText(raw.notes, 'notes');
        if (ctx.actor.kind !== 'human') throw new DomainError('forbidden', 'Findings are reviewed by a human');
        const renewed = f.state === 'approved' && f.stale;
        invariant(f.state === 'in_review' || renewed, 'invalid_state', `A finding in state ${f.state} is not awaiting review`);
        invariant(!f.blocked, 'invalid_state', 'The finding cites a source whose permission was withdrawn and must be revised first');
        if (i.data.policy.requireDistinctReviewer && (f.data.authors.includes(ctx.actor.id) || f.data.submittedBy === ctx.actor.id)) throw new DomainError('forbidden', 'The reviewer must differ from the author of the finding');
        invariant(decision === 'approve' || notes !== null, 'invalid_input', 'Returning a finding needs notes for its author');
        await bump(tx, ctx, i.id);
        const data: FindingData = { ...f.data, reviews: [...f.data.reviews, { at: ctx.now, by: ctx.actor.id, decision, notes, revision: f.revision, renewed }] };
        const out = await updateRec(tx, ctx, f, { state: decision === 'approve' ? 'approved' : 'returned', data, clearStale: true }, renewed ? `renewed review: ${decision}` : `review: ${decision}`);
        await emit(tx, ctx, decision === 'approve' ? 'investigation.finding_approved' : 'investigation.finding_returned', uref(EID, 'finding', f.id, out.revision), { investigationId: i.id, classification: f.data.classification, renewed, sources: [...out.sources] });
        return out;
      });
    },
    withdrawFinding(ctx: ServiceContext, findingId: string, input: { rationale: string; idempotencyKey?: string }): Promise<Rec<FindingData>> {
      return cmd(ctx, 'investigation:write', 'withdrawFinding', { findingId, input }, async (tx) => {
        const [f, i] = await child<FindingData>(tx, ctx, 'finding', findingId, 'mutate');
        invariant(f.state !== 'withdrawn', 'invalid_state', 'Already withdrawn');
        await bump(tx, ctx, i.id);
        return updateRec(tx, ctx, f, { state: 'withdrawn', data: { ...f.data, withdrawal: { at: ctx.now, by: ctx.actor.id, rationale: text(obj(input, 'input').rationale, 'rationale') } } }, 'finding withdrawn');
      });
    },

    // ───────────── registers ─────────────
    addContradiction(ctx: ServiceContext, investigationId: string, input: { description: string; contradicting: unknown; accountExcerpt?: string | null; accountRef?: string | null; questionId?: string | null; findingId?: string | null; idempotencyKey?: string }): Promise<Rec<ContradictionData>> {
      return cmd(ctx, 'investigation:write', 'addContradiction', { investigationId, input }, async (tx) => {
        const i = await inv(tx, ctx, investigationId, 'mutate'), n = normContradiction(obj(input, 'input'));
        await need(tx, ctx, 'question', n.data.questionId, i.id); await need(tx, ctx, 'finding', n.data.findingId, i.id);
        await bump(tx, ctx, i.id);
        return insertRec<ContradictionData>(tx, ctx, 'contradiction', i.id, i.data.compartment, n.status, n.data, 'contradiction with the account registered');
      });
    },
    updateContradiction(ctx: ServiceContext, contradictionId: string, patch: { description?: string; contradicting?: unknown; status?: string; resolutionNote?: string; findingId?: string | null; expectedRevision?: number; idempotencyKey?: string }): Promise<Rec<ContradictionData>> {
      return cmd(ctx, 'investigation:write', 'updateContradiction', { contradictionId, patch }, async (tx) => {
        const [c, i] = await child<ContradictionData>(tx, ctx, 'contradiction', contradictionId, 'mutate'), p = obj(patch, 'patch');
        const n = normContradiction({ ...c.data, status: c.state, ...p });
        await need(tx, ctx, 'finding', n.data.findingId, i.id);
        await bump(tx, ctx, i.id);
        return updateRec(tx, ctx, c, { state: n.status, data: n.data, expectedRevision: p.expectedRevision }, `contradiction ${n.status}`);
      });
    },
    addUnknown(ctx: ServiceContext, investigationId: string, input: { description: string; whyUnknown: string; whatWouldResolve?: string | null; questionId?: string | null; attemptIds?: readonly string[]; idempotencyKey?: string }): Promise<Rec<UnknownData>> {
      return cmd(ctx, 'investigation:write', 'addUnknown', { investigationId, input }, async (tx) => {
        const i = await inv(tx, ctx, investigationId, 'mutate'), n = normUnknown(obj(input, 'input'));
        await need(tx, ctx, 'question', n.data.questionId, i.id);
        await bump(tx, ctx, i.id);
        return insertRec<UnknownData>(tx, ctx, 'unknown', i.id, i.data.compartment, n.status, n.data, 'unknown registered');
      });
    },
    updateUnknown(ctx: ServiceContext, unknownId: string, patch: { description?: string; whyUnknown?: string; whatWouldResolve?: string | null; status?: string; resolutionNote?: string; attemptIds?: readonly string[]; expectedRevision?: number; idempotencyKey?: string }): Promise<Rec<UnknownData>> {
      return cmd(ctx, 'investigation:write', 'updateUnknown', { unknownId, patch }, async (tx) => {
        const [u, i] = await child<UnknownData>(tx, ctx, 'unknown', unknownId, 'mutate'), p = obj(patch, 'patch');
        const n = normUnknown({ ...u.data, status: u.state, ...p, questionId: u.data.questionId });
        await bump(tx, ctx, i.id);
        return updateRec(tx, ctx, u, { state: n.status, data: n.data, expectedRevision: p.expectedRevision }, `unknown ${n.status}`);
      });
    },

    // ───────────── proposals (model or agent suggestions are data until accepted) ─────────────
    proposeQuestions(ctx: ServiceContext, investigationId: string, input: { items: readonly unknown[]; rationale: string; source?: string; idempotencyKey?: string }): Promise<Rec<ProposalData>[]> { return propose(ctx, investigationId, 'question', input); },
    proposeSteps(ctx: ServiceContext, investigationId: string, input: { items: readonly unknown[]; rationale: string; source?: string; idempotencyKey?: string }): Promise<Rec<ProposalData>[]> { return propose(ctx, investigationId, 'step', input); },
    decideProposal(ctx: ServiceContext, proposalId: string, input: { decision: 'accept' | 'reject'; rationale?: string; idempotencyKey?: string }): Promise<Rec<ProposalData>> {
      return cmd(ctx, 'investigation:write', 'decideProposal', { proposalId, input }, async (tx) => {
        const [p, i] = await child<ProposalData>(tx, ctx, 'proposal', proposalId, 'mutate'), raw = obj(input, 'input');
        invariant(p.state === 'proposed', 'invalid_state', `Proposal already ${p.state}`);
        if (ctx.actor.kind !== 'human') throw new DomainError('forbidden', 'A proposal is accepted or rejected by a human, or by the investigation policy at the time it is made');
        const decision = oneOf(raw.decision, ['accept', 'reject'] as const, 'decision'), rationale = optText(raw.rationale, 'rationale');
        invariant(decision === 'accept' || rationale !== null, 'invalid_input', 'Rejecting a proposal needs a rationale');
        return settleProposal(tx, ctx, i, p, decision, rationale, false);
      });
    },

    // ───────────── planning and execution ─────────────
    /**
     * Deterministic planner. Derives concrete next actions from open material questions, explanations lacking tests, unexecuted plan
     * items, knowledge gaps, leads and findings awaiting verification or review, and stores them as steps with stable ids.
     */
    async planNextSteps(ctx: ServiceContext, investigationId: string): Promise<NextSteps> {
      requireCapability(ctx, 'investigation:plan');
      const before = await load(sql, ctx, investigationId);
      invariant(before.investigation.state !== 'closed', 'invalid_state', 'The investigation is closed');
      const notes: string[] = [];
      let gaps: Awaited<ReturnType<NonNullable<InvestigationPorts['knowledge']>['getGaps']>> = [];
      let gapAttempt: AttemptInput | null = null;
      const claimRefs = [...new Set([...before.questions.flatMap((q) => q.data.claimRefs), ...before.findings.flatMap((f) => [...f.data.supporting, ...f.data.contradicting].map((l) => l.ref))].filter((r) => r.startsWith('E07:')))].sort();
      if (ports.knowledge === undefined) notes.push('KnowledgePort is not configured: knowledge gaps were not consulted.');
      else try {
        gaps = [...await ports.knowledge.getGaps(ctx, { subject: uref(EID, 'investigation', investigationId), claimRefs })].sort((a, b) => a.id.localeCompare(b.id));
        gapAttempt = { kind: 'knowledge', target: `${claimRefs.length} claim(s)`, method: 'knowledge.get_gaps', outcome: gaps.length === 0 ? 'zero_result' : 'succeeded', detail: `${gaps.length} gap(s) reported`, effort: { attempts: 1 } };
      } catch (error) { const f = failure(error, 'knowledge.get_gaps', false); gapAttempt = { kind: 'knowledge', target: `${claimRefs.length} claim(s)`, method: 'knowledge.get_gaps', outcome: f.outcome, detail: f.detail }; notes.push(`Knowledge gaps could not be consulted (${f.outcome}).`); }
      return sql.tx(async (tx) => {
        const i = await inv(tx, ctx, investigationId, 'mutate');
        const s = await load(tx, ctx, investigationId);
        // The gap query is logged when it fails or when its answer differs from the last one logged, not on every planning pass.
        const gapDigest = gapAttempt === null ? i.data.gapDigest : digest({ outcome: gapAttempt.outcome, gaps: gaps as unknown as Json });
        if (gapAttempt !== null && gapDigest !== i.data.gapDigest) { await logAttempt(tx, ctx, i, gapAttempt); await updateRec(tx, ctx, i, { data: { ...i.data, gapDigest } }, 'knowledge gaps consulted'); }
        const wanted = new Map<string, Derived>();
        for (const d of derive(s, gaps)) wanted.set(digest({ i: investigationId, a: d.action, f: d.derivedFrom, q: d.questionId, h: d.hypothesisId, l: d.leadId, p: d.planItemId, n: d.findingId, x: d.params }), d);
        const existing = new Map(s.steps.map((st) => [st.data.key, st]));
        for (const [key, d] of wanted) {
          const prior = existing.get(key);
          if (prior === undefined) await insertRec<StepData>(tx, ctx, 'step', investigationId, i.data.compartment, 'pending', { ...d, key, executable: ACTIONS[d.action] !== undefined, runCount: 0, jobId: null, lastOutcome: null, lastAttemptId: null, result: null, refs: [] }, 'step derived', `st_${key.slice(0, 32)}`);
          else if (prior.state === 'resolved') await updateRec(tx, ctx, prior, { state: 'pending' }, 'condition holds again');
        }
        for (const st of s.steps) if (st.state === 'pending' && !wanted.has(st.data.key)) await updateRec(tx, ctx, st, { state: 'resolved' }, 'the condition that produced this step no longer holds');
        const all = (await listRecs<StepData>(tx, ctx, 'step', investigationId)).sort((a, b) => a.data.priority - b.data.priority || a.data.key.localeCompare(b.data.key));
        const pick = (...states: string[]): Rec<StepData>[] => all.filter((st) => states.includes(st.state));
        return { investigationId, steps: pick('pending'), waiting: pick('waiting'), retryable: pick('failed', 'blocked', 'uncertain'), inFlight: pick('queued', 'running'), notes };
      });
    },
    /** Queues one executable step as a durable job. The job calls the port, records the attempt and the resulting references. */
    executeStep(ctx: ServiceContext, stepId: string, input: { idempotencyKey?: string } = {}): Promise<{ step: Rec<StepData>; jobId: string }> {
      return cmd(ctx, 'investigation:execute', 'executeStep', { stepId, input }, async (tx) => {
        const [st, i] = await child<StepData>(tx, ctx, 'step', stepId, 'mutate');
        const spec = ACTIONS[st.data.action];
        invariant(spec !== undefined, 'invalid_state', 'This step is carried out by a person: record what was done with completeStep');
        if (spec.port === 'correspondence') requireCapability(ctx, 'investigation:contact');
        invariant(['pending', 'waiting', 'failed', 'blocked', 'uncertain', 'cancelled'].includes(st.state), 'invalid_state', `A step in state ${st.state} cannot be executed`);
        const runCount = st.data.runCount + 1;
        const job = await enqueueJob(tx, S, ctx, { kind: STEP_JOB, payload: { stepId: st.id, run: runCount }, dedupeKey: `${st.id}:${runCount}`, maxAttempts: 5 });
        await bump(tx, ctx, i.id);
        const step = await updateRec(tx, ctx, st, { state: 'queued', data: { ...st.data, runCount, jobId: job.id } }, `queued for execution (run ${runCount})`);
        return { step, jobId: job.id };
      });
    },
    /** Records the outcome of a step a person carried out (or decided not to), as an attempt-log entry. */
    completeStep(ctx: ServiceContext, stepId: string, input: { outcome: Outcome; detail: string; refs?: readonly string[]; effort?: { timeMinutes?: number; costUnits?: number }; idempotencyKey?: string }): Promise<{ step: Rec<StepData>; attempt: Attempt }> {
      return cmd(ctx, 'investigation:write', 'completeStep', { stepId, input }, async (tx) => {
        const [st, i] = await child<StepData>(tx, ctx, 'step', stepId, 'mutate'), raw = obj(input, 'input'), e = raw.effort === undefined || raw.effort === null ? {} : obj(raw.effort, 'effort');
        invariant(ACTIONS[st.data.action] === undefined, 'invalid_state', 'This step runs through a port: use executeStep');
        invariant(['pending', 'waiting'].includes(st.state), 'invalid_state', `A step in state ${st.state} cannot be completed`);
        const outcome = oneOf(raw.outcome, OUTCOMES, 'outcome'), refs = refList(raw.refs, 'refs');
        const attempt = await logAttempt(tx, ctx, i, { kind: st.data.findingId !== null ? 'verification' : 'other', target: st.data.title.slice(0, 2000), method: st.data.action, outcome, detail: text(raw.detail, 'detail'), questionId: st.data.questionId, hypothesisId: st.data.hypothesisId, leadId: st.data.leadId, planItemId: st.data.planItemId, findingId: st.data.findingId, stepId: st.id, lane: st.data.lane, refs, effort: { timeMinutes: num(e.timeMinutes, 'effort.timeMinutes', 0, 1e6, 0), attempts: 1, costUnits: num(e.costUnits, 'effort.costUnits', 0, 1e9, 0) } });
        const step = await updateRec(tx, ctx, st, { state: ['succeeded', 'partial', 'zero_result', 'access_restricted', 'refused'].includes(outcome) ? 'done' : outcome === 'cancelled' ? 'cancelled' : 'failed', data: { ...st.data, lastOutcome: outcome, lastAttemptId: attempt.id, refs } }, `completed by a person: ${outcome}`);
        return { step, attempt };
      });
    },
    async getJob(ctx: ServiceContext, jobId: string): Promise<{ id: string; kind: string; state: string; attempts: number; result: Json | null; lastError: string | null; stepId: string | null }> {
      requireCapability(ctx, 'investigation:read');
      const j = await kitGetJob(sql, S, ctx, String(jobId));
      if (j === null) return notFound();
      const stepId = (j.payload as { stepId?: string } | null)?.stepId ?? null;
      if (stepId !== null) await child(sql, ctx, 'step', stepId);
      return { id: j.id, kind: j.kind, state: j.state, attempts: j.attempts, result: j.result, lastError: j.lastError, stepId };
    },
    /** Pause, resume, cancel or retry a step job. A cancelled or paused job performs no further side effect. */
    async controlJob(ctx: ServiceContext, jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry'): Promise<{ id: string; state: string; stepId: string | null }> {
      requireCapability(ctx, 'investigation:execute'); oneOf(action, ['pause', 'resume', 'cancel', 'retry'] as const, 'action');
      return sql.tx(async (tx) => {
        const existing = await kitGetJob(tx, S, ctx, String(jobId));
        if (existing === null) return notFound();
        const stepId = (existing.payload as { stepId?: string } | null)?.stepId ?? null;
        const pair = stepId === null ? null : await child<StepData>(tx, ctx, 'step', stepId, 'lock');
        const j = await kitControlJob(tx, S, ctx, existing.id, action);
        if (pair !== null && pair[0].data.jobId === j.id) {
          if (action === 'cancel' && ['queued', 'running'].includes(pair[0].state)) await updateRec(tx, ctx, pair[0], { state: 'cancelled' }, 'execution cancelled');
          if (action === 'retry' && ['cancelled', 'failed', 'blocked', 'uncertain'].includes(pair[0].state)) await updateRec(tx, ctx, pair[0], { state: 'queued' }, 'execution retried');
        }
        await appendAudit(tx, S, ctx, `job.${action}`, stepId === null ? uref(EID, 'job', j.id) : uref(EID, 'step', stepId), { jobId: j.id, state: j.state });
        return { id: j.id, state: j.state, stepId };
      });
    },
    /** One worker pass over queued step jobs. Called by the serve loop; hosts may call it from their own scheduler. */
    runJobs(options: { worker: string; limit?: number; leaseMs?: number }): Promise<number> {
      const leaseMs = options.leaseMs ?? config.leaseMs;
      return runJobsOnce(sql, S, { [STEP_JOB]: runStepJob }, { worker: options.worker, ...(options.limit === undefined ? {} : { limit: options.limit }), ...(leaseMs === undefined ? {} : { leaseMs }) });
    },

    // ───────────── review, closure, reopening ─────────────
    async closureCheck(ctx: ServiceContext, investigationId: string): Promise<ClosureCheck> { requireCapability(ctx, 'investigation:read'); return closureCheck(await load(sql, ctx, investigationId)); },
    /** Marks the investigation ready for closure review when nothing blocks closure; otherwise reports the blockers and changes nothing. */
    requestReview(ctx: ServiceContext, investigationId: string, input: { idempotencyKey?: string } = {}): Promise<{ investigation: Rec<InvestigationData>; closure: ClosureCheck }> {
      return cmd(ctx, 'investigation:write', 'requestReview', { investigationId, input }, async (tx) => {
        const i = await inv(tx, ctx, investigationId, 'mutate');
        const closure = closureCheck(await load(tx, ctx, investigationId));
        const investigation = await updateRec(tx, ctx, i, { state: closure.ready ? 'review_ready' : 'open', data: { ...i.data, reviewRequests: [...i.data.reviewRequests, { at: ctx.now, by: ctx.actor.id, ready: closure.ready, blockers: closure.blockers.length }] } }, closure.ready ? 'ready for closure review' : `closure review requested with ${closure.blockers.length} blocker(s)`);
        if (closure.ready) await emit(tx, ctx, 'investigation.review_ready', uref(EID, 'investigation', i.id), { warnings: closure.warnings.length });
        return { investigation, closure };
      });
    },
    /**
     * Closes the investigation. Refused while any material question lacks a recorded disposition, any finding is unreviewed, stale or blocked,
     * or the named package does not reflect the current state. The decision is a human's, with a rationale.
     */
    close(ctx: ServiceContext, investigationId: string, input: { rationale: string; packageVersion: number; reopeningTriggers?: readonly string[]; idempotencyKey?: string }): Promise<Rec<InvestigationData>> {
      return cmd(ctx, 'investigation:approve', 'close', { investigationId, input }, async (tx) => {
        const i = await inv(tx, ctx, investigationId, 'mutate'), raw = obj(input, 'input');
        if (ctx.actor.kind !== 'human') throw new DomainError('forbidden', 'An investigation is closed by a human decision');
        const rationale = text(raw.rationale, 'rationale', 8000);
        const closure = closureCheck(await load(tx, ctx, investigationId));
        if (!closure.ready) throw new DomainError('invalid_state', `Closure refused: ${closure.blockers.map((b) => b.message).join(' | ')}`.slice(0, 3000));
        const version = Math.round(num(raw.packageVersion, 'packageVersion', 1, 1e6));
        const pkg = (await tx.query(`select digest, change_seq::text as change_seq, stale, blocked, content->'closure'->>'ready' as ready from ${S}.packages where tenant_id=$1 and project_id=$2 and investigation_id=$3 and version=$4`, [...scope(ctx), i.id, version]))[0];
        invariant(pkg !== undefined, 'invalid_state', 'Closure refused: the named package version does not exist');
        invariant(Number(pkg.change_seq) === await changeSeq(tx, ctx, i.id) && pkg.stale !== true && pkg.blocked !== true && pkg.ready === 'true', 'invalid_state', 'Closure refused: the named package does not reflect the current state of the investigation; build a new package');
        const out = await updateRec(tx, ctx, i, { state: 'closed', data: { ...i.data, closures: [...i.data.closures, { at: ctx.now, by: ctx.actor.id, rationale, packageVersion: version, packageDigest: pkg.digest as string, reopeningTriggers: list(raw.reopeningTriggers, 'reopeningTriggers', 50).map((t) => text(t, 'reopeningTrigger', 2000)) }] } }, 'investigation closed');
        await emit(tx, ctx, 'investigation.closed', uref(EID, 'investigation', i.id), { packageVersion: version, packageDigest: pkg.digest as string, warnings: closure.warnings.length });
        return out;
      });
    },
    /** New information reopens a closed investigation. Earlier package versions and the closure record are retained. */
    reopen(ctx: ServiceContext, investigationId: string, input: { reason: string; newInformationRefs?: readonly string[]; idempotencyKey?: string }): Promise<Rec<InvestigationData>> {
      return cmd(ctx, 'investigation:write', 'reopen', { investigationId, input }, async (tx) => {
        const i = await inv(tx, ctx, investigationId, 'lock'), raw = obj(input, 'input');
        invariant(i.state === 'closed', 'invalid_state', 'Only a closed investigation can be reopened');
        const refs = refList(raw.newInformationRefs, 'newInformationRefs');
        await bump(tx, ctx, i.id);
        const out = await updateRec(tx, ctx, i, { state: 'open', data: { ...i.data, reopenings: [...i.data.reopenings, { at: ctx.now, by: ctx.actor.id, reason: text(raw.reason, 'reason', 8000), newInformationRefs: refs }] } }, 'investigation reopened');
        await emit(tx, ctx, 'investigation.reopened', uref(EID, 'investigation', i.id), { newInformationRefs: refs });
        return out;
      });
    },

    // ───────────── packages ─────────────
    /** Builds a new immutable package version (JSON, Markdown, HTML). Port calls made for it are recorded as attempts. */
    async buildPackage(ctx: ServiceContext, investigationId: string, input: { idempotencyKey?: string } = {}): Promise<InvestigationPackage> {
      requireCapability(ctx, 'investigation:write');
      const key = obj(input ?? {}, 'input').idempotencyKey;
      if (typeof key === 'string') {
        const prior = await sql.query<{ result: { version: number } | null }>(`select result from ${S}._idempotency where tenant_id=$1 and project_id=$2 and key=$3`, [...scope(ctx), key]);
        if (prior[0]?.result?.version !== undefined) return engine.getPackage(ctx, investigationId, prior[0].result.version);
      }
      const s = await load(sql, ctx, investigationId);
      const seq0 = await changeSeq(sql, ctx, investigationId);
      const gathered = await gatherPorts(ctx, s);
      const version = await cmd(ctx, 'investigation:write', 'buildPackage', { investigationId, idempotencyKey: key }, async (tx) => {
        const i = await inv(tx, ctx, investigationId, 'lock');
        if (await changeSeq(tx, ctx, investigationId) !== seq0) throw new DomainError('conflict', 'The investigation changed while the package was being built; build it again');
        const prev = (await tx.query(`select version, digest from ${S}.packages where tenant_id=$1 and project_id=$2 and investigation_id=$3 order by version desc limit 1`, [...scope(ctx), i.id]))[0];
        const v = ((await tx.query<{ package_seq: number }>(`update ${S}.counters set package_seq = package_seq + 1 where tenant_id=$1 and project_id=$2 and investigation_id=$3 returning package_seq`, [...scope(ctx), i.id]))[0] as { package_seq: number }).package_seq;
        const content = assemblePackage(s, { version: v, builtAt: ctx.now, builtBy: ctx.actor.id, evidence: gathered.evidence, chronology: gathered.chronology, previous: prev === undefined ? null : { version: prev.version as number, digest: prev.digest as string }, portNotes: gathered.notes });
        const markdown = renderMarkdown(content), html = renderHtml(content);
        for (const a of gathered.attempts) await logAttempt(tx, ctx, i, a);
        await tx.query(`insert into ${S}.packages (tenant_id, project_id, investigation_id, compartment, version, digest, change_seq, content, markdown, html, sources, finding_ids, built_by, built_at) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)`,
          [...scope(ctx), i.id, i.data.compartment, v, content.digest, await changeSeq(tx, ctx, i.id), JSON.stringify(content), markdown, html, [...collectRefs(content)].sort(), (content.findings as { id: string }[]).map((f) => f.id), ctx.actor.id, ctx.now]);
        const ref = uref(EID, 'investigation_package', i.id, v);
        await appendAudit(tx, S, ctx, 'package.built', ref, { version: v, digest: content.digest as string });
        await emit(tx, ctx, 'investigation.package_built', ref, { investigationId: i.id, version: v, digest: content.digest as string, closureReady: (content.closure as { ready: boolean }).ready });
        return { version: v, markdown, html, content };
      });
      if (deps.objects !== undefined && version.content !== undefined) {
        const base = `${ctx.tenantId}/${ctx.projectId}/investigation/${investigationId}/package-v${version.version}`;
        const enc = new TextEncoder();
        await deps.objects.put(`${base}.json`, enc.encode(JSON.stringify(version.content))); await deps.objects.put(`${base}.md`, enc.encode(version.markdown)); await deps.objects.put(`${base}.html`, enc.encode(version.html));
      }
      return engine.getPackage(ctx, investigationId, version.version);
    },
    /** A package version (latest when omitted). A blocked package is listed but its content is withheld. */
    async getPackage(ctx: ServiceContext, investigationId: string, version?: number): Promise<InvestigationPackage> {
      requireCapability(ctx, 'investigation:read'); await inv(sql, ctx, investigationId);
      const r = (await sql.query(`select *, change_seq::text as change_seq from ${S}.packages where tenant_id=$1 and project_id=$2 and investigation_id=$3 and ($4::int is null or version=$4) order by version desc limit 1`, [...scope(ctx), investigationId, version === undefined || !Number.isInteger(Number(version)) ? null : Number(version)]))[0];
      if (r === undefined) return notFound();
      const blocked = r.blocked as boolean;
      return { ...pkgSummary(r, await changeSeq(sql, ctx, investigationId)), content: blocked ? null : r.content as Record<string, Json>, markdown: blocked ? null : r.markdown as string, html: blocked ? null : r.html as string };
    },
    async listPackages(ctx: ServiceContext, investigationId: string): Promise<PackageSummary[]> { requireCapability(ctx, 'investigation:read'); await inv(sql, ctx, investigationId); return packagesOf(sql, ctx, investigationId); },

    // ───────────── standard surface ─────────────
    async inspect(ctx: ServiceContext, ref: string): Promise<Inspection | null> {
      requireCapability(ctx, 'investigation:read');
      try {
        const p = parseUref(ref);
        if (p.engine !== EID) return null;
        const history = async (subject: string): Promise<Inspection['history']> => (await listAudit(sql, S, ctx, { subject, limit: 200 })).map((a) => ({ at: a.at, actorId: a.actorId, action: a.action, detail: a.detail }));
        const reasons = (rs: readonly StaleReason[]): string[] => rs.filter((r) => r.resolved !== true).map((r) => `${r.effect} (${r.kind}): ${r.reason} [${r.refs.join(', ')}]`);
        if (p.kind === 'investigation_package') {
          const pk = await engine.getPackage(ctx, p.id, p.revision);
          const all = await packagesOf(sql, ctx, p.id);
          const src = (await sql.query<{ sources: string[]; finding_ids: string[] }>(`select sources, finding_ids from ${S}.packages where tenant_id=$1 and project_id=$2 and investigation_id=$3 and version=$4`, [...scope(ctx), p.id, pk.version]))[0] as { sources: string[]; finding_ids: string[] };
          return { ref: pk.ref, kind: p.kind, title: `Investigation package v${pk.version}`, state: pk.blocked ? 'blocked' : pk.stale ? 'stale' : pk.current ? 'current' : 'superseded', stale: pk.stale, blocked: pk.blocked, staleReasons: reasons(pk.staleReasons), versions: all.map((v) => ({ revision: v.version, at: v.builtAt, actorId: v.builtBy, summary: v.digest })), sources: [...src.sources, ...src.finding_ids.map((f) => uref(EID, 'finding', f))], dependents: [], permissions: [], decisions: [], history: await history(uref(EID, 'investigation_package', p.id, pk.version)), data: { version: pk.version, digest: pk.digest, current: pk.current, investigation: uref(EID, 'investigation', p.id) } };
        }
        if (p.kind === 'attempt') {
          const row = (await sql.query(`select * from ${S}.attempts where tenant_id=$1 and project_id=$2 and id=$3`, [...scope(ctx), p.id]))[0];
          if (row === undefined) return null;
          const a = toAttempt(row); await inv(sql, ctx, a.investigationId);
          return { ref: a.ref, kind: 'attempt', title: `${a.method}: ${a.target}`.slice(0, 300), state: a.outcome, stale: false, blocked: false, staleReasons: [], versions: [], sources: [...a.refs], dependents: [], permissions: [], decisions: [], history: await history(a.ref), data: a as unknown as Json };
        }
        if (!(KINDS as readonly string[]).includes(p.kind)) return null;
        const [rec] = await child<Record<string, unknown>>(sql, ctx, p.kind as Kind, p.id);
        const bare = uref(EID, rec.kind, rec.id);
        const versions = (await engine.revisions(ctx, rec.kind, rec.id)).map((v) => ({ revision: v.revision, at: v.at, actorId: v.actorId, summary: v.summary }));
        let dependents: string[] = [];
        if (rec.kind === 'finding') dependents = [...(await sql.query(`select investigation_id, version from ${S}.packages where tenant_id=$1 and project_id=$2 and $3 = any(finding_ids)`, [...scope(ctx), rec.id])).map((r) => uref(EID, 'investigation_package', r.investigation_id as string, r.version as number)), ...(await listRecs<QuestionData>(sql, ctx, 'question', rec.investigationId)).filter((q) => q.data.findingIds.includes(rec.id)).map((q) => uref(EID, 'question', q.id))];
        if (rec.kind === 'investigation') dependents = (await packagesOf(sql, ctx, rec.id)).map((x) => x.ref);
        const data = rec.data as { reviews?: Json[]; closures?: Json[]; decision?: Json };
        return { ref: rec.ref, kind: rec.kind, title: (await sql.query<{ title: string }>(`select title from ${S}.records where tenant_id=$1 and project_id=$2 and kind=$3 and id=$4`, [...scope(ctx), rec.kind, rec.id]))[0]?.title ?? '', state: rec.state, stale: rec.stale, blocked: rec.blocked, staleReasons: reasons(rec.staleReasons), versions, sources: [...rec.sources], dependents, permissions: [], decisions: [...(data.reviews ?? []), ...(data.closures ?? []), ...(data.decision === undefined || data.decision === null ? [] : [data.decision])], history: await history(bare), data: rec.data as Json };
      } catch (error) { if (error instanceof DomainError && ['not_found', 'invalid_reference', 'invalid_input'].includes(error.code)) return null; throw error; }
    },
    async search(ctx: ServiceContext, query: { q: string; limit?: number }): Promise<SearchHit[]> {
      requireCapability(ctx, 'investigation:read');
      const q = typeof query?.q === 'string' ? query.q.trim().slice(0, 200) : '';
      if (q === '') return [];
      const like = `%${q.replaceAll(/[%_\\]/g, (m) => `\\${m}`)}%`;
      const rows = await sql.query(`select kind, id, revision, state, title, body, blocked from ${S}.records where tenant_id=$1 and project_id=$2 and (compartment is null or compartment = any($3)) and kind <> 'step' and (title ilike $4 or body ilike $4) order by seq desc limit ${Math.min(Math.max(Math.round(Number(query.limit ?? 20)) || 20, 1), 100)}`, [...scope(ctx), [...ctx.compartments], like]);
      return rows.map((r) => { const body = r.body as string, at = Math.max(body.toLowerCase().indexOf(q.toLowerCase()), 0); return { ref: uref(EID, r.kind as string, r.id as string, r.revision as number), kind: r.kind as string, title: r.title as string, snippet: body.slice(Math.max(at - 60, 0), at + 140), state: (r.blocked as boolean) ? 'blocked' : r.state as string }; });
    },
    async audit(ctx: ServiceContext, options: { after?: string; limit?: number; subject?: string } = {}): Promise<AuditRecord[]> { requireCapability(ctx, 'investigation:read'); return listAudit(sql, S, ctx, options); },
    async events(ctx: ServiceContext, options: { after?: string; limit?: number } = {}): Promise<EngineEvent[]> { requireCapability(ctx, 'investigation:events'); return readEvents(sql, S, { ...options, tenantId: ctx.tenantId }); },
    /**
     * A changed claim or corrected source makes the findings and packages citing it stale: the approval is flagged for renewed review and
     * nothing is rewritten. A withdrawn permission or removed source blocks them. Idempotent by eventId.
     */
    async applyUpstreamChange(ctx: ServiceContext, change: UpstreamChange): Promise<{ affected: string[] }> {
      requireCapability(ctx, 'investigation:write');
      const c = obj(change, 'change'), eventId = text(c.eventId, 'eventId', 300), refs = refList(c.refs, 'refs'), reason = text(c.reason, 'reason', 2000);
      const kind = oneOf(c.kind, ['source_corrected', 'source_superseded', 'source_removed', 'permission_withdrawn', 'permission_changed', 'claim_changed', 'content_changed', 'render_changed', 'audience_changed', 'rights_changed'] as const, 'kind');
      const effect: 'stale' | 'blocked' = kind === 'permission_withdrawn' || kind === 'source_removed' ? 'blocked' : 'stale';
      return sql.tx(async (tx) => {
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`${S}:upstream:${ctx.tenantId}:${ctx.projectId}`]);
        const prior = (await tx.query<{ affected: string[] }>(`select affected from ${S}.upstream_changes where tenant_id=$1 and project_id=$2 and event_id=$3`, [...scope(ctx), eventId]))[0];
        if (prior !== undefined) return { affected: prior.affected };
        const bare = refs.map((r) => r.split('@')[0] as string);
        const hit = (sources: readonly string[]): string[] => refs.filter((r) => sources.some((s) => urefMatches(r, s)));
        const affected: string[] = [], staleFindings = new Set<string>();
        const rows = await tx.query<{ id: string }>(`select id from ${S}.records where tenant_id=$1 and project_id=$2 and kind='finding' and state <> 'withdrawn' and exists (select 1 from unnest(sources) x where split_part(x,'@',1) = any($3)) order by seq for update`, [...scope(ctx), bare]);
        for (const row of rows) {
          const f = await loadRec<FindingData>(tx, { ...ctx, compartments: [] } as ServiceContext, 'finding', row.id).catch(() => null) ?? await rawFinding(tx, ctx, row.id);
          const matched = hit(f.sources);
          if (matched.length === 0) continue;
          await flagRec(tx, ctx, f, { effect, kind, reason, cause: eventId, refs: matched, at: ctx.now });
          await bump(tx, ctx, f.investigationId);
          const ref = uref(EID, 'finding', f.id, f.revision);
          affected.push(ref); staleFindings.add(f.id);
          await emit(tx, ctx, effect === 'stale' ? 'investigation.finding_stale' : 'investigation.finding_blocked', ref, { reason, cause: eventId, kind, refs: matched, investigationId: f.investigationId, wasApproved: f.state === 'approved' });
        }
        const pk = await tx.query(`select investigation_id, version, sources, finding_ids from ${S}.packages where tenant_id=$1 and project_id=$2 and (finding_ids && $4 or exists (select 1 from unnest(sources) x where split_part(x,'@',1) = any($3))) order by investigation_id, version for update`, [...scope(ctx), bare, [...staleFindings]]);
        for (const p of pk) {
          const matched = hit(p.sources as string[]);
          if (matched.length === 0 && !(p.finding_ids as string[]).some((f) => staleFindings.has(f))) continue;
          const ref = uref(EID, 'investigation_package', p.investigation_id as string, p.version as number);
          const entry: StaleReason = { effect, kind, reason, cause: eventId, refs: matched.length > 0 ? matched : refs, at: ctx.now };
          await tx.query(`update ${S}.packages set stale = stale or $5, blocked = blocked or $6, stale_reasons = stale_reasons || $7::jsonb where tenant_id=$1 and project_id=$2 and investigation_id=$3 and version=$4`, [...scope(ctx), p.investigation_id, p.version, effect === 'stale', effect === 'blocked', JSON.stringify([entry])]);
          await appendAudit(tx, S, ctx, `package.${effect}`, ref, { reason, cause: eventId, refs: [...entry.refs] });
          affected.push(ref);
          await emit(tx, ctx, effect === 'stale' ? 'investigation.package_stale' : 'investigation.package_blocked', ref, { reason, cause: eventId, kind, refs: [...entry.refs], investigationId: p.investigation_id as string });
        }
        await tx.query(`insert into ${S}.upstream_changes (tenant_id, project_id, event_id, kind, refs, affected, applied_at) values ($1,$2,$3,$4,$5,$6,$7)`, [...scope(ctx), eventId, kind, refs, affected, ctx.now]);
        return { affected };
      });
    },
    async health(): Promise<{ ok: boolean; detail: Json }> {
      try {
        const r = (await sql.query<{ queued: string; dead: string }>(`select count(*) filter (where state in ('queued','leased')) as queued, count(*) filter (where state='dead') as dead from ${S}._jobs`))[0] as { queued: string; dead: string };
        return { ok: true, detail: { jobsPending: Number(r.queued), jobsDead: Number(r.dead), ports: Object.fromEntries(['discovery', 'evidence', 'processing', 'knowledge', 'correspondence', 'budget', 'authorization'].map((p) => [p, (ports as Record<string, unknown>)[p] !== undefined ? 'configured' : 'unavailable'])) } };
      } catch { return { ok: false, detail: { error: 'database unavailable' } }; }
    },
  };

  /** The upstream router acts for the whole project: staleness reaches findings in compartments it cannot read, without exposing them. */
  async function rawFinding(tx: Sql, ctx: ServiceContext, id: string): Promise<Rec<FindingData>> {
    const r = (await tx.query(`select * from ${S}.records where tenant_id=$1 and project_id=$2 and kind='finding' and id=$3`, [...scope(ctx), id]))[0] as Record<string, unknown>;
    return { ref: uref(EID, 'finding', id, r.revision as number), kind: 'finding', id, investigationId: r.investigation_id as string, revision: r.revision as number, state: r.state as string, data: r.data as FindingData, sources: r.sources as string[], stale: r.stale as boolean, blocked: r.blocked as boolean, staleReasons: r.stale_reasons as StaleReason[], createdAt: '', createdBy: '', updatedAt: '', updatedBy: '' };
  }
  function propose(ctx: ServiceContext, investigationId: string, type: 'question' | 'step', input: { items: readonly unknown[]; rationale: string; source?: string; idempotencyKey?: string }): Promise<Rec<ProposalData>[]> {
    return cmd(ctx, 'investigation:plan', `propose:${type}`, { investigationId, input }, async (tx) => {
      let i = await inv(tx, ctx, investigationId, 'mutate');
      const raw = obj(input, 'input'), items = list(raw.items, 'items', 50), rationale = text(raw.rationale, 'rationale'), source = optText(raw.source, 'source', 300);
      invariant(items.length >= 1, 'invalid_input', 'At least one item is required');
      const out: Rec<ProposalData>[] = [];
      for (const item of items) {
        const o = obj(item, 'item');
        // Validate now, so that an unacceptable suggestion is refused at the door rather than at acceptance.
        if (type === 'question') { const n = normQuestion(o); await need(tx, ctx, 'question', n.parentId, i.id); } else { const n = normPlanItem({ ...o, status: 'planned' }, ACTION_NAMES); await need(tx, ctx, 'question', n.data.questionId, i.id); await need(tx, ctx, 'hypothesis', n.data.hypothesisId, i.id); await need(tx, ctx, 'lead', n.data.leadId, i.id); }
        let p = await insertRec<ProposalData>(tx, ctx, 'proposal', i.id, i.data.compartment, 'proposed', { type, item: jsonValue(o, 'item'), rationale, proposedBy: { id: ctx.actor.id, kind: ctx.actor.kind }, source, decision: null }, `${type} proposed`);
        const rule = i.data.policy.autoAccept, used = i.data.autoAccepted;
        const auto = type === 'question' ? rule.questions.enabled && used.questions < rule.questions.max && (o.material !== true || rule.questions.allowMaterial)
          : rule.steps.enabled && used.steps < rule.steps.max && typeof o.action === 'string' && rule.steps.actions.includes(o.action);
        if (auto) {
          p = await settleProposal(tx, ctx, i, p, 'accept', 'accepted by investigation policy', true);
          i = await updateRec(tx, ctx, await inv(tx, ctx, i.id, 'lock'), { data: { ...i.data, autoAccepted: type === 'question' ? { ...used, questions: used.questions + 1 } : { ...used, steps: used.steps + 1 } } }, 'policy auto-acceptance counted');
        }
        out.push(p);
      }
      await bump(tx, ctx, i.id);
      return out;
    });
  }
  async function settleProposal(tx: Sql, ctx: ServiceContext, i: Rec<InvestigationData>, p: Rec<ProposalData>, decision: 'accept' | 'reject', rationale: string | null, auto: boolean): Promise<Rec<ProposalData>> {
    let createdRef: string | null = null;
    if (decision === 'accept') {
      const item = p.data.item as Body;
      createdRef = p.data.type === 'question' ? uref(EID, 'question', (await createQuestion(tx, ctx, i, item, 'proposal')).id) : uref(EID, 'plan_item', (await createPlanItem(tx, ctx, i, { ...item, status: 'planned' }, 'proposal')).id);
    }
    await bump(tx, ctx, i.id);
    return updateRec(tx, ctx, p, { state: decision === 'accept' ? 'accepted' : 'rejected', data: { ...p.data, decision: { by: auto ? 'policy' : ctx.actor.id, at: ctx.now, rationale, auto, createdRef } } }, `proposal ${decision}ed${auto ? ' by policy' : ''}`);
  }
  return engine satisfies StandardEngine;
}

// ───────────────────────────── HTTP ─────────────────────────────
export function routes(engine: InvestigationEngine): Route[] {
  // Request bodies are untyped JSON: every service method validates its input at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Loose = any;
  const b = (v: unknown): Record<string, unknown> => (v === undefined || v === null ? {} : obj(v, 'body'));
  const key = (r: { headers: Record<string, unknown>; body: unknown }): Loose => { const h = r.headers['idempotency-key']; return typeof h === 'string' && b(r.body).idempotencyKey === undefined ? { ...b(r.body), idempotencyKey: h } : b(r.body); };
  const patch = (path: string, handler: (id: string, body: Loose, ctx: ServiceContext) => Promise<unknown>): Route => ({ method: 'PATCH', path, handler: async (r) => j(await handler(r.params.id ?? '', key(r), r.ctx)) });
  const j = (v: unknown): Json => v as Json;
  const post = (path: string, handler: (id: string, body: Loose, ctx: ServiceContext, params: Readonly<Record<string, string>>) => Promise<unknown>, status = 200): Route => ({ method: 'POST', path, handler: async (r) => ({ status, json: await handler(r.params.id ?? '', key(r), r.ctx, r.params) }) });
  const get = (path: string, handler: (id: string, ctx: ServiceContext, query: URLSearchParams, params: Readonly<Record<string, string>>) => Promise<unknown>): Route => ({ method: 'GET', path, handler: async (r) => j(await handler(r.params.id ?? '', r.ctx, r.query, r.params)) });
  const all: Route[] = [
    ...standardRoutes(engine),
    post('/v1/investigations', (_i, body, ctx) => engine.openInvestigation(ctx, body), 201),
    get('/v1/investigations', (_i, ctx, q) => engine.listInvestigations(ctx, { ...(q.get('state') === null ? {} : { state: q.get('state') as string }), ...(q.get('originRef') === null ? {} : { originRef: q.get('originRef') as string }) })),
    get('/v1/investigations/:id', (id, ctx) => engine.getInvestigation(ctx, id)),
    patch('/v1/investigations/:id', (id, body, ctx) => engine.updateInvestigation(ctx, id, body)),
    get('/v1/investigations/:id/overview', (id, ctx) => engine.getOverview(ctx, id)),
    get('/v1/investigations/:id/records/:kind', (id, ctx, _q, p) => engine.list(ctx, id, p.kind as Kind)),
    get('/v1/records/:kind/:id', (id, ctx, _q, p) => engine.get(ctx, p.kind as Kind, id)),
    get('/v1/records/:kind/:id/revisions', (id, ctx, _q, p) => engine.revisions(ctx, p.kind as Kind, id)),
    post('/v1/investigations/:id/questions', (id, body, ctx) => engine.addQuestion(ctx, id, body), 201),
    patch('/v1/questions/:id', (id, body, ctx) => engine.updateQuestion(ctx, id, body)),
    post('/v1/questions/:id/disposition', (id, body, ctx) => engine.disposeQuestion(ctx, id, body)),
    post('/v1/questions/:id/answers', (id, body, ctx) => engine.disposeQuestion(ctx, id, { ...body, status: 'answered' })),
    post('/v1/questions/:id/hypotheses', (id, body, ctx) => engine.addHypothesis(ctx, id, body), 201),
    patch('/v1/hypotheses/:id', (id, body, ctx) => engine.updateHypothesis(ctx, id, body)),
    post('/v1/investigations/:id/leads', (id, body, ctx) => engine.addLead(ctx, id, body), 201),
    patch('/v1/leads/:id', (id, body, ctx) => engine.updateLead(ctx, id, body)),
    post('/v1/investigations/:id/plan-items', (id, body, ctx) => engine.addPlanItem(ctx, id, body), 201),
    patch('/v1/plan-items/:id', (id, body, ctx) => engine.updatePlanItem(ctx, id, body)),
    post('/v1/investigations/:id/attempts', (id, body, ctx) => engine.recordAttempt(ctx, id, body), 201),
    get('/v1/investigations/:id/attempts', (id, ctx, q) => engine.listAttempts(ctx, id, { notObtained: q.get('notObtained') === 'true', ...(q.get('outcome') === null ? {} : { outcome: q.get('outcome') as string }), ...(q.get('questionId') === null ? {} : { questionId: q.get('questionId') as string }) })),
    get('/v1/investigations/:id/effort', (id, ctx) => engine.effortReport(ctx, id)),
    post('/v1/investigations/:id/findings', (id, body, ctx) => engine.createFinding(ctx, id, body), 201),
    patch('/v1/findings/:id', (id, body, ctx) => engine.reviseFinding(ctx, id, body)),
    post('/v1/findings/:id/submit', (id, body, ctx) => engine.submitFinding(ctx, id, body)),
    post('/v1/findings/:id/review', (id, body, ctx) => engine.reviewFinding(ctx, id, body)),
    post('/v1/findings/:id/withdraw', (id, body, ctx) => engine.withdrawFinding(ctx, id, body)),
    post('/v1/investigations/:id/contradictions', (id, body, ctx) => engine.addContradiction(ctx, id, body), 201),
    patch('/v1/contradictions/:id', (id, body, ctx) => engine.updateContradiction(ctx, id, body)),
    post('/v1/investigations/:id/unknowns', (id, body, ctx) => engine.addUnknown(ctx, id, body), 201),
    patch('/v1/unknowns/:id', (id, body, ctx) => engine.updateUnknown(ctx, id, body)),
    post('/v1/investigations/:id/proposals/questions', (id, body, ctx) => engine.proposeQuestions(ctx, id, body), 201),
    post('/v1/investigations/:id/proposals/steps', (id, body, ctx) => engine.proposeSteps(ctx, id, body), 201),
    post('/v1/proposals/:id/decision', (id, body, ctx) => engine.decideProposal(ctx, id, body)),
    post('/v1/investigations/:id/plan', (id, _b, ctx) => engine.planNextSteps(ctx, id)),
    post('/v1/steps/:id/execute', (id, body, ctx) => engine.executeStep(ctx, id, body), 202),
    post('/v1/steps/:id/complete', (id, body, ctx) => engine.completeStep(ctx, id, body)),
    get('/v1/jobs/:id', (id, ctx) => engine.getJob(ctx, id)),
    post('/v1/jobs/:id/:action', (id, _b, ctx, p) => engine.controlJob(ctx, id, p.action as 'pause')),
    get('/v1/investigations/:id/closure-check', (id, ctx) => engine.closureCheck(ctx, id)),
    post('/v1/investigations/:id/review', (id, body, ctx) => engine.requestReview(ctx, id, body)),
    post('/v1/investigations/:id/close', (id, body, ctx) => engine.close(ctx, id, body)),
    post('/v1/investigations/:id/reopen', (id, body, ctx) => engine.reopen(ctx, id, body)),
    post('/v1/investigations/:id/packages', (id, body, ctx) => engine.buildPackage(ctx, id, body), 201),
    get('/v1/investigations/:id/packages', (id, ctx) => engine.listPackages(ctx, id)),
    get('/v1/investigations/:id/packages/:version', async (id, ctx, q, p) => {
      const pk = await engine.getPackage(ctx, id, p.version === 'latest' ? undefined : Number(p.version));
      const format = q.get('format');
      if (format !== 'markdown' && format !== 'html') return pk;
      if (pk.blocked) throw new DomainError('consent_denied', 'This package version is blocked');
      return { __raw: format === 'html' ? pk.html : pk.markdown, __type: format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8' };
    }),
  ];
  return all.map((route): Route => route.path !== '/v1/investigations/:id/packages/:version' ? route : { ...route, handler: async (r) => { const out = await route.handler(r) as { __raw?: string; __type?: string } | Json; return out !== null && typeof out === 'object' && !Array.isArray(out) && typeof (out as { __raw?: unknown }).__raw === 'string' ? { text: (out as { __raw: string }).__raw, headers: { 'content-type': (out as { __type: string }).__type, 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } } : out as Json; } });
}
