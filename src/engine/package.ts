// Investigation package: closure check, effort report, assembly and rendering. Pure functions over loaded state.
import { digest } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { NOT_OBTAINED } from './store.ts';
import type { Attempt, Rec, SourceLink } from './store.ts';
import type { ContradictionData, FindingData, HypothesisData, InvestigationData, LeadData, PlanItemData, ProposalData, QuestionData, StepData, UnknownData } from './model.ts';
import type { ChronologyEntry } from './ports.ts';

export type Loaded = Readonly<{
  investigation: Rec<InvestigationData>; questions: readonly Rec<QuestionData>[]; hypotheses: readonly Rec<HypothesisData>[]; leads: readonly Rec<LeadData>[];
  planItems: readonly Rec<PlanItemData>[]; findings: readonly Rec<FindingData>[]; contradictions: readonly Rec<ContradictionData>[]; unknowns: readonly Rec<UnknownData>[];
  proposals: readonly Rec<ProposalData>[]; steps: readonly Rec<StepData>[]; attempts: readonly Attempt[];
}>;
export type ClosureCheck = Readonly<{ ready: boolean; blockers: readonly Readonly<{ code: string; ref: string; message: string }>[]; warnings: readonly Readonly<{ code: string; ref: string; message: string }>[] }>;

const current = (f: Rec<FindingData>): boolean => f.state === 'approved' && !f.stale && !f.blocked;

/** A case cannot be called complete while a material question is silently open: every blocker must be resolved or recorded. */
export function closureCheck(s: Loaded): ClosureCheck {
  const blockers: { code: string; ref: string; message: string }[] = [], warnings: { code: string; ref: string; message: string }[] = [];
  const findings = new Map(s.findings.map((f) => [f.id, f]));
  for (const q of s.questions) {
    const d = q.data;
    if (!d.material) { if (q.state === 'open' || q.state === 'in_progress') warnings.push({ code: 'non_material_question_open', ref: q.ref, message: `Non-material question is still ${q.state}: ${d.text}` }); continue; }
    if (q.state === 'open' || q.state === 'in_progress') blockers.push({ code: 'material_question_open', ref: q.ref, message: `Material question has no recorded disposition: ${d.text}` });
    else if (q.state === 'answered') {
      const linked = d.findingIds.map((id) => findings.get(id));
      if (d.answer === null || linked.length === 0) blockers.push({ code: 'answer_unsupported', ref: q.ref, message: `Material question is marked answered without an answer and a finding: ${d.text}` });
      else if (!linked.every((f) => f !== undefined && current(f))) blockers.push({ code: 'answer_finding_not_approved', ref: q.ref, message: `The answer relies on a finding that is not currently approved (unreviewed, returned, withdrawn, stale or blocked): ${d.text}` });
    } else if (q.state === 'unresolvable') {
      if (d.rationale === null) blockers.push({ code: 'disposition_without_rationale', ref: q.ref, message: `Unresolvable question lacks a rationale: ${d.text}` });
      if (!s.unknowns.some((u) => u.data.questionId === q.id)) blockers.push({ code: 'unknown_not_registered', ref: q.ref, message: `Unresolvable question has no entry in the unknowns register: ${d.text}` });
    } else if (q.state === 'out_of_scope' && d.rationale === null) blockers.push({ code: 'disposition_without_rationale', ref: q.ref, message: `Out-of-scope question lacks a rationale: ${d.text}` });
  }
  for (const f of s.findings) {
    if (['draft', 'in_review', 'returned'].includes(f.state)) blockers.push({ code: 'finding_not_reviewed', ref: f.ref, message: `Finding is ${f.state}: complete its review or withdraw it with a rationale` });
    else if (f.state === 'approved' && f.blocked) blockers.push({ code: 'finding_blocked', ref: f.ref, message: 'An approved finding cites a source whose permission was withdrawn: revise or withdraw it' });
    else if (f.state === 'approved' && f.stale) blockers.push({ code: 'finding_stale', ref: f.ref, message: 'An approved finding is stale after an upstream change and needs renewed review' });
  }
  for (const c of s.contradictions) if (c.state === 'open') blockers.push({ code: 'contradiction_unassessed', ref: c.ref, message: `Contradiction has not been assessed as explained or unresolved: ${c.data.description}` });
  for (const st of s.steps) if (st.state === 'queued' || st.state === 'running') blockers.push({ code: 'step_in_flight', ref: st.ref, message: `A step is still ${st.state}: ${st.data.title}` });
  for (const st of s.steps) if (st.state === 'uncertain') blockers.push({ code: 'step_uncertain', ref: st.ref, message: `A step's external outcome is unknown and has not been reconciled: ${st.data.title}` });
  for (const l of s.leads) if (['new', 'assessing', 'active'].includes(l.state)) warnings.push({ code: 'lead_open', ref: l.ref, message: `Lead not pursued to an end (${l.state}): ${l.data.description}` });
  for (const p of s.planItems) if (['planned', 'running'].includes(p.state)) warnings.push({ code: 'plan_item_unexecuted', ref: p.ref, message: `Plan item not executed (${p.state}): ${p.data.description}` });
  for (const p of s.proposals) if (p.state === 'proposed') warnings.push({ code: 'proposal_undecided', ref: p.ref, message: 'A proposed question or step was neither accepted nor rejected' });
  return { ready: blockers.length === 0, blockers, warnings };
}

export type LaneEffort = Readonly<{
  laneId: string | null; name: string; targetShare: number | null; timeMinutes: number; attempts: number; costUnits: number;
  actualShare: Readonly<{ time: number | null; attempts: number | null; cost: number | null }>;
  deviation: Readonly<{ time: number | null; attempts: number | null; cost: number | null }>;
  outcomes: Readonly<Record<string, number>>; notObtained: number; refsProduced: number;
}>;
export type EffortReport = Readonly<{ lanes: readonly LaneEffort[]; totals: Readonly<{ timeMinutes: number; attempts: number; costUnits: number }>; note: string }>;
const round = (n: number): number => Math.round(n * 10_000) / 10_000;
/** Actual effort per research lane against the configured shares. Reported, never enforced: equal effort does not mean equal findings. */
export function effortReport(inv: Rec<InvestigationData>, attempts: readonly Attempt[]): EffortReport {
  const totals = { timeMinutes: 0, attempts: 0, costUnits: 0 };
  for (const a of attempts) { totals.timeMinutes += a.effort.timeMinutes; totals.attempts += a.effort.attempts; totals.costUnits += a.effort.costUnits; }
  const row = (laneId: string | null, name: string, targetShare: number | null): LaneEffort => {
    const mine = attempts.filter((a) => a.lane === laneId);
    const sum = { time: 0, attempts: 0, cost: 0 }; const outcomes: Record<string, number> = {}; const refs = new Set<string>();
    for (const a of mine) { sum.time += a.effort.timeMinutes; sum.attempts += a.effort.attempts; sum.cost += a.effort.costUnits; outcomes[a.outcome] = (outcomes[a.outcome] ?? 0) + 1; for (const r of a.refs) refs.add(r); }
    const share = (v: number, total: number): number | null => (total === 0 ? null : round(v / total));
    const actualShare = { time: share(sum.time, totals.timeMinutes), attempts: share(sum.attempts, totals.attempts), cost: share(sum.cost, totals.costUnits) };
    const dev = (v: number | null): number | null => (v === null || targetShare === null ? null : round(v - targetShare));
    return { laneId, name, targetShare, timeMinutes: round(sum.time), attempts: round(sum.attempts), costUnits: round(sum.cost), actualShare, deviation: { time: dev(actualShare.time), attempts: dev(actualShare.attempts), cost: dev(actualShare.cost) }, outcomes, notObtained: mine.filter((a) => NOT_OBTAINED.includes(a.outcome)).length, refsProduced: refs.size };
  };
  const ids = new Set(inv.data.lanes.map((l) => l.id));
  const lanes = inv.data.lanes.map((l) => row(l.id, l.name, l.targetShare));
  if (attempts.some((a) => a.lane === null)) lanes.push(row(null, 'Unassigned', null));
  for (const stray of new Set(attempts.map((a) => a.lane).filter((l): l is string => l !== null && !ids.has(l)))) lanes.push(row(stray, `${stray} (lane no longer configured)`, null));
  return { lanes, totals: { timeMinutes: round(totals.timeMinutes), attempts: round(totals.attempts), costUnits: round(totals.costUnits) }, note: 'Effort shares are reported against the configured targets and are not enforced. Equal effort in a lane does not imply equal findings from it.' };
}

export type EvidenceIndexEntry = Readonly<{ ref: string; verified: boolean; available: boolean | null; sha256: string | null; size: number | null; mediaType: string | null; filename: string | null; origin: Json | null; custodySummary: string | null; note: string | null; citedBy: readonly string[] }>;
export type ChronologyResult = Readonly<{ available: boolean; reason: string | null; entries: readonly ChronologyEntry[] }>;

const link = (l: SourceLink): Json => ({ ref: l.ref, selector: l.selector, note: l.note });
const fared: Readonly<Record<string, string>> = {
  open: 'Not tested to a conclusion.', supported: 'Supported by the evidence gathered.', contradicted: 'Contradicted by evidence, not conclusively excluded.',
  refuted: 'Refuted by the evidence gathered.', inconclusive: 'Tested; the evidence does not decide it.', withdrawn: 'Withdrawn.',
};

/** Builds the immutable package content. Every statement keeps its label; blocked material is withheld, never silently dropped. */
export function assemblePackage(s: Loaded, extra: { version: number; builtAt: string; builtBy: string; evidence: readonly EvidenceIndexEntry[]; chronology: ChronologyResult; previous: { version: number; digest: string } | null; portNotes: readonly string[] }): Record<string, Json> {
  const inv = s.investigation, d = inv.data;
  const closure = closureCheck(s);
  const depth = (q: Rec<QuestionData>): number => { let n = 0, p = q.data.parentId; while (p !== null && n < 64) { n++; p = s.questions.find((x) => x.id === p)?.data.parentId ?? null; } return n; };
  const included = s.findings.filter((f) => f.state === 'approved' && !f.blocked);
  const byClaim = new Map<string, string>();
  for (const f of included) if (!f.stale) for (const l of [...f.data.supporting, ...f.data.contradicting]) if (l.ref.startsWith('E07:')) {
    const label = f.data.classification === 'established' ? 'established' : f.data.classification === 'unknown' ? 'unknown' : 'disputed';
    const bare = l.ref.split('@')[0] as string;
    if (byClaim.get(bare) !== 'disputed') byClaim.set(bare, byClaim.has(bare) && byClaim.get(bare) !== label ? 'disputed' : label);
  }
  const limitations = [...extra.portNotes];
  if (included.some((f) => f.stale)) limitations.push('One or more approved findings are stale after an upstream change and await renewed review; they are marked stale below.');
  if (s.findings.some((f) => f.blocked)) limitations.push('One or more findings are withheld because permission for a cited source was withdrawn.');
  if (!closure.ready) limitations.push('The investigation is not ready for closure: see closure.blockers.');
  const content: Record<string, Json> = {
    schema: 'investigation-package/v1', version: extra.version, builtAt: extra.builtAt, builtBy: extra.builtBy, previousVersion: extra.previous,
    investigation: { ref: inv.ref, id: inv.id, title: d.title, state: inv.state, originRef: d.originRef, openedAt: inv.createdAt, closures: d.closures as unknown as Json, reopenings: d.reopenings as unknown as Json },
    scope: { statement: d.scopeStatement, urgency: d.urgency, contactConstraints: d.contactConstraints },
    originalAccount: { ref: d.originalAccount.ref, summary: d.originalAccount.summary, label: d.originalAccount.label, note: 'Recorded as received and kept separate from analysis. Its inclusion does not assert that it is true.' },
    questionTree: s.questions.map((q) => ({ id: q.id, ref: q.ref, parentId: q.data.parentId, depth: depth(q), text: q.data.text, material: q.data.material, whyMaterial: q.data.whyMaterial, status: q.state,
      disposition: q.state === 'answered' ? { answer: q.data.answer, label: q.data.answerLabel, findingIds: [...q.data.findingIds] } : ['unresolvable', 'out_of_scope'].includes(q.state) ? { rationale: q.data.rationale, label: q.state === 'unresolvable' ? 'unknown' : null } : { note: 'No disposition recorded: the question remains open.' },
      dispositionBy: q.data.dispositionBy, dispositionAt: q.data.dispositionAt, claimRefs: [...q.data.claimRefs] })),
    findings: included.map((f) => ({ id: f.id, ref: f.ref, revision: f.revision, statement: f.data.statement, label: f.data.label, classification: f.data.classification, confidence: f.data.confidence, questionIds: [...f.data.questionIds],
      supporting: f.data.supporting.map(link), contradicting: f.data.contradicting.map(link), limitations: [...f.data.limitations], checklist: f.data.checklist as unknown as Json,
      review: { state: f.state, authors: [...f.data.authors], reviews: f.data.reviews as unknown as Json }, stale: f.stale, staleReasons: f.staleReasons.filter((r) => r.resolved !== true).map((r) => `${r.kind}: ${r.reason}`) })),
    findingsNotIncluded: s.findings.filter((f) => !included.includes(f)).map((f) => ({ id: f.id, ref: f.ref, state: f.state, reason: f.blocked ? 'withheld: permission for a cited source was withdrawn' : f.state === 'withdrawn' ? `withdrawn: ${f.data.withdrawal?.rationale ?? ''}` : `not approved (${f.state})` })),
    explanations: s.questions.filter((q) => s.hypotheses.some((h) => h.data.questionId === q.id)).map((q) => ({ questionId: q.id, question: q.data.text,
      hypotheses: s.hypotheses.filter((h) => h.data.questionId === q.id).map((h) => ({ id: h.id, ref: h.ref, explanation: h.data.explanation, label: 'inference', predictedObservations: h.data.predictedObservations as unknown as Json, contraryTest: h.data.contraryTest,
        supporting: h.data.supporting.map(link), contradicting: h.data.contradicting.map(link), status: h.state, statusRationale: h.data.statusRationale, howItFared: fared[h.state] ?? h.state })) })),
    contradictions: s.contradictions.map((c) => ({ id: c.id, ref: c.ref, description: c.data.description, accountExcerpt: c.data.accountExcerpt, accountRef: c.data.accountRef, contradicting: c.data.contradicting.map(link), questionId: c.data.questionId, findingId: c.data.findingId, status: c.state, resolutionNote: c.data.resolutionNote })),
    unknowns: s.unknowns.map((u) => ({ id: u.id, ref: u.ref, description: u.data.description, label: 'unknown', whyUnknown: u.data.whyUnknown, whatWouldResolve: u.data.whatWouldResolve, questionId: u.data.questionId, attemptIds: [...u.data.attemptIds], status: u.state, resolutionNote: u.data.resolutionNote })),
    attempts: {
      total: s.attempts.length,
      byOutcome: Object.fromEntries([...new Set(s.attempts.map((a) => a.outcome))].sort().map((o) => [o, s.attempts.filter((a) => a.outcome === o).length])),
      byKind: Object.fromEntries([...new Set(s.attempts.map((a) => a.kind))].sort().map((k) => [k, s.attempts.filter((a) => a.kind === k).length])),
      notObtained: s.attempts.filter((a) => NOT_OBTAINED.includes(a.outcome)).map((a) => ({ id: a.id, seq: a.seq, at: a.at, kind: a.kind, target: a.target, method: a.method, outcome: a.outcome, detail: a.detail, questionId: a.questionId, lane: a.lane })),
      log: s.attempts.map((a) => ({ id: a.id, seq: a.seq, at: a.at, kind: a.kind, target: a.target, method: a.method, outcome: a.outcome, lane: a.lane, questionId: a.questionId, refs: [...a.refs], corrects: a.corrects })),
    },
    chronology: { available: extra.chronology.available, reason: extra.chronology.reason, entries: extra.chronology.entries.map((e) => {
      const mine = byClaim.get(e.claimRef.split('@')[0] as string);
      const label = mine ?? (e.status === 'established' || e.status === 'disputed' ? e.status : 'unknown');
      return { at: e.at, description: e.description, claimRef: e.claimRef, label, basis: mine !== undefined ? 'approved finding in this investigation' : e.status === 'established' || e.status === 'disputed' ? 'status reported by the knowledge engine' : 'no approved finding or reported status', sources: [...(e.sources ?? [])] };
    }) },
    evidenceIndex: extra.evidence as unknown as Json,
    effortByLane: effortReport(inv, s.attempts) as unknown as Json,
    notPursued: { leads: s.leads.filter((l) => ['new', 'assessing', 'active'].includes(l.state)).map((l) => ({ id: l.id, kind: l.data.kind, description: l.data.description, status: l.state })),
      planItems: s.planItems.filter((p) => ['planned', 'running', 'cancelled', 'skipped', 'failed'].includes(p.state)).map((p) => ({ id: p.id, kind: p.data.kind, description: p.data.description, status: p.state, statusNote: p.data.statusNote, questionId: p.data.questionId })) },
    limitations, closure: closure as unknown as Json,
  };
  content.digest = digest(content);
  return content;
}

// ───────────────────────────── Rendering ─────────────────────────────
type A = Record<string, unknown>;
const arr = (v: unknown): A[] => (Array.isArray(v) ? v as A[] : []);
const str = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const cite = (l: A): string => `${str(l.ref)}${l.selector === null || l.selector === undefined ? '' : ` [${str(l.selector)}]`}${l.note ? ` (${str(l.note)})` : ''}`;
type Block = { h?: [number, string]; p?: string; items?: string[]; table?: { head: string[]; rows: string[][] } };

function blocks(c: A): Block[] {
  const out: Block[] = [];
  const inv = c.investigation as A, acct = c.originalAccount as A, scope = c.scope as A, att = c.attempts as A, chrono = c.chronology as A, closure = c.closure as A, eff = c.effortByLane as A;
  out.push({ h: [1, `Investigation package: ${str(inv.title)}`] }, { p: `Version ${str(c.version)} · built ${str(c.builtAt)} · state ${str(inv.state)} · digest ${str(c.digest)}` }, { p: `Investigation ${str(inv.ref)} · opened from ${str(inv.originRef)}` });
  out.push({ h: [2, 'Scope'] }, { p: str(scope.statement) });
  out.push({ h: [2, 'Original account (as received)'] }, { p: `[${str(acct.label)}] ${str(acct.summary)}` }, { p: `Reference: ${acct.ref === null ? 'none recorded' : str(acct.ref)}. ${str(acct.note)}` });
  out.push({ h: [2, 'Limitations of this package'] }, { items: arr(c.limitations).length === 0 ? ['None recorded at package level; see the limitations of each finding.'] : (c.limitations as string[]) });
  out.push({ h: [2, 'Question tree'] }, { items: arr(c.questionTree).map((q) => { const d = q.disposition as A; return `${'— '.repeat(Number(q.depth))}[${str(q.status)}${q.material === true ? ', material' : ''}] ${str(q.text)} → ${d.answer !== undefined ? `[${str(d.label)}] ${str(d.answer)} (findings: ${arr(d.findingIds).map(str).join(', ') || (d.findingIds as string[]).join(', ')})` : d.rationale !== undefined ? `Rationale: ${str(d.rationale)}` : str(d.note)}`; }) });
  out.push({ h: [2, 'Findings'] });
  if (arr(c.findings).length === 0) out.push({ p: 'No approved findings.' });
  for (const f of arr(c.findings)) {
    const conf = f.confidence as A;
    out.push({ h: [3, `[${str(f.label)} · ${str(f.classification)}] ${str(f.statement)}`] }, { p: `Finding ${str(f.ref)}${f.stale === true ? ' · STALE, awaiting renewed review' : ''} · confidence: ${str(conf.level)} — ${str(conf.basis)}` });
    out.push({ p: 'Supporting sources:' }, { items: arr(f.supporting).length === 0 ? ['none'] : arr(f.supporting).map(cite) }, { p: 'Contradicting sources:' }, { items: arr(f.contradicting).length === 0 ? ['none'] : arr(f.contradicting).map(cite) });
    out.push({ p: 'Limitations:' }, { items: f.limitations as string[] }, { p: 'Verification checklist:' }, { items: Object.entries(f.checklist as A).map(([k, v]) => `${k}: ${str((v as A).status)}${(v as A).note ? ` — ${str((v as A).note)}` : ''}`) });
  }
  if (arr(c.findingsNotIncluded).length > 0) out.push({ h: [3, 'Findings not included'] }, { items: arr(c.findingsNotIncluded).map((f) => `${str(f.ref)}: ${str(f.reason)}`) });
  out.push({ h: [2, 'Competing explanations'] });
  if (arr(c.explanations).length === 0) out.push({ p: 'None recorded.' });
  for (const e of arr(c.explanations)) out.push({ h: [3, str(e.question)] }, { items: arr(e.hypotheses).map((h) => `[inference · ${str(h.status)}] ${str(h.explanation)} — ${str(h.howItFared)}${h.statusRationale ? ` ${str(h.statusRationale)}` : ''}${arr(h.supporting).length ? ` Supporting: ${arr(h.supporting).map(cite).join('; ')}.` : ''}${arr(h.contradicting).length ? ` Contradicting: ${arr(h.contradicting).map(cite).join('; ')}.` : ''}`) });
  out.push({ h: [2, 'Contradictions with the account'] }, { items: arr(c.contradictions).length === 0 ? ['None recorded.'] : arr(c.contradictions).map((x) => `[${str(x.status)}] ${str(x.description)}${x.accountExcerpt ? ` Account says: “${str(x.accountExcerpt)}”.` : ''} Contradicted by: ${arr(x.contradicting).map(cite).join('; ')}.${x.resolutionNote ? ` ${str(x.resolutionNote)}` : ''}`) });
  out.push({ h: [2, 'What remains unknown'] }, { items: arr(c.unknowns).length === 0 ? ['None recorded.'] : arr(c.unknowns).map((u) => `[unknown · ${str(u.status)}] ${str(u.description)} — ${str(u.whyUnknown)}${u.whatWouldResolve ? ` Would be resolved by: ${str(u.whatWouldResolve)}` : ''}`) });
  out.push({ h: [2, 'What was attempted'] }, { p: `${str(att.total)} attempts. By outcome: ${Object.entries(att.byOutcome as A).map(([k, v]) => `${k} ${str(v)}`).join(', ') || 'none'}.` }, { h: [3, 'What could not be obtained'] },
    { items: arr(att.notObtained).length === 0 ? ['Nothing recorded as not obtained.'] : arr(att.notObtained).map((a) => `#${str(a.seq)} ${str(a.at)} ${str(a.kind)} via ${str(a.method)} — ${str(a.target)}: ${str(a.outcome)}${a.detail ? ` (${str(a.detail)})` : ''}`) });
  out.push({ h: [2, 'Factual chronology'] });
  if (chrono.available !== true) out.push({ p: `Not available: ${str(chrono.reason)}` });
  else out.push({ items: arr(chrono.entries).length === 0 ? ['No dated entries.'] : arr(chrono.entries).map((e) => `${str(e.at)} [${str(e.label)}] ${str(e.description)} (${str(e.claimRef)}; ${str(e.basis)})`) });
  out.push({ h: [2, 'Evidence index'] }, { table: { head: ['Evidence version', 'SHA-256', 'Media type', 'Origin', 'Custody', 'Cited by'], rows: arr(c.evidenceIndex).map((e) => [str(e.ref), e.sha256 === null ? `not verified${e.note ? `: ${str(e.note)}` : ''}` : str(e.sha256), str(e.mediaType), str(e.origin) || 'not provided', str(e.custodySummary) || 'not provided', arr(e.citedBy).map(str).join(', ') || (e.citedBy as string[]).join(', ')]) } });
  out.push({ h: [2, 'Effort by research lane'] }, { table: { head: ['Lane', 'Target share', 'Attempts', 'Share of attempts', 'Time (min)', 'Cost units', 'Not obtained'], rows: arr(eff.lanes).map((l) => [str(l.name), str(l.targetShare), str(l.attempts), str((l.actualShare as A).attempts), str(l.timeMinutes), str(l.costUnits), str(l.notObtained)]) } }, { p: str(eff.note) });
  out.push({ h: [2, 'Closure'] }, { p: closure.ready === true ? 'No closure blockers at build time.' : 'Not ready for closure:' }, { items: [...arr(closure.blockers).map((b) => `BLOCKER ${str(b.message)}`), ...arr(closure.warnings).map((w) => `Note: ${str(w.message)}`)] });
  return out.filter((b) => b.items === undefined || b.items.length > 0);
}
const mdEsc = (s: string): string => s.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');
export function renderMarkdown(content: Record<string, Json>): string {
  return blocks(content).map((b) => b.h !== undefined ? `${'#'.repeat(b.h[0])} ${b.h[1].replaceAll(/\r?\n/g, ' ')}` : b.p !== undefined ? b.p : b.items !== undefined ? b.items.map((i) => `- ${i.replaceAll(/\r?\n/g, ' ')}`).join('\n')
    : `| ${(b.table as { head: string[] }).head.join(' | ')} |\n|${(b.table as { head: string[] }).head.map(() => ' --- ').join('|')}|\n${(b.table as { rows: string[][] }).rows.map((r) => `| ${r.map(mdEsc).join(' | ')} |`).join('\n')}`).join('\n\n') + '\n';
}
const esc = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export function renderHtml(content: Record<string, Json>): string {
  const body = blocks(content).map((b) => b.h !== undefined ? `<h${b.h[0]}>${esc(b.h[1])}</h${b.h[0]}>` : b.p !== undefined ? `<p>${esc(b.p)}</p>` : b.items !== undefined ? `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
    : `<table><thead><tr>${(b.table as { head: string[] }).head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${(b.table as { rows: string[][] }).rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('\n');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(str((content.investigation as A).title))}</title><style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;line-height:1.5}table{border-collapse:collapse;width:100%}th,td{border:1px solid #888;padding:.3rem;text-align:left;vertical-align:top;word-break:break-word}</style></head><body>\n${body}\n</body></html>\n`;
}
