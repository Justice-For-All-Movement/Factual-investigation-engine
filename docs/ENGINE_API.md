# Factual investigation engine (E08) — service layer API

Entry: `src/engine/index.ts` (package export `./engine`). Server: `src/engine/serve.ts` (`npm run serve`, export `./serve`).
Schema `e08_investigation`, capability prefix `investigation`, manifest id `E08`.
Kit: `src/service-kit.ts` version 1.0.1, sha256 `95475a907267ba1fdd54b557aabe5645c37add9788a5b2d0854d9accfd5d8ea5`
(byte-identical copy of the Identity engine's kit); `src/contracts.ts` sha256
`d86141cb7546a723f837a298e4ea6fef62692918f78f5aab2d72d6639987fcc5`.

```ts
import { SCHEMA, manifest, migrations, migrate, createEngine, routes, ACTIONS, STEP_JOB } from '@accountability/factual-investigation/engine';
const engine = createEngine({ sql, objects?, ports?: InvestigationPorts, config?: EngineConfig });
```

The service layer imports no other engine's package. Other engines are reached through `deps.ports` and named by uref only.
The earlier library modules (`src/index.ts`, `efforts.ts`, `repository.ts`, `identity-repository.ts`, `knowledge-review.ts`)
remain exported and tested; they depend on pinned packages of other engines and are **not** used by the service layer.
Their concepts (materiality rationale, stop condition, contrary test, effort outcomes) are carried into the service model.

## Configuration

`EngineConfig`: `requireDistinctReviewer` (default `true`; when true no investigation can let an author review their own
finding), `autoAcceptCeiling` (default 25; upper bound for policy auto-acceptance per investigation and type),
`stepCosts` (`{ [action]: { category, amount, unit } }`; a costed action is refused unless `BudgetPort` reserves it),
`leaseMs`, `maxLeadsPerStep` (default 25).

Serve env: `DATABASE_URL` (required), `PORT` (8108), `HOST` (127.0.0.1), `IDENTITY_PUBLIC_KEYS` (JSON kid→PEM) or
`IDENTITY_JWKS_FILE` (required: the server refuses to start without token verification), `IDENTITY_ISSUER`,
`OBJECT_STORE*` (optional copy of packages), `INVESTIGATION_REQUIRE_DISTINCT_REVIEWER`, `INVESTIGATION_WORKER_INTERVAL_MS`.
The standalone server configures **no** collaborator ports: port-backed steps record the outcome `unavailable`.

## Capabilities

| Capability | Grants |
|---|---|
| `investigation:read` | every read, `inspect`, `search`, `audit`, package retrieval, job status |
| `investigation:write` | open/update investigations, questions, explanations, leads, plan items, attempts, findings (draft, submit, withdraw), registers, `completeStep`, `requestReview`, `buildPackage`, `reopen`, `decideProposal` (human only), `applyUpstreamChange` |
| `investigation:plan` | `planNextSteps`, `proposeQuestions`, `proposeSteps` |
| `investigation:execute` | `executeStep`, `controlJob`; re-checked inside the worker |
| `investigation:contact` (sensitive) | additionally required to execute any `correspondence.*` step |
| `investigation:approve` (sensitive) | `reviewFinding`, `close` (both human actors only) |
| `investigation:events` (sensitive) | `events` outbox feed |

Sensitive actions are never granted by `investigation:*`.

## Records

All domain objects except attempts and packages are revisioned records `Rec<T>`:
`{ ref, kind, id, investigationId, revision, state, data: T, sources, stale, blocked, staleReasons, createdAt, createdBy, updatedAt, updatedBy }`.
Every change writes a new row in `record_revisions` (append-only, enforced by trigger) and an audit entry.
`sources` is every foreign uref found anywhere in `data`.

| kind | states | notes |
|---|---|---|
| `investigation` | `open`, `review_ready`, `closed` | `originRef`, `scopeStatement`, `originalAccount {ref, summary, label}` (fixed at opening, label `allegation` or `attributed_testimony` only), `lanes[{id,name,targetShare,attemptKinds}]` (shares sum to 1; default documentary 0.5 / outreach 0.5), `policy`, `closures[]`, `reopenings[]`, optional `compartment` |
| `question` | `open`, `in_progress`, `answered`, `unresolvable`, `out_of_scope` | `parentId`, `material` (explicit), `whyMaterial` (required when material), `stopCondition`, `claimRefs` (E07), `answer`, `answerLabel`, `findingIds`, `rationale` |
| `hypothesis` | `open`, `supported`, `contradicted`, `refuted`, `inconclusive`, `withdrawn` | `questionId`, `explanation`, `predictedObservations[{id,text,observed,note}]`, `contraryTest`, `supporting[]`, `contradicting[]`, `statusRationale` (required unless open) |
| `lead` | `new`, `assessing`, `active`, `exhausted`, `dismissed`, `converted` | `kind` documentary/person/dataset, `origin {type, ref}`, `priority` 1–5, `assessment` (required when exhausted/dismissed), `questionIds`, `lane`, `linkedRefs` (discovery items, runs, contact leads) |
| `plan_item` | `planned`, `running`, `done`, `failed`, `cancelled`, `skipped` | `kind` documentary_research/interview/correspondence/processing/knowledge/verification, `questionId` (required), `hypothesisId`, `leadId`, `lane`, optional executable `action` + `params` |
| `finding` | `draft`, `in_review`, `returned`, `approved`, `withdrawn` | see Findings |
| `contradiction` | `open`, `explained`, `unresolved` | `description`, `accountExcerpt`, `accountRef`, `contradicting[]` (≥1, exact), `questionId`, `findingId`, `resolutionNote` |
| `unknown` | `open`, `resolved` | `description`, `whyUnknown`, `whatWouldResolve`, `questionId`, `attemptIds` |
| `proposal` | `proposed`, `accepted`, `rejected` | `type` question/step, `item`, `rationale`, `proposedBy`, `source`, `decision` |
| `step` | `pending`, `queued`, `running`, `waiting`, `done`, `failed`, `blocked`, `uncertain`, `cancelled`, `resolved` | derived by the planner; stable id |

Source links are `{ ref, selector, note }`. In findings and contradictions an E05/E06 ref must pin a revision and carry a
selector (any JSON locator, or `"whole"`).

Attempts (`Attempt`, table `attempts`, append-only by trigger): `{ id, seq, kind, target, method, outcome, detail, lane,
questionId, hypothesisId, leadId, planItemId, stepId, findingId, refs, effort {timeMinutes, attempts, costUnits}, corrects, actorId, at }`.
`kind`: search, acquisition, contact, processing, knowledge, verification, other. `outcome`: succeeded, partial, zero_result,
failed, refused, access_restricted, unavailable, uncertain, cancelled. "Not obtained" = zero_result, failed, refused,
access_restricted, unavailable, uncertain; such an entry requires a `detail`. A correction is a new entry with `corrects`.

## Service methods

All take `ctx: ServiceContext` first. Mutating methods accept `idempotencyKey` in their input (HTTP: body field or
`Idempotency-Key` header) and run in one transaction with audit and events. Unknown, foreign-tenant, foreign-project and
compartment-hidden objects answer `not_found`.

```ts
openInvestigation(ctx, { title, originRef, scopeStatement, originalAccount: { ref?, summary, label? }, lanes?, policy?, urgency?, contactConstraints?, compartment?, idempotencyKey? }): Promise<Rec<InvestigationData>>
getInvestigation(ctx, id): Promise<Rec<InvestigationData>>
listInvestigations(ctx, { state?, originRef?, limit? }?): Promise<Rec<InvestigationData>[]>
updateInvestigation(ctx, id, { title?, scopeStatement?, lanes?, policy?, urgency?, contactConstraints?, expectedRevision? }): Promise<Rec<InvestigationData>>
getOverview(ctx, id): Promise<InvestigationOverview>   // all records, attempts, closure check, effort report, packages
get<T>(ctx, kind, id): Promise<Rec<T>>
list<T>(ctx, investigationId, kind): Promise<Rec<T>[]>
revisions(ctx, kind, id): Promise<{ revision, state, data, actorId, at, summary }[]>

addQuestion(ctx, investigationId, { text, material, whyMaterial?, parentId?, stopCondition?, claimRefs? }): Promise<Rec<QuestionData>>
updateQuestion(ctx, questionId, { text?, material?, whyMaterial?, stopCondition?, claimRefs?, materialityRationale?, expectedRevision? }): Promise<Rec<QuestionData>>
disposeQuestion(ctx, questionId, { status, answer?, answerLabel?, findingIds?, rationale?, whatWouldResolve? }): Promise<Rec<QuestionData>>
addHypothesis(ctx, questionId, { explanation, predictedObservations?, contraryTest?, supporting?, contradicting? }): Promise<Rec<HypothesisData>>
updateHypothesis(ctx, hypothesisId, { explanation?, predictedObservations?, contraryTest?, supporting?, contradicting?, status?, statusRationale?, expectedRevision? }): Promise<Rec<HypothesisData>>
addLead(ctx, investigationId, { kind, description, origin?, priority?, questionIds?, lane?, linkedRefs? }): Promise<Rec<LeadData>>
updateLead(ctx, leadId, { description?, priority?, status?, assessment?, questionIds?, lane?, linkedRefs?, expectedRevision? }): Promise<Rec<LeadData>>
addPlanItem(ctx, investigationId, { kind, questionId, description, hypothesisId?, leadId?, lane?, action?, params? }): Promise<Rec<PlanItemData>>
updatePlanItem(ctx, planItemId, { description?, status?, statusNote?, lane?, action?, params?, expectedRevision? }): Promise<Rec<PlanItemData>>

recordAttempt(ctx, investigationId, AttemptInput): Promise<Attempt>
listAttempts(ctx, investigationId, { notObtained?, outcome?, questionId? }?): Promise<Attempt[]>
effortReport(ctx, investigationId): Promise<EffortReport>

createFinding(ctx, investigationId, { statement, label, classification, questionIds, supporting?, contradicting?, limitations?, confidence: { level, basis }, checklist? }): Promise<Rec<FindingData>>
reviseFinding(ctx, findingId, patch & { expectedRevision? }): Promise<Rec<FindingData>>      // always returns to draft
submitFinding(ctx, findingId): Promise<Rec<FindingData>>
reviewFinding(ctx, findingId, { decision: 'approve' | 'return', notes? }): Promise<Rec<FindingData>>
withdrawFinding(ctx, findingId, { rationale }): Promise<Rec<FindingData>>

addContradiction(ctx, investigationId, { description, contradicting, accountExcerpt?, accountRef?, questionId?, findingId? }): Promise<Rec<ContradictionData>>
updateContradiction(ctx, contradictionId, { description?, contradicting?, status?, resolutionNote?, findingId?, expectedRevision? }): Promise<Rec<ContradictionData>>
addUnknown(ctx, investigationId, { description, whyUnknown, whatWouldResolve?, questionId?, attemptIds? }): Promise<Rec<UnknownData>>
updateUnknown(ctx, unknownId, { description?, whyUnknown?, whatWouldResolve?, status?, resolutionNote?, attemptIds?, expectedRevision? }): Promise<Rec<UnknownData>>

proposeQuestions(ctx, investigationId, { items, rationale, source? }): Promise<Rec<ProposalData>[]>
proposeSteps(ctx, investigationId, { items, rationale, source? }): Promise<Rec<ProposalData>[]>
decideProposal(ctx, proposalId, { decision: 'accept' | 'reject', rationale? }): Promise<Rec<ProposalData>>

planNextSteps(ctx, investigationId): Promise<{ investigationId, steps, waiting, retryable, inFlight, notes }>
executeStep(ctx, stepId, { idempotencyKey? }?): Promise<{ step: Rec<StepData>; jobId: string }>
completeStep(ctx, stepId, { outcome, detail, refs?, effort? }): Promise<{ step: Rec<StepData>; attempt: Attempt }>
getJob(ctx, jobId): Promise<{ id, kind, state, attempts, result, lastError, stepId }>
controlJob(ctx, jobId, 'pause' | 'resume' | 'cancel' | 'retry'): Promise<{ id, state, stepId }>
runJobs({ worker, limit?, leaseMs? }): Promise<number>      // one worker pass; no ctx (uses each job's stored context)

closureCheck(ctx, investigationId): Promise<ClosureCheck>     // { ready, blockers[{code,ref,message}], warnings[] }
requestReview(ctx, investigationId): Promise<{ investigation, closure }>
close(ctx, investigationId, { rationale, packageVersion, reopeningTriggers? }): Promise<Rec<InvestigationData>>
reopen(ctx, investigationId, { reason, newInformationRefs? }): Promise<Rec<InvestigationData>>

buildPackage(ctx, investigationId, { idempotencyKey? }?): Promise<InvestigationPackage>
getPackage(ctx, investigationId, version?): Promise<InvestigationPackage>    // latest when omitted
listPackages(ctx, investigationId): Promise<PackageSummary[]>

inspect(ctx, ref) · search(ctx, { q, limit? }) · audit(ctx, opts?) · events(ctx, opts?) · applyUpstreamChange(ctx, change) · health()
```

### Findings

`label`: allegation, attributed_testimony, verified_fact, inference, unknown. `classification`: established, disputed,
unknown, refuted. `confidence.level` is a word (well_supported, probable, possible, uncertain) with a `basis`; numbers are
rejected. Checklist items (`primary_source_checked`, `independence_by_source_family`, `counter_evidence_searched`,
`alternative_explanations_addressed`, `subject_response_sought`, `dates_identities_confirmed`) are each
`{ status: done | not_done | not_applicable, note }`; `not_done` and `not_applicable` need a note.

Submission is refused (with every defect listed) unless: all checklist items are recorded, at least one limitation is
stated, the finding names its question(s); `established` needs a supporting source and primary-source and counter-evidence
checks done; `refuted` needs a contradicting source and the same checks; `disputed` cites both sides; `verified_fact`
requires `established`. Review is by a human with `investigation:approve`; when the reviewer rule applies the reviewer
may not be any author of the finding or its submitter. Revising an approved finding creates a new draft revision.
The engine does not itself decide independence of sources: `knowledge.get_source_families` reports families and the
checklist item records the human conclusion.

### Closure

`close` is refused (`invalid_state`, naming each blocker) while: a material question is `open`/`in_progress`; an `answered`
material question lacks an answer or rests on a finding that is not currently approved; an `unresolvable` question lacks a
rationale or an unknowns-register entry (created automatically by `disposeQuestion`); an `out_of_scope` question lacks a
rationale; any finding is draft, in review, returned, stale or blocked; a contradiction is unassessed; a step is in
flight or `uncertain`. Demoting a material question needs `materialityRationale`. Open leads, unexecuted plan items,
undecided proposals and open non-material questions are warnings; they appear in the package under `notPursued`/`closure`.
`close` also requires a named package version built from the current state (no change since, not stale, not blocked,
`closure.ready`), a human actor and a rationale. `reopen` needs a reason; closures, reopenings and all package versions are retained.

### Planner and execution

`planNextSteps` is deterministic for a given state and port answers. It derives, in priority order: renewed review of
stale findings; revision of blocked or returned findings; review of submitted findings; for each open question
(material first): formulate explanations, add a competing explanation when only one exists, design a test for each
explanation with no plan item, attempt or evidence, a first `discovery.search_source` when nothing was planned or tried,
and a disposition prompt once planned work is finished; each `planned` plan item (its `action`, or
`manual.perform_plan_item`); knowledge gaps from `KnowledgePort.getGaps` mapped by `kind`
(`no_subject_response`/`response_missing`/`needs_response` → `correspondence.create_contact_plan`; `unprocessed` →
`processing.request`; `missing_source`/`unsupported`/`single_source_family`/`independence`/`no_primary_source`/`missing_date`
→ `discovery.search_source`; anything else → `manual.resolve_gap`); lead assessment and contact planning; follow-ups
(`discovery.get_coverage` after a collection run, `processing.get_text` after a processing request,
`correspondence.get_thread_state` after an inquiry draft); verification of draft findings. Steps are stored with ids
derived from their content; a pending step whose condition no longer holds becomes `resolved`. The gap query is logged
as an attempt when it fails or its answer changes, not on every pass.

Executable actions (`ACTIONS`): `discovery.search_source {query, sourceId?, limit?}`, `discovery.start_collection {query, objective?, sourceIds?}`,
`discovery.get_coverage {runRef}`, `evidence.describe {ref}`, `processing.request {evidenceRef, operations}`,
`processing.get_text {evidenceRef}`, `processing.search {query, evidenceRefs?, limit?}`, `knowledge.propose_claim {statement, label?, sources}`,
`knowledge.create_link {from, to, relation}`, `knowledge.get_source_families {refs}`, `knowledge.get_impact {ref}`,
`knowledge.get_graph {claimRefs}`, `correspondence.create_contact_plan {question?, contactLeadRef?, purpose?}`,
`correspondence.draft_inquiry {questions?, contactPlanRef?, contactLeadRef?}`, `correspondence.get_thread_state {threadRef}`.

`executeStep` enqueues kit job `investigation.step`. The worker re-checks capabilities (and `AuthorizationPort` when
supplied), reserves budget for costed actions, confirms the job is still leased immediately before the port call, calls
the port with idempotency key `E08:step:<stepId>`, then in one transaction records the attempt (plus one attempt per
source a coverage report or search says was restricted, failed or empty), creates leads from returned items and contact
leads, links a proposed claim to its question, updates the plan item and the step, and emits `investigation.step_completed`.
A missing port yields outcome `unavailable` naming the port. A domain error maps to refused / access_restricted /
unavailable / failed. A side-effecting call that ends without a definite answer is recorded `uncertain` (never assumed
failed) and is reconciled by executing the step again with the same idempotency key. Messages of non-domain port errors
are not stored. Nothing in this engine sends correspondence: contact plans and inquiry drafts are created in E03 under E03's own rules.

Proposals: suggestions from agents or models are validated and stored; accepting one creates the question or plan item.
Acceptance is by a human, or by investigation policy at proposal time: `policy.autoAccept.questions {enabled, max, allowMaterial}`
(material questions only when `allowMaterial`) and `policy.autoAccept.steps {enabled, max, actions}` (listed actions only),
each capped by `autoAcceptCeiling`.

### Package

`content` (`schema: investigation-package/v1`): `version`, `builtAt`, `builtBy`, `previousVersion {version, digest}`,
`investigation`, `scope`, `originalAccount` (labelled, with the note that inclusion does not assert truth), `questionTree`
(depth, status, disposition), `findings` (approved, not blocked; statement, label, classification, confidence, supporting
and contradicting sources with selectors, limitations, checklist, reviews, stale flag), `findingsNotIncluded` (state and
reason; blocked findings are withheld), `explanations` (each hypothesis with status and `howItFared`), `contradictions`,
`unknowns`, `attempts {total, byOutcome, byKind, notObtained[], log[]}`, `chronology {available, reason, entries[{at, description, claimRef, label, basis}]}`
(label established/disputed/unknown from this investigation's approved findings citing the claim, else the status the
knowledge engine reported, else unknown), `evidenceIndex` (every cited E05 ref: sha256, size, media type, filename, origin,
custody summary, `verified`, `citedBy`), `effortByLane`, `notPursued`, `limitations`, `closure`, `digest` (sha256 of the
canonical content without the digest field). Markdown and HTML renderings are stored with it (HTML is escaped, script-free,
served with a restrictive CSP). Versions are immutable (trigger-enforced); a later build is a new version. A build fails
with `conflict` if the investigation changed while ports were being consulted. With `deps.objects`, copies are written to
`<tenant>/<project>/investigation/<id>/package-v<n>.{json,md,html}`. A blocked package is listed but its content is withheld.

## HTTP routes

Standard: `GET /healthz`, `GET /v1/manifest`, `GET /v1/inspect?ref=`, `GET /v1/search?q=`, `GET /v1/audit`, `GET /v1/events`, `POST /v1/upstream-changes`.

| Route | Method |
|---|---|
| `POST /v1/investigations` · `GET /v1/investigations` · `GET|PATCH /v1/investigations/:id` · `GET /v1/investigations/:id/overview` | open / list / get / update / overview |
| `GET /v1/investigations/:id/records/:kind` · `GET /v1/records/:kind/:id` · `GET /v1/records/:kind/:id/revisions` | list / get / revisions |
| `POST /v1/investigations/:id/questions` · `PATCH /v1/questions/:id` · `POST /v1/questions/:id/disposition` · `POST /v1/questions/:id/answers` | question tree |
| `POST /v1/questions/:id/hypotheses` · `PATCH /v1/hypotheses/:id` | explanations |
| `POST /v1/investigations/:id/leads` · `PATCH /v1/leads/:id` · `POST /v1/investigations/:id/plan-items` · `PATCH /v1/plan-items/:id` | leads, plan |
| `POST|GET /v1/investigations/:id/attempts` (`?notObtained=true&outcome=&questionId=`) · `GET /v1/investigations/:id/effort` | attempts, effort |
| `POST /v1/investigations/:id/findings` · `PATCH /v1/findings/:id` · `POST /v1/findings/:id/submit|review|withdraw` | findings |
| `POST /v1/investigations/:id/contradictions` · `PATCH /v1/contradictions/:id` · `POST /v1/investigations/:id/unknowns` · `PATCH /v1/unknowns/:id` | registers |
| `POST /v1/investigations/:id/proposals/questions|steps` · `POST /v1/proposals/:id/decision` | proposals |
| `POST /v1/investigations/:id/plan` · `POST /v1/steps/:id/execute` (202) · `POST /v1/steps/:id/complete` · `GET /v1/jobs/:id` · `POST /v1/jobs/:id/:action` | planning, execution |
| `GET /v1/investigations/:id/closure-check` · `POST /v1/investigations/:id/review|close|reopen` | closure |
| `POST|GET /v1/investigations/:id/packages` · `GET /v1/investigations/:id/packages/:version` (`latest` allowed; `?format=markdown|html`) | packages |

## Events (outbox; subject → payload)

| Type | Subject |
|---|---|
| `investigation.opened`, `investigation.review_ready`, `investigation.closed`, `investigation.reopened` | `E08:investigation:<id>` |
| `investigation.question_opened` (also when a disposed question is re-opened), `investigation.outreach_required` (interview/correspondence plan item added) | `E08:question:<id>` |
| `investigation.lead_exhausted` | `E08:lead:<id>` |
| `investigation.finding_proposed`, `investigation.finding_approved`, `investigation.finding_returned`, `investigation.finding_stale`, `investigation.finding_blocked` | `E08:finding:<id>@<rev>` |
| `investigation.step_completed` | `E08:step:<id>` |
| `investigation.package_built`, `investigation.package_stale`, `investigation.package_blocked` | `E08:investigation_package:<investigationId>@<version>` |

`applyUpstreamChange({ eventId, kind, refs, reason })` (capability `investigation:write`, idempotent by `eventId` per
tenant and project): every non-withdrawn finding whose sources match a ref (revision-aware `urefMatches`) and every
package citing a ref or containing such a finding is flagged. `permission_withdrawn` and `source_removed` → **blocked**;
all other kinds → **stale**. Nothing is rewritten: content, revision and package digest are unchanged; an approved
finding stays `approved` with `stale: true` until `reviewFinding` renews or returns it; revising a blocked finding so it
no longer cites the withdrawn ref lifts the block. Events carry `{ reason, cause, kind, refs, investigationId }`.
Returns the affected urefs. Hypotheses, contradictions and questions citing the ref are not flagged.

## Ports (`src/engine/ports.ts`)

`DiscoveryPort` (E04): `startCollectionRun`, `searchSource`, `getCoverage`. `EvidenceDescribePort` (E05): kit `describe`
plus optional `describeProvenance(ctx, ref) → { origin, custodySummary, custodyEvents? }` (engine-defined: the kit
`EvidenceVersionInfo` has no origin or custody fields; `describe` may alternatively return `origin`/`custodySummary`).
`ProcessingPort` (E06): `requestProcessing`, `getText`, `search`. `KnowledgePort` (E07): `proposeClaim`, `createLink`,
`getSourceFamilies`, `getGaps`, `getChronology`, `getGraph`, `getImpact`. `CorrespondencePort` (E03): `createContactPlan`,
`draftInquiry`, `getThreadState`. Kit `BudgetPort`, `AuthorizationPort`. All ports are optional; absence is reported, not hidden.

## Status

Implemented and tested locally on real PostgreSQL 16 (`tests/engine.test.ts`, 8 tests): full lifecycle; closure refused
while a material question is open; attempts log with failures, zero results, restricted sources and refusals; package
contents and renderings; reopening with retained package versions; stale and blocked propagation; reviewer ≠ author;
lane effort accounting; job resume after a simulated worker crash; uncertain side-effect reconciliation; pause and cancel;
authorization re-check, budget reservation and denial; proposals and bounded auto-accept; tenant, project and compartment
isolation; fail-closed authorization; idempotent replay; append-only triggers; HTTP end to end.

Not implemented or not verified:
- No integration test against the real E03/E04/E05/E06/E07/E13 engines: the ports in tests are in-memory test doubles
  (`tests/engine-support.ts`). Port adapters to the real engines are the integrator's.
- `npm run serve` has no port wiring (standalone mode); it was started manually but has no automated test.
- No hosted deployment check; no independent security review.
- Catalog items "referral recommendations" and an "interview schedule" view are not modelled beyond interview plan items.
  No visual views (question tree, hypothesis matrix …) are rendered; `getOverview` supplies their data.
- `search` is substring matching (`ILIKE`) over record text; no ranking or language analysis.
- Compartments are per investigation (children inherit); there is no per-record compartment.
- A package whose build was interrupted after the database commit but before the object-store copy has no object copy.
- Budget reservations of `uncertain` steps are committed (cost assumed incurred), not reconciled.
