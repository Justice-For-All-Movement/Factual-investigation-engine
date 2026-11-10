// Persistence primitives of the factual investigation engine: schema, revisioned records, attempts log.
import { randomUUID } from 'node:crypto';
import { DomainError, invariant, nonempty } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { appendAudit, parseUref, requireCompartment, uref, urefMatches } from '../service-kit.ts';
import type { Migration, ServiceContext, Sql } from '../service-kit.ts';

export const SCHEMA = 'e08_investigation';
export const EID = 'E08';
const S = SCHEMA;

export const migrations: readonly Migration[] = [{ id: '001_investigation', sql: `
create table {s}.records (
  seq bigserial, tenant_id text not null, project_id text not null, kind text not null, id text not null,
  investigation_id text not null, compartment text, revision integer not null, state text not null,
  title text not null, body text not null, data jsonb not null, sources text[] not null default '{}',
  stale boolean not null default false, blocked boolean not null default false, stale_reasons jsonb not null default '[]',
  created_at timestamptz not null, created_by text not null, updated_at timestamptz not null, updated_by text not null,
  primary key (tenant_id, project_id, kind, id));
create index records_by_investigation on {s}.records (tenant_id, project_id, investigation_id, kind, seq);
create index records_sources on {s}.records using gin (sources);
create table {s}.record_revisions (
  tenant_id text not null, project_id text not null, kind text not null, id text not null, revision integer not null,
  state text not null, data jsonb not null, sources text[] not null, actor_id text not null, actor_kind text not null,
  at timestamptz not null, summary text not null,
  primary key (tenant_id, project_id, kind, id, revision));
create table {s}.counters (
  tenant_id text not null, project_id text not null, investigation_id text not null,
  change_seq bigint not null default 0, attempt_seq integer not null default 0, package_seq integer not null default 0,
  primary key (tenant_id, project_id, investigation_id));
create table {s}.attempts (
  tenant_id text not null, project_id text not null, investigation_id text not null, compartment text,
  id text not null, seq integer not null, kind text not null, target text not null, method text not null,
  outcome text not null, detail text not null, lane text, question_id text, hypothesis_id text, lead_id text,
  plan_item_id text, step_id text, finding_id text, refs text[] not null default '{}',
  time_minutes numeric not null default 0, attempt_units numeric not null default 1, cost_units numeric not null default 0,
  corrects text, actor_id text not null, actor_kind text not null, at timestamptz not null,
  primary key (tenant_id, project_id, id), unique (tenant_id, project_id, investigation_id, seq));
create table {s}.packages (
  tenant_id text not null, project_id text not null, investigation_id text not null, compartment text,
  version integer not null, digest text not null, change_seq bigint not null, content jsonb not null,
  markdown text not null, html text not null, sources text[] not null default '{}', finding_ids text[] not null default '{}',
  stale boolean not null default false, blocked boolean not null default false, stale_reasons jsonb not null default '[]',
  built_by text not null, built_at timestamptz not null,
  primary key (tenant_id, project_id, investigation_id, version));
create index packages_sources on {s}.packages using gin (sources);
create table {s}.upstream_changes (
  tenant_id text not null, project_id text not null, event_id text not null, kind text not null,
  refs text[] not null, affected text[] not null, applied_at timestamptz not null,
  primary key (tenant_id, project_id, event_id));
create function {s}.forbid_change() returns trigger language plpgsql as $$ begin raise exception 'append-only history cannot be changed'; end $$;
create trigger record_revisions_append_only before update or delete on {s}.record_revisions for each row execute function {s}.forbid_change();
create trigger attempts_append_only before update or delete on {s}.attempts for each row execute function {s}.forbid_change();
create function {s}.package_immutable() returns trigger language plpgsql as $$ begin
  if tg_op = 'DELETE' then raise exception 'package versions are retained'; end if;
  if new.content is distinct from old.content or new.digest is distinct from old.digest or new.markdown is distinct from old.markdown
     or new.html is distinct from old.html or new.version is distinct from old.version or new.built_at is distinct from old.built_at
  then raise exception 'package versions are immutable'; end if;
  return new; end $$;
create trigger packages_immutable before update or delete on {s}.packages for each row execute function {s}.package_immutable();
` }];

// ───────────────────────────── Validation helpers ─────────────────────────────
export const bad = (message: string): never => { throw new DomainError('invalid_input', message); };
export function obj(v: unknown, label: string): Record<string, unknown> {
  invariant(v !== null && typeof v === 'object' && !Array.isArray(v), 'invalid_input', `${label} must be an object`);
  return v as Record<string, unknown>;
}
export function text(v: unknown, label: string, max = 4000): string { nonempty(v, label, max); return v.trim(); }
export function optText(v: unknown, label: string, max = 4000): string | null { return v === undefined || v === null || v === '' ? null : text(v, label, max); }
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], label: string): T {
  invariant(typeof v === 'string' && (allowed as readonly string[]).includes(v), 'invalid_input', `${label} must be one of: ${allowed.join(', ')}`);
  return v as T;
}
export function refOf(v: unknown, label: string): string {
  invariant(typeof v === 'string' && v.length <= 300, 'invalid_input', `${label} must be a universal reference`);
  try { parseUref(v); } catch { bad(`${label} must be a universal reference`); }
  return v;
}
export function optRef(v: unknown, label: string): string | null { return v === undefined || v === null ? null : refOf(v, label); }
export function list(v: unknown, label: string, max = 200): unknown[] {
  if (v === undefined || v === null) return [];
  invariant(Array.isArray(v) && v.length <= max, 'invalid_input', `${label} must be a list of at most ${max} entries`);
  return v;
}
export function refList(v: unknown, label: string): string[] { return [...new Set(list(v, label).map((r) => refOf(r, label)))]; }
export function idList(v: unknown, label: string): string[] { return [...new Set(list(v, label).map((r) => text(r, label, 128)))]; }
export function jsonValue(v: unknown, label: string, maxBytes = 20_000): Json {
  let s: string | undefined;
  try { s = JSON.stringify(v); } catch { /* handled below */ }
  invariant(typeof s === 'string' && s.length <= maxBytes, 'invalid_input', `${label} must be JSON of at most ${maxBytes} bytes`);
  return JSON.parse(s) as Json;
}
export function num(v: unknown, label: string, min: number, max: number, fallback?: number): number {
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  invariant(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max, 'invalid_input', `${label} must be a number between ${min} and ${max}`);
  return v;
}

export type SourceLink = Readonly<{ ref: string; selector: Json | null; note: string | null }>;
/**
 * Evidence and processing references must pin a revision and carry an exact selector (page, time range, byte range,
 * quoted span …, or the explicit string "whole") when `exact` is requested.
 */
export function links(v: unknown, label: string, exact: boolean): SourceLink[] {
  return list(v, label).map((raw) => {
    const o = obj(raw, label);
    const ref = refOf(o.ref, `${label}.ref`);
    const selector = o.selector === undefined || o.selector === null ? null : jsonValue(o.selector, `${label}.selector`, 4000);
    const p = parseUref(ref);
    if (exact && (p.engine === 'E05' || p.engine === 'E06')) {
      invariant(p.revision !== undefined, 'invalid_input', `${label}: ${ref} must pin an exact revision`);
      invariant(selector !== null, 'invalid_input', `${label}: ${ref} needs an exact selector (or "whole")`);
    }
    return { ref, selector, note: optText(o.note, `${label}.note`, 2000) };
  });
}

/** Every foreign universal reference mentioned anywhere in a record's data: its upstream dependencies. */
export function collectRefs(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') { if (/^E\d\d:[a-z][a-z0-9_]*:[A-Za-z0-9._~-]+(@\d+)?$/.test(value) && !value.startsWith(`${EID}:`)) into.add(value); }
  else if (Array.isArray(value)) for (const v of value) collectRefs(v, into);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) collectRefs(v, into);
  return into;
}
function collectText(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const v of value) collectText(v, into);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) collectText(v, into);
  return into;
}

// ───────────────────────────── Revisioned records ─────────────────────────────
export type Kind = 'investigation' | 'question' | 'hypothesis' | 'lead' | 'plan_item' | 'finding' | 'contradiction' | 'unknown' | 'proposal' | 'step';
export const KINDS: readonly Kind[] = ['investigation', 'question', 'hypothesis', 'lead', 'plan_item', 'finding', 'contradiction', 'unknown', 'proposal', 'step'];
export type StaleReason = Readonly<{ effect: 'stale' | 'blocked'; kind: string; reason: string; cause: string; refs: readonly string[]; at: string; resolved?: boolean }>;
export type Rec<T = Record<string, unknown>> = Readonly<{
  ref: string; kind: Kind; id: string; investigationId: string; revision: number; state: string; data: T;
  sources: readonly string[]; stale: boolean; blocked: boolean; staleReasons: readonly StaleReason[];
  createdAt: string; createdBy: string; updatedAt: string; updatedBy: string;
}>;
const iso = (v: unknown): string => new Date(v as Date).toISOString();
function toRec<T>(r: Record<string, unknown>): Rec<T> {
  return { ref: uref(EID, r.kind as string, r.id as string, r.revision as number), kind: r.kind as Kind, id: r.id as string, investigationId: r.investigation_id as string, revision: r.revision as number, state: r.state as string, data: r.data as T, sources: r.sources as string[], stale: r.stale as boolean, blocked: r.blocked as boolean, staleReasons: r.stale_reasons as StaleReason[], createdAt: iso(r.created_at), createdBy: r.created_by as string, updatedAt: iso(r.updated_at), updatedBy: r.updated_by as string };
}
function titleOf(data: Record<string, unknown>): string {
  for (const k of ['title', 'text', 'statement', 'explanation', 'description', 'summary']) if (typeof data[k] === 'string') return (data[k] as string).slice(0, 300);
  return '';
}
export const scope = (ctx: ServiceContext): [string, string] => [ctx.tenantId, ctx.projectId];
export const notFound = (): never => { throw new DomainError('not_found', 'Not found'); };

export async function insertRec<T>(tx: Sql, ctx: ServiceContext, kind: Kind, investigationId: string, compartment: string | null, state: string, data: T, summary: string, id: string = randomUUID()): Promise<Rec<T>> {
  const sources = [...collectRefs(data)].sort();
  const d = data as Record<string, unknown>;
  const rows = await tx.query(`insert into ${S}.records (tenant_id, project_id, kind, id, investigation_id, compartment, revision, state, title, body, data, sources, created_at, created_by, updated_at, updated_by)
    values ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10::jsonb,$11,$12,$13,$12,$13) returning *`,
    [...scope(ctx), kind, id, investigationId, compartment, state, titleOf(d), collectText(d).join('\n').slice(0, 20_000), JSON.stringify(data), sources, ctx.now, ctx.actor.id]);
  await tx.query(`insert into ${S}.record_revisions (tenant_id, project_id, kind, id, revision, state, data, sources, actor_id, actor_kind, at, summary) values ($1,$2,$3,$4,1,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
    [...scope(ctx), kind, id, state, JSON.stringify(data), sources, ctx.actor.id, ctx.actor.kind, ctx.now, summary]);
  const rec = toRec<T>(rows[0] as Record<string, unknown>);
  await appendAudit(tx, S, ctx, `${kind}.created`, uref(EID, kind, id), { revision: 1, state, summary });
  return rec;
}
/** Loads a record in the caller's scope and compartments; anything else is indistinguishable from missing. */
export async function loadRec<T>(q: Sql, ctx: ServiceContext, kind: Kind, id: string, forUpdate = false): Promise<Rec<T>> {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) notFound();
  const rows = await q.query(`select * from ${S}.records where tenant_id=$1 and project_id=$2 and kind=$3 and id=$4${forUpdate ? ' for update' : ''}`, [...scope(ctx), kind, id]);
  const row = rows[0];
  if (row === undefined) return notFound();
  requireCompartment(ctx, row.compartment as string | null);
  return toRec<T>(row);
}
/** Writes a new revision. Earlier revisions stay in record_revisions; stale/blocked flags are recomputed against the new sources. */
export async function updateRec<T>(tx: Sql, ctx: ServiceContext, prior: Rec<T>, change: { state?: string; data?: T; clearStale?: boolean; expectedRevision?: unknown }, summary: string): Promise<Rec<T>> {
  if (change.expectedRevision !== undefined && change.expectedRevision !== null && change.expectedRevision !== prior.revision) throw new DomainError('revision_conflict', `Expected revision ${String(change.expectedRevision)} but current is ${prior.revision}`);
  const data = change.data ?? prior.data, state = change.state ?? prior.state, revision = prior.revision + 1;
  const sources = [...collectRefs(data)].sort();
  const d = data as Record<string, unknown>;
  let reasons = [...prior.staleReasons];
  if (change.clearStale === true) reasons = reasons.map((r) => r.effect === 'stale' ? { ...r, resolved: true } : r);
  const blocked = reasons.some((r) => r.effect === 'blocked' && r.refs.some((x) => sources.some((s) => urefMatches(x, s))));
  const stale = reasons.some((r) => r.effect === 'stale' && r.resolved !== true);
  const rows = await tx.query(`update ${S}.records set revision=$5, state=$6, title=$7, body=$8, data=$9::jsonb, sources=$10, stale=$11, blocked=$12, stale_reasons=$13::jsonb, updated_at=$14, updated_by=$15
    where tenant_id=$1 and project_id=$2 and kind=$3 and id=$4 and revision=$16 returning *`,
    [...scope(ctx), prior.kind, prior.id, revision, state, titleOf(d), collectText(d).join('\n').slice(0, 20_000), JSON.stringify(data), sources, stale, blocked, JSON.stringify(reasons), ctx.now, ctx.actor.id, prior.revision]);
  if (rows[0] === undefined) throw new DomainError('revision_conflict', 'Record changed concurrently');
  await tx.query(`insert into ${S}.record_revisions (tenant_id, project_id, kind, id, revision, state, data, sources, actor_id, actor_kind, at, summary) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
    [...scope(ctx), prior.kind, prior.id, revision, state, JSON.stringify(data), sources, ctx.actor.id, ctx.actor.kind, ctx.now, summary]);
  await appendAudit(tx, S, ctx, `${prior.kind}.revised`, uref(EID, prior.kind, prior.id), { revision, state, summary });
  return toRec<T>(rows[0]);
}
export async function listRecs<T>(q: Sql, ctx: ServiceContext, kind: Kind, investigationId: string): Promise<Rec<T>[]> {
  const rows = await q.query(`select * from ${S}.records where tenant_id=$1 and project_id=$2 and investigation_id=$3 and kind=$4 order by seq`, [...scope(ctx), investigationId, kind]);
  return rows.map((r) => toRec<T>(r));
}
/** Adds a stale/blocked flag without creating a revision: the content is untouched, only its standing changes. */
export async function flagRec(tx: Sql, ctx: ServiceContext, rec: Rec<unknown>, reason: StaleReason): Promise<void> {
  await tx.query(`update ${S}.records set stale = stale or $5, blocked = blocked or $6, stale_reasons = stale_reasons || $7::jsonb, updated_at=$8 where tenant_id=$1 and project_id=$2 and kind=$3 and id=$4`,
    [...scope(ctx), rec.kind, rec.id, reason.effect === 'stale', reason.effect === 'blocked', JSON.stringify([reason]), ctx.now]);
  await appendAudit(tx, S, ctx, `${rec.kind}.${reason.effect}`, uref(EID, rec.kind, rec.id), { reason: reason.reason, cause: reason.cause, refs: [...reason.refs] });
}
export async function bump(tx: Sql, ctx: ServiceContext, investigationId: string): Promise<void> {
  await tx.query(`update ${S}.counters set change_seq = change_seq + 1 where tenant_id=$1 and project_id=$2 and investigation_id=$3`, [...scope(ctx), investigationId]);
}

// ───────────────────────────── Attempts log (append-only) ─────────────────────────────
export const ATTEMPT_KINDS = ['search', 'acquisition', 'contact', 'processing', 'knowledge', 'verification', 'other'] as const;
export const OUTCOMES = ['succeeded', 'partial', 'zero_result', 'failed', 'refused', 'access_restricted', 'unavailable', 'uncertain', 'cancelled'] as const;
/** Outcomes that mean the thing sought was not obtained. */
export const NOT_OBTAINED: readonly string[] = ['zero_result', 'failed', 'refused', 'access_restricted', 'unavailable', 'uncertain'];
export type AttemptKind = typeof ATTEMPT_KINDS[number];
export type Outcome = typeof OUTCOMES[number];
export type Attempt = Readonly<{
  ref: string; id: string; investigationId: string; seq: number; kind: AttemptKind; target: string; method: string; outcome: Outcome; detail: string;
  lane: string | null; questionId: string | null; hypothesisId: string | null; leadId: string | null; planItemId: string | null; stepId: string | null; findingId: string | null;
  refs: readonly string[]; effort: Readonly<{ timeMinutes: number; attempts: number; costUnits: number }>; corrects: string | null; actorId: string; actorKind: string; at: string;
}>;
export type AttemptInput = {
  kind: AttemptKind; target: string; method: string; outcome: Outcome; detail?: string | null; lane?: string | null;
  questionId?: string | null; hypothesisId?: string | null; leadId?: string | null; planItemId?: string | null; stepId?: string | null; findingId?: string | null;
  refs?: readonly string[]; effort?: { timeMinutes?: number; attempts?: number; costUnits?: number }; corrects?: string | null;
};
export function toAttempt(r: Record<string, unknown>): Attempt {
  return { ref: uref(EID, 'attempt', r.id as string), id: r.id as string, investigationId: r.investigation_id as string, seq: r.seq as number, kind: r.kind as AttemptKind, target: r.target as string, method: r.method as string, outcome: r.outcome as Outcome, detail: r.detail as string,
    lane: r.lane as string | null, questionId: r.question_id as string | null, hypothesisId: r.hypothesis_id as string | null, leadId: r.lead_id as string | null, planItemId: r.plan_item_id as string | null, stepId: r.step_id as string | null, findingId: r.finding_id as string | null,
    refs: r.refs as string[], effort: { timeMinutes: Number(r.time_minutes), attempts: Number(r.attempt_units), costUnits: Number(r.cost_units) }, corrects: r.corrects as string | null, actorId: r.actor_id as string, actorKind: r.actor_kind as string, at: iso(r.at) };
}
export async function insertAttempt(tx: Sql, ctx: ServiceContext, investigationId: string, compartment: string | null, a: AttemptInput & { lane: string | null }): Promise<Attempt> {
  const seq = ((await tx.query<{ attempt_seq: number }>(`update ${S}.counters set attempt_seq = attempt_seq + 1, change_seq = change_seq + 1 where tenant_id=$1 and project_id=$2 and investigation_id=$3 returning attempt_seq`, [...scope(ctx), investigationId]))[0] as { attempt_seq: number }).attempt_seq;
  const id = randomUUID();
  const rows = await tx.query(`insert into ${S}.attempts (tenant_id, project_id, investigation_id, compartment, id, seq, kind, target, method, outcome, detail, lane, question_id, hypothesis_id, lead_id, plan_item_id, step_id, finding_id, refs, time_minutes, attempt_units, cost_units, corrects, actor_id, actor_kind, at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) returning *`,
    [...scope(ctx), investigationId, compartment, id, seq, a.kind, a.target.slice(0, 2000), a.method.slice(0, 500), a.outcome, (a.detail ?? '').slice(0, 4000), a.lane, a.questionId ?? null, a.hypothesisId ?? null, a.leadId ?? null, a.planItemId ?? null, a.stepId ?? null, a.findingId ?? null,
      [...(a.refs ?? [])], a.effort?.timeMinutes ?? 0, a.effort?.attempts ?? 1, a.effort?.costUnits ?? 0, a.corrects ?? null, ctx.actor.id, ctx.actor.kind, ctx.now]);
  await appendAudit(tx, S, ctx, 'attempt.recorded', uref(EID, 'attempt', id), { seq, kind: a.kind, method: a.method.slice(0, 500), outcome: a.outcome });
  return toAttempt(rows[0] as Record<string, unknown>);
}
export async function listAttemptRows(q: Sql, ctx: ServiceContext, investigationId: string): Promise<Attempt[]> {
  return (await q.query(`select * from ${S}.attempts where tenant_id=$1 and project_id=$2 and investigation_id=$3 order by seq`, [...scope(ctx), investigationId])).map(toAttempt);
}
