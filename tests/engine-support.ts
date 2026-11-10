// Test support for the E08 service layer.
// The classes below are TEST DOUBLES FOR OTHER ENGINES (E03, E04, E05, E06, E07, E13): real objects over simple in-memory
// stores, used to exercise this engine's orchestration. They are not this engine's functionality; the cross-engine
// acceptance run wires the real engines.
import { DomainError } from '../src/contracts.ts';
import type { Json } from '../src/contracts.ts';
import * as kit from '../src/service-kit.ts';
import type { ChronologyEntry, ContactLead, CorrespondencePort, DiscoveryItem, DiscoveryPort, EvidenceDescribePort, KnowledgeGap, KnowledgePort, ProcessingPort, SourceCoverage } from '../src/engine/ports.ts';
import { createEngine, migrate } from '../src/engine/index.ts';
import type { EngineConfig, InvestigationPorts } from '../src/engine/index.ts';

export const ADMIN = process.env.TEST_DATABASE_URL ?? '';
export const needsPg = ADMIN === '' ? { skip: 'TEST_DATABASE_URL is not set; real-PostgreSQL test not executed' } : {};
export const ALL = ['investigation:read', 'investigation:write', 'investigation:plan', 'investigation:execute', 'investigation:contact', 'investigation:approve', 'investigation:events'];
let n = 0;
export const ctx = (over: Partial<kit.ServiceContext> & { id?: string; kind?: 'human' | 'agent' | 'service' } = {}): kit.ServiceContext => {
  const { id, kind, ...rest } = over;
  return { tenantId: 't1', projectId: 'p1', purpose: 'investigation', requestId: `r${++n}`, now: new Date().toISOString(), actor: { id: id ?? 'researcher-1', kind: kind ?? 'human', roles: [] }, capabilities: ALL, compartments: [], ...rest };
};
export const code = (c: string) => (e: unknown): boolean => e instanceof DomainError && e.code === c;

type Doc = DiscoveryItem & { keyword: string };
export class TestDiscovery implements DiscoveryPort {
  sources = new Map<string, { restricted: boolean; failing: boolean; docs: Doc[] }>();
  contacts: ContactLead[] = [];
  runs = new Map<string, { runRef: string; query: string; state: 'running' | 'completed' }>();
  calls: string[] = [];
  failNextStart: 'before' | 'after' | null = null;
  async searchSource(_c: kit.ServiceContext, input: { query: string; sourceId?: string }) {
    this.calls.push(`search:${input.query}`);
    const items: DiscoveryItem[] = [], searched: string[] = [], restricted: string[] = [];
    for (const [id, s] of this.sources) {
      if (input.sourceId !== undefined && input.sourceId !== id) continue;
      if (s.restricted) { restricted.push(id); continue; }
      searched.push(id);
      for (const { keyword, ...d } of s.docs) if (input.query.toLowerCase().includes(keyword)) items.push(d);
    }
    return { items, searched, restricted, effort: { timeMinutes: 2 } };
  }
  async startCollectionRun(_c: kit.ServiceContext, input: { query: string; idempotencyKey: string }) {
    this.calls.push(`start:${input.idempotencyKey}`);
    if (this.failNextStart === 'before') { this.failNextStart = null; throw new Error('connection refused to secret-host.internal'); }
    let run = this.runs.get(input.idempotencyKey);
    if (run === undefined) { run = { runRef: `E04:collection_run:run-${this.runs.size + 1}`, query: input.query, state: 'completed' }; this.runs.set(input.idempotencyKey, run); }
    if (this.failNextStart === 'after') { this.failNextStart = null; throw new Error('socket hang up'); }
    return { runRef: run.runRef, state: run.state, effort: { timeMinutes: 5, costUnits: 1 } };
  }
  async getCoverage(_c: kit.ServiceContext, runRef: string) {
    this.calls.push(`coverage:${runRef}`);
    const run = [...this.runs.values()].find((r) => r.runRef === runRef);
    if (run === undefined) throw new DomainError('not_found', 'Not found');
    const sources: SourceCoverage[] = [], items: DiscoveryItem[] = [];
    for (const [id, s] of this.sources) {
      if (s.restricted) { sources.push({ sourceId: id, status: 'access_restricted', itemCount: 0, note: 'Registry requires an on-site request' }); continue; }
      if (s.failing) { sources.push({ sourceId: id, status: 'failed', itemCount: 0, note: 'Source timed out' }); continue; }
      const found = s.docs.filter((d) => run.query.toLowerCase().includes(d.keyword)).map(({ keyword: _k, ...d }) => d);
      sources.push({ sourceId: id, status: found.length === 0 ? 'zero_result' : 'searched', itemCount: found.length }); items.push(...found);
    }
    return { runRef, state: run.state, sources, items, contactLeads: run.state === 'completed' ? this.contacts : [] };
  }
}
export class TestEvidence implements EvidenceDescribePort {
  versions = new Map<string, { sha256: string; filename: string; origin: Json; custody: string }>();
  failing = false;
  async describe(_c: kit.ServiceContext, ref: string) {
    if (this.failing) throw new DomainError('unavailable', 'evidence store offline');
    const v = this.versions.get(ref);
    if (v === undefined) return null;
    const p = kit.parseUref(ref);
    return { ref, evidenceId: p.id, revision: p.revision ?? 1, sha256: v.sha256, size: 1234, mediaType: 'application/pdf', filename: v.filename, compartment: null, available: true };
  }
  async describeProvenance(_c: kit.ServiceContext, ref: string) { const v = this.versions.get(ref); return v === undefined ? null : { origin: v.origin, custodySummary: v.custody, custodyEvents: 2 }; }
}
export class TestProcessing implements ProcessingPort {
  texts = new Map<string, string>(); jobs = new Map<string, string>();
  async requestProcessing(_c: kit.ServiceContext, input: { evidenceRef: string; idempotencyKey: string }) { if (!this.jobs.has(input.idempotencyKey)) this.jobs.set(input.idempotencyKey, `E06:processing_job:job-${this.jobs.size + 1}`); return { jobRef: this.jobs.get(input.idempotencyKey) as string, state: 'queued' }; }
  async getText(_c: kit.ServiceContext, evidenceRef: string) { const t = this.texts.get(evidenceRef); return t === undefined ? { available: false, reason: 'not processed yet' } : { available: true, text: t, segments: [{ selector: { page: 1 }, text: t }] }; }
  async search(_c: kit.ServiceContext, input: { query: string }) { return { hits: [...this.texts].filter(([, t]) => t.toLowerCase().includes(input.query.toLowerCase())).map(([evidenceRef, t]) => ({ evidenceRef, selector: { page: 1 } as Json, snippet: t.slice(0, 80) })) }; }
}
export class TestKnowledge implements KnowledgePort {
  claims = new Map<string, { claimRef: string; statement: string }>(); gaps: KnowledgeGap[] = []; chronology: ChronologyEntry[] = []; failing = false; gapCalls = 0;
  async proposeClaim(_c: kit.ServiceContext, input: { statement: string; idempotencyKey: string }) { if (!this.claims.has(input.idempotencyKey)) this.claims.set(input.idempotencyKey, { claimRef: `E07:claim:claim-${this.claims.size + 1}@1`, statement: input.statement }); return { claimRef: (this.claims.get(input.idempotencyKey) as { claimRef: string }).claimRef, state: 'proposed' }; }
  async createLink(_c: kit.ServiceContext, input: { idempotencyKey: string }) { return { linkRef: `E07:link:${input.idempotencyKey.replaceAll(':', '-')}` }; }
  async getSourceFamilies(_c: kit.ServiceContext, refs: readonly string[]) { return [{ familyRef: 'E07:source_family:fam-1', label: 'Municipal records', members: [...refs] }]; }
  async getGaps() { this.gapCalls++; if (this.failing) throw new DomainError('unavailable', 'knowledge engine offline'); return this.gaps; }
  async getChronology() { if (this.failing) throw new DomainError('unavailable', 'knowledge engine offline'); return this.chronology; }
  async getGraph() { return { nodes: [], edges: [] }; }
  async getImpact() { return { dependents: [] }; }
}
export class TestCorrespondence implements CorrespondencePort {
  plans = new Map<string, string>(); drafts = new Map<string, { draftRef: string; threadRef: string }>(); threads = new Map<string, { state: string; replies: { ref: string; receivedAt: string; evidenceRef?: string }[] }>(); sent = 0;
  async createContactPlan(_c: kit.ServiceContext, input: { idempotencyKey: string }) { if (!this.plans.has(input.idempotencyKey)) this.plans.set(input.idempotencyKey, `E03:contact_plan:plan-${this.plans.size + 1}`); return { planRef: this.plans.get(input.idempotencyKey) as string, state: 'draft' }; }
  async draftInquiry(_c: kit.ServiceContext, input: { idempotencyKey: string }) {
    if (!this.drafts.has(input.idempotencyKey)) { const k = this.drafts.size + 1; this.drafts.set(input.idempotencyKey, { draftRef: `E03:message_draft:draft-${k}`, threadRef: `E03:thread:thread-${k}` }); this.threads.set(`E03:thread:thread-${k}`, { state: 'awaiting_approval', replies: [] }); }
    return { ...(this.drafts.get(input.idempotencyKey) as { draftRef: string; threadRef: string }), state: 'awaiting_approval' };
  }
  async getThreadState(_c: kit.ServiceContext, threadRef: string) { const t = this.threads.get(threadRef); if (t === undefined) throw new DomainError('not_found', 'Not found'); return { threadRef, ...t }; }
}
export class TestBudget implements kit.BudgetPort {
  ceiling = 100; reserved = new Map<string, { id: string; amount: number; state: string }>();
  async reserve(_c: kit.ServiceContext, r: { amount: number; idempotencyKey: string }) {
    const prior = this.reserved.get(r.idempotencyKey); if (prior !== undefined) return { reservationId: prior.id };
    const used = [...this.reserved.values()].filter((x) => x.state !== 'released').reduce((s, x) => s + x.amount, 0);
    if (used + r.amount > this.ceiling) throw new DomainError('budget_exhausted', 'Ceiling reached');
    const id = `res-${this.reserved.size + 1}`; this.reserved.set(r.idempotencyKey, { id, amount: r.amount, state: 'reserved' }); return { reservationId: id };
  }
  async commit(_c: kit.ServiceContext, id: string) { for (const r of this.reserved.values()) if (r.id === id) r.state = 'committed'; }
  async release(_c: kit.ServiceContext, id: string) { for (const r of this.reserved.values()) if (r.id === id) r.state = 'released'; }
}
export function testPorts() {
  return { discovery: new TestDiscovery(), evidence: new TestEvidence(), processing: new TestProcessing(), knowledge: new TestKnowledge(), correspondence: new TestCorrespondence(), budget: new TestBudget() };
}
export type TestPorts = ReturnType<typeof testPorts>;
export async function withEngine<T>(fn: (h: { engine: ReturnType<typeof createEngine>; ports: TestPorts; sql: kit.Sql; make: (ports?: InvestigationPorts, config?: EngineConfig) => ReturnType<typeof createEngine> }) => Promise<T>, config: EngineConfig = {}): Promise<T> {
  const pg = (await import('pg')).default;
  return kit.withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
    await migrate(sql);
    const ports = testPorts();
    return fn({ engine: createEngine({ sql, ports, config }), ports, sql, make: (p = ports, c = config) => createEngine({ sql, ports: p, config: c }) });
  });
}
/** The kit's event feed withholds rows while other transactions are open on a shared server, so readers poll. */
export async function eventsOf(engine: ReturnType<typeof createEngine>, c: kit.ServiceContext, wanted: readonly string[]): Promise<kit.EngineEvent[]> {
  for (let i = 0; ; i++) {
    const events = await engine.events(c, { limit: 1000 });
    if (wanted.every((t) => events.some((e) => e.type === t)) || i >= 100) return events;
    await new Promise((r) => setTimeout(r, 100));
  }
}
export const EV1 = 'E05:evidence_version:ledger-2019@1', EV2 = 'E05:evidence_version:minutes-0312@2', EV3 = 'E05:evidence_version:statement-a@1';
export const DONE = { status: 'done' }, CHECKLIST_DONE = { primary_source_checked: DONE, independence_by_source_family: DONE, counter_evidence_searched: DONE, alternative_explanations_addressed: DONE, subject_response_sought: { status: 'not_done', note: 'Subject could not be located; see attempts' }, dates_identities_confirmed: DONE };
export async function openBasic(engine: ReturnType<typeof createEngine>, c: kit.ServiceContext = ctx(), extra: Record<string, unknown> = {}) {
  return engine.openInvestigation(c, { title: 'Harbour maintenance contract', originRef: 'E02:case:case-77', scopeStatement: 'Whether the 2019 harbour maintenance contract was awarded without the required tender.', originalAccount: { ref: EV3, summary: 'A former clerk reports that the contract was awarded without tender.' }, ...extra } as never);
}
export async function approvedFinding(engine: ReturnType<typeof createEngine>, investigationId: string, questionId: string, over: Record<string, unknown> = {}) {
  const f = await engine.createFinding(ctx(), investigationId, { statement: 'The contract was signed on 12 March 2019 without a published tender notice.', label: 'verified_fact', classification: 'established', questionIds: [questionId], supporting: [{ ref: EV1, selector: { page: 4, lines: '10-18' } }, { ref: 'E07:claim:claim-a@1' }], contradicting: [], limitations: ['The tender register before 2018 was not available.'], confidence: { level: 'well_supported', basis: 'Two primary records agree.' }, checklist: CHECKLIST_DONE, ...over } as never);
  await engine.submitFinding(ctx(), f.id);
  return engine.reviewFinding(ctx({ id: 'reviewer-1' }), f.id, { decision: 'approve' });
}
