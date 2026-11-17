// Investigation views: question tree, hypothesis matrix, lead board, interview schedule, coverage and missing-evidence map,
// findings timeline (engine catalog E08 "visual"). Pure functions over loaded state; nothing here writes or calls a port.
// Every view is derived from stored records only: no status is inferred that the records do not state.
import type { Json } from '../contracts.ts';
import { NOT_OBTAINED } from './store.ts';
import type { Attempt } from './store.ts';
import type { ClosureCheck, EffortReport, Loaded } from './package.ts';

export const VIEW_NAMES = ['questionTree', 'hypothesisMatrix', 'leadBoard', 'interviewSchedule', 'coverageMap', 'findingsTimeline'] as const;
export type ViewName = typeof VIEW_NAMES[number];

export type QuestionNode = Readonly<{
  id: string; ref: string; text: string; material: boolean; status: string; depth: number; answer: string | null; answerLabel: string | null;
  rationale: string | null; hypotheses: number; findings: readonly string[]; stale: boolean; blocked: boolean; children: readonly QuestionNode[];
}>;
export type InvestigationViews = Readonly<{
  schema: 'investigation-views/v1'; investigationId: string; title: string; state: string; generatedAt: string;
  questionTree: readonly QuestionNode[];
  hypothesisMatrix: readonly Readonly<{
    hypothesisId: string; ref: string; questionId: string; question: string; explanation: string; status: string; statusRationale: string | null;
    contraryTest: string | null; predicted: Readonly<{ yes: number; no: number; notTested: number }>; supporting: number; contradicting: number;
    planItems: number; attempts: number; tested: boolean;
  }>[];
  leadBoard: readonly Readonly<{ status: string; leads: readonly Readonly<{ id: string; ref: string; kind: string; description: string; priority: number; lane: string | null; questionIds: readonly string[]; assessment: string | null }>[] }>[];
  interviewSchedule: readonly Readonly<{
    id: string; ref: string; status: string; plannedFor: string | null; questionId: string; question: string; material: boolean; interviewee: string;
    channel: string | null; consentRecorded: boolean; safeguards: string | null; outcomeNote: string | null; stale: boolean; blocked: boolean;
  }>[];
  coverageMap: Readonly<{
    questions: readonly Readonly<{
      questionId: string; question: string; material: boolean; status: string; planItems: Readonly<Record<string, number>>;
      attempts: Readonly<Record<string, number>>; notObtained: number; openUnknowns: number; untried: boolean;
    }>[];
    missingEvidence: readonly Readonly<{ code: string; ref: string; questionId: string | null; description: string }>[];
    effortByLane: EffortReport['lanes'];
  }>;
  findingsTimeline: readonly Readonly<{ at: string; event: string; ref: string; findingId: string | null; actorId: string; description: string }>[];
  closure: ClosureCheck;
}>;

const count = <T>(items: readonly T[], key: (t: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
};

export function buildViews(s: Loaded, extra: { closure: ClosureCheck; effort: EffortReport; generatedAt: string }): InvestigationViews {
  const qText = new Map(s.questions.map((q) => [q.id, q] as const));
  const nodes = (parent: string | null, depth: number): QuestionNode[] => s.questions
    .filter((q) => q.data.parentId === parent)
    .sort((a, b) => Number(b.data.material) - Number(a.data.material) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((q) => ({
      id: q.id, ref: q.ref, text: q.data.text, material: q.data.material, status: q.state, depth, answer: q.data.answer, answerLabel: q.data.answerLabel,
      rationale: q.data.rationale, hypotheses: s.hypotheses.filter((h) => h.data.questionId === q.id).length, findings: [...q.data.findingIds],
      stale: q.stale, blocked: q.blocked, children: nodes(q.id, depth + 1),
    }));
  // Orphans (parent missing from the loaded set) are shown at the root rather than hidden.
  const known = new Set(s.questions.map((q) => q.id));
  const roots = [...nodes(null, 0), ...s.questions.filter((q) => q.data.parentId !== null && !known.has(q.data.parentId)).flatMap((q) => nodes(q.data.parentId, 0))];

  const hypothesisMatrix = s.hypotheses.map((h) => {
    const planItems = s.planItems.filter((p) => p.data.hypothesisId === h.id).length;
    const attempts = s.attempts.filter((a) => a.hypothesisId === h.id).length;
    const obs = h.data.predictedObservations;
    return {
      hypothesisId: h.id, ref: h.ref, questionId: h.data.questionId, question: qText.get(h.data.questionId)?.data.text ?? '', explanation: h.data.explanation,
      status: h.state, statusRationale: h.data.statusRationale, contraryTest: h.data.contraryTest,
      predicted: { yes: obs.filter((o) => o.observed === 'yes').length, no: obs.filter((o) => o.observed === 'no').length, notTested: obs.filter((o) => o.observed === 'not_tested').length },
      supporting: h.data.supporting.length, contradicting: h.data.contradicting.length, planItems, attempts,
      tested: attempts > 0 || h.data.supporting.length + h.data.contradicting.length > 0 || obs.some((o) => o.observed !== 'not_tested'),
    };
  });

  const leadBoard = ['new', 'assessing', 'active', 'exhausted', 'dismissed', 'converted'].map((status) => ({
    status,
    leads: s.leads.filter((l) => l.state === status).sort((a, b) => a.data.priority - b.data.priority || a.id.localeCompare(b.id))
      .map((l) => ({ id: l.id, ref: l.ref, kind: l.data.kind, description: l.data.description, priority: l.data.priority, lane: l.data.lane, questionIds: [...l.data.questionIds], assessment: l.data.assessment })),
  }));

  const interviewSchedule = [...s.interviews]
    .sort((a, b) => (a.data.plannedFor ?? '￿').localeCompare(b.data.plannedFor ?? '￿') || a.id.localeCompare(b.id))
    .map((iv) => {
      const q = qText.get(iv.data.questionId);
      return {
        id: iv.id, ref: iv.ref, status: iv.state, plannedFor: iv.data.plannedFor, questionId: iv.data.questionId, question: q?.data.text ?? '', material: q?.data.material ?? false,
        interviewee: iv.data.interviewee, channel: iv.data.channel, consentRecorded: iv.data.consentRef !== null, safeguards: iv.data.safeguards, outcomeNote: iv.data.outcomeNote,
        stale: iv.stale, blocked: iv.blocked,
      };
    });

  const notObtained = (a: Attempt): boolean => NOT_OBTAINED.includes(a.outcome);
  const missingEvidence: { code: string; ref: string; questionId: string | null; description: string }[] = [];
  const questions = s.questions.map((q) => {
    const items = s.planItems.filter((p) => p.data.questionId === q.id);
    const tries = s.attempts.filter((a) => a.questionId === q.id);
    const untried = items.length === 0 && tries.length === 0;
    if (untried && q.data.material && ['open', 'in_progress'].includes(q.state)) missingEvidence.push({ code: 'material_question_untried', ref: q.ref, questionId: q.id, description: `Nothing planned or attempted yet: ${q.data.text}` });
    return {
      questionId: q.id, question: q.data.text, material: q.data.material, status: q.state, planItems: count(items, (p) => p.state), attempts: count(tries, (a) => a.outcome),
      notObtained: tries.filter(notObtained).length, openUnknowns: s.unknowns.filter((u) => u.data.questionId === q.id && u.state === 'open').length, untried,
    };
  });
  // A target counts as not obtained only while no later attempt on the same target succeeded or partly succeeded.
  const latest = new Map<string, Attempt>();
  for (const a of [...s.attempts].sort((x, y) => x.seq - y.seq)) latest.set(`${a.kind}\u0000${a.target}`, a);
  for (const a of latest.values()) if (notObtained(a)) missingEvidence.push({ code: `not_obtained_${a.outcome}`, ref: a.ref, questionId: a.questionId, description: `${a.kind} ${a.target}: ${a.detail}` });
  for (const u of s.unknowns) if (u.state === 'open') missingEvidence.push({ code: 'unknown_open', ref: u.ref, questionId: u.data.questionId, description: `${u.data.description}${u.data.whatWouldResolve === null ? '' : ` (would be resolved by: ${u.data.whatWouldResolve})`}` });
  for (const h of hypothesisMatrix) if (h.status === 'open' && !h.tested) missingEvidence.push({ code: 'explanation_untested', ref: h.ref, questionId: h.questionId, description: `No test, observation or source yet for: ${h.explanation}` });

  const timeline: { at: string; event: string; ref: string; findingId: string | null; actorId: string; description: string }[] = [];
  const inv = s.investigation;
  timeline.push({ at: inv.createdAt, event: 'investigation_opened', ref: inv.ref, findingId: null, actorId: inv.createdBy, description: inv.data.title });
  for (const f of s.findings) {
    timeline.push({ at: f.createdAt, event: 'finding_drafted', ref: f.ref, findingId: f.id, actorId: f.createdBy, description: f.data.statement });
    for (const r of f.data.reviews) timeline.push({ at: r.at, event: r.decision === 'approve' ? (r.renewed ? 'finding_renewed' : 'finding_approved') : 'finding_returned', ref: f.ref, findingId: f.id, actorId: r.by, description: r.notes ?? f.data.statement });
    if (f.data.withdrawal !== null) timeline.push({ at: f.data.withdrawal.at, event: 'finding_withdrawn', ref: f.ref, findingId: f.id, actorId: f.data.withdrawal.by, description: f.data.withdrawal.rationale });
    if (f.stale || f.blocked) timeline.push({ at: f.updatedAt, event: f.blocked ? 'finding_blocked' : 'finding_stale', ref: f.ref, findingId: f.id, actorId: f.updatedBy, description: f.staleReasons.filter((r) => r.resolved !== true).map((r) => r.reason).join('; ') || f.data.statement });
  }
  for (const c of inv.data.closures) timeline.push({ at: c.at, event: 'investigation_closed', ref: inv.ref, findingId: null, actorId: c.by, description: `${c.rationale} (package v${c.packageVersion})` });
  for (const r of inv.data.reopenings) timeline.push({ at: r.at, event: 'investigation_reopened', ref: inv.ref, findingId: null, actorId: r.by, description: r.reason });
  timeline.sort((a, b) => a.at.localeCompare(b.at) || a.event.localeCompare(b.event) || a.ref.localeCompare(b.ref));

  return {
    schema: 'investigation-views/v1', investigationId: inv.id, title: inv.data.title, state: inv.state, generatedAt: extra.generatedAt,
    questionTree: roots, hypothesisMatrix, leadBoard, interviewSchedule,
    coverageMap: { questions, missingEvidence, effortByLane: extra.effort.lanes }, findingsTimeline: timeline, closure: extra.closure,
  };
}

const esc = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v as Json))
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const table = (caption: string, head: readonly string[], rows: readonly (readonly unknown[])[]): string => rows.length === 0
  ? `<p>${esc(caption)}: none recorded.</p>`
  : `<table><caption>${esc(caption)}</caption><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const tree = (nodes: readonly QuestionNode[]): string => nodes.length === 0 ? '' : `<ul>${nodes.map((n) => `<li><strong>[${esc(n.status)}${n.material ? ' · material' : ''}${n.stale ? ' · stale' : ''}${n.blocked ? ' · blocked' : ''}]</strong> ${esc(n.text)}${n.answer === null ? '' : ` — <em>${esc(n.answerLabel ?? '')}</em>: ${esc(n.answer)}`}${n.rationale === null ? '' : ` (${esc(n.rationale)})`}${tree(n.children)}</li>`).join('')}</ul>`;
const counts = (r: Readonly<Record<string, number>>): string => Object.entries(r).map(([k, v]) => `${k} ${v}`).join(', ') || '—';

/** Escaped, script-free HTML of every view. Served with a restrictive CSP. */
export function renderViewsHtml(v: InvestigationViews): string {
  const sections = [
    `<h1>${esc(v.title)}</h1><p>State: ${esc(v.state)} · generated ${esc(v.generatedAt)} · closure ${v.closure.ready ? 'ready' : `blocked (${v.closure.blockers.length})`}</p>`,
    `<section aria-labelledby="v-tree"><h2 id="v-tree">Question tree</h2>${v.questionTree.length === 0 ? '<p>No questions recorded.</p>' : tree(v.questionTree)}</section>`,
    `<section aria-labelledby="v-matrix"><h2 id="v-matrix">Hypothesis matrix</h2>${table('Competing explanations', ['Question', 'Explanation', 'Status', 'Predicted yes/no/untested', 'Supporting', 'Contradicting', 'Contrary test', 'Tested'],
      v.hypothesisMatrix.map((h) => [h.question, h.explanation, h.status, `${h.predicted.yes}/${h.predicted.no}/${h.predicted.notTested}`, h.supporting, h.contradicting, h.contraryTest ?? '—', h.tested ? 'yes' : 'no']))}</section>`,
    `<section aria-labelledby="v-leads"><h2 id="v-leads">Lead board</h2>${v.leadBoard.map((c) => table(`${c.status} (${c.leads.length})`, ['Priority', 'Kind', 'Lead', 'Lane', 'Assessment'], c.leads.map((l) => [l.priority, l.kind, l.description, l.lane ?? '—', l.assessment ?? '—']))).join('')}</section>`,
    `<section aria-labelledby="v-interviews"><h2 id="v-interviews">Interview schedule</h2>${table('Interview plans (no contact details; nothing is sent)', ['Planned for', 'Status', 'Interviewee', 'Question', 'Channel', 'Consent recorded', 'Outcome'],
      v.interviewSchedule.map((i) => [i.plannedFor ?? 'unscheduled', `${i.status}${i.stale ? ' · stale' : ''}${i.blocked ? ' · blocked' : ''}`, i.interviewee, `${i.question}${i.material ? ' (material)' : ''}`, i.channel ?? '—', i.consentRecorded ? 'yes' : 'no', i.outcomeNote ?? '—']))}</section>`,
    `<section aria-labelledby="v-coverage"><h2 id="v-coverage">Coverage and missing evidence</h2>${table('Coverage by question', ['Question', 'Status', 'Plan items', 'Attempts', 'Not obtained', 'Open unknowns'],
      v.coverageMap.questions.map((q) => [`${q.question}${q.material ? ' (material)' : ''}`, q.status, counts(q.planItems), counts(q.attempts), q.notObtained, q.openUnknowns]))}${table('Missing evidence', ['Kind', 'Description', 'Reference'], v.coverageMap.missingEvidence.map((m) => [m.code, m.description, m.ref]))}${table('Effort by lane', ['Lane', 'Target share', 'Actual share', 'Attempts'],
      v.coverageMap.effortByLane.map((l) => [l.name, l.targetShare, l.actualShare, l.attempts]))}</section>`,
    `<section aria-labelledby="v-timeline"><h2 id="v-timeline">Findings timeline</h2>${table('Findings and closure events', ['When', 'Event', 'By', 'Description'], v.findingsTimeline.map((t) => [t.at, t.event, t.actorId, t.description]))}</section>`,
  ];
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(v.title)} — views</title><style>body{font-family:system-ui,sans-serif;max-width:72rem;margin:2rem auto;padding:0 1rem;line-height:1.5}table{border-collapse:collapse;width:100%;margin:0 0 1rem}caption{text-align:left;font-weight:600}th,td{border:1px solid #888;padding:.3rem;text-align:left;vertical-align:top;word-break:break-word}</style></head><body>\n${sections.join('\n')}\n</body></html>\n`;
}
