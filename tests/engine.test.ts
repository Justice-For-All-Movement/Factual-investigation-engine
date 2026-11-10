import test from 'node:test';
import assert from 'node:assert/strict';
import * as kit from '../src/service-kit.ts';
import { SCHEMA, STEP_JOB, manifest, routes } from '../src/engine/index.ts';
import type { FindingData, LeadData, QuestionData, StepData } from '../src/engine/index.ts';
import { ALL, CHECKLIST_DONE, EV1, EV2, EV3, approvedFinding, code, ctx, eventsOf, needsPg, openBasic, withEngine } from './engine-support.ts';

const step = (steps: readonly { data: StepData; id: string }[], action: string, pred: (s: StepData) => boolean = () => true) => { const s = steps.find((x) => x.data.action === action && pred(x.data)); assert.ok(s, `expected a ${action} step`); return s; };

test('engine: full lifecycle from report to closure, package and reopening', needsPg, async () => {
  await withEngine(async ({ engine, ports }) => {
    ports.discovery.sources.set('municipal-gazette', { restricted: false, failing: false, docs: [{ keyword: 'tender', ref: 'E04:item:gazette-12', title: 'Gazette issue 12: procurement notices', evidenceRef: EV2 }] });
    ports.discovery.sources.set('land-registry', { restricted: true, failing: false, docs: [] });
    ports.discovery.contacts.push({ ref: 'E04:contact_lead:cl-1', label: 'Former procurement officer', role: 'witness' });
    ports.evidence.versions.set(EV1, { sha256: 'a'.repeat(64), filename: 'ledger.pdf', origin: { source: 'municipal archive' }, custody: 'Received 2026-01-04; hash verified twice' });
    ports.evidence.versions.set(EV2, { sha256: 'b'.repeat(64), filename: 'minutes.pdf', origin: { source: 'gazette' }, custody: 'Captured 2026-01-05' });
    ports.knowledge.chronology = [{ at: '2019-03-12', description: 'Contract signed', claimRef: 'E07:claim:claim-a@1' }, { at: '2019-02-01', description: 'Tender allegedly published', claimRef: 'E07:claim:claim-z@1', status: 'disputed' }];
    ports.knowledge.gaps = [{ id: 'gap-1', kind: 'no_subject_response', description: 'The contractor has not been asked for a response', claimRef: 'E07:claim:claim-a@1' }];

    const inv = await openBasic(engine);
    assert.equal(inv.state, 'open'); assert.equal(inv.data.originalAccount.label, 'allegation'); assert.equal(inv.data.lanes.length, 2);
    await assert.rejects(openBasic(engine, ctx(), { originalAccount: { summary: 'x', label: 'verified_fact' } }), code('invalid_input'));
    await assert.rejects(engine.updateInvestigation(ctx(), inv.id, { originalAccount: { summary: 'rewritten' } } as never), code('invalid_input'));

    const q1 = await engine.addQuestion(ctx(), inv.id, { text: 'Was a tender published before the contract was signed?', material: true, whyMaterial: 'The allegation turns on it.', claimRefs: ['E07:claim:claim-a@1'] });
    const q2 = await engine.addQuestion(ctx(), inv.id, { text: 'Who authorised the payment schedule?', material: true, whyMaterial: 'Identifies responsibility.', parentId: q1.id });
    const q3 = await engine.addQuestion(ctx(), inv.id, { text: 'Was the harbour dredged in 2018?', material: false });
    await assert.rejects(engine.addQuestion(ctx(), inv.id, { text: 'No materiality', material: true }), code('invalid_input'));
    await assert.rejects(engine.addQuestion(ctx(), inv.id, { text: 'Orphan', material: false, parentId: 'missing' }), code('invalid_input'));

    // planner: no explanations yet → asks for them, and proposes a first search
    let plan = await engine.planNextSteps(ctx(), inv.id);
    step(plan.steps, 'manual.formulate_explanations', (s) => s.questionId === q1.id);
    const again = await engine.planNextSteps(ctx(), inv.id);
    assert.deepEqual(again.steps.map((s) => s.id), plan.steps.map((s) => s.id), 'planner is deterministic');
    assert.ok(plan.steps[0]!.data.priority <= plan.steps.at(-1)!.data.priority);

    const h1 = await engine.addHypothesis(ctx(), q1.id, { explanation: 'No tender was published.', predictedObservations: ['No notice in the gazette for January–March 2019'], contraryTest: 'A dated notice exists.' });
    const h2 = await engine.addHypothesis(ctx(), q1.id, { explanation: 'A tender was published but the record is misfiled.', predictedObservations: [{ text: 'Notice appears in a later issue' }] });
    plan = await engine.planNextSteps(ctx(), inv.id);
    step(plan.steps, 'manual.design_test', (s) => s.hypothesisId === h1.id);
    assert.ok(!plan.steps.some((s) => s.data.action === 'manual.formulate_explanations' && s.data.questionId === q1.id));
    assert.equal((await engine.get<StepData>(ctx(), 'step', again.steps.find((s) => s.data.action === 'manual.formulate_explanations' && s.data.questionId === q1.id)!.id)).state, 'resolved');

    // executable step: search through DiscoveryPort as a durable job
    const search = step(plan.steps, 'discovery.search_source', (s) => s.questionId === q1.id);
    await assert.rejects(engine.completeStep(ctx(), search.id, { outcome: 'succeeded', detail: 'x' }), code('invalid_state'));
    const queued = await engine.executeStep(ctx(), search.id);
    assert.equal(queued.step.state, 'queued');
    assert.equal(await engine.runJobs({ worker: 'w1' }), 1);
    const searched = await engine.get<StepData>(ctx(), 'step', search.id);
    assert.equal(searched.state, 'done'); assert.equal(searched.data.lastOutcome, 'succeeded'); assert.ok(searched.data.refs.includes(EV2));
    assert.equal((await engine.getJob(ctx(), queued.jobId)).state, 'done');
    const leads = await engine.list<LeadData>(ctx(), inv.id, 'lead');
    assert.equal(leads.length, 1); assert.deepEqual(leads[0]!.data.questionIds, [q1.id]);

    // q2: zero-result search is logged as such
    const search2 = step(plan.steps, 'discovery.search_source', (s) => s.questionId === q2.id);
    await engine.executeStep(ctx(), search2.id); await engine.runJobs({ worker: 'w1' });
    assert.equal((await engine.get<StepData>(ctx(), 'step', search2.id)).data.lastOutcome, 'zero_result');

    // documentary plan item with a collection run; coverage follow-up records restricted sources and a contact lead
    const item = await engine.addPlanItem(ctx(), inv.id, { kind: 'documentary_research', questionId: q1.id, hypothesisId: h1.id, description: 'Collect all tender notices for 2019', action: 'discovery.start_collection', params: { query: 'tender notices 2019' } });
    const interview = await engine.addPlanItem(ctx(), inv.id, { kind: 'interview', questionId: q2.id, description: 'Interview the former procurement officer about who authorised payments' });
    plan = await engine.planNextSteps(ctx(), inv.id);
    await engine.executeStep(ctx(), step(plan.steps, 'discovery.start_collection').id); await engine.runJobs({ worker: 'w1' });
    assert.equal((await engine.get(ctx(), 'plan_item', item.id)).state, 'done');
    plan = await engine.planNextSteps(ctx(), inv.id);
    await engine.executeStep(ctx(), step(plan.steps, 'discovery.get_coverage').id); await engine.runJobs({ worker: 'w1' });
    const notObtained = await engine.listAttempts(ctx(), inv.id, { notObtained: true });
    assert.ok(notObtained.some((a) => a.outcome === 'access_restricted' && a.target === 'source land-registry' && /on-site/.test(a.detail)));
    assert.ok(notObtained.some((a) => a.outcome === 'zero_result' && a.questionId === q2.id));
    const person = (await engine.list<LeadData>(ctx(), inv.id, 'lead')).find((l) => l.data.kind === 'person')!;
    assert.deepEqual(person.data.linkedRefs, ['E04:contact_lead:cl-1']);

    // knowledge gap → correspondence work; needs the contact capability
    const contact = step(plan.steps, 'correspondence.create_contact_plan', (s) => s.derivedFrom === 'knowledge_gap');
    assert.equal(contact.data.questionId, q1.id);
    await assert.rejects(engine.executeStep(ctx({ capabilities: ALL.filter((c) => c !== 'investigation:contact') }), contact.id), code('forbidden'));
    await engine.executeStep(ctx(), contact.id); await engine.runJobs({ worker: 'w1' });
    assert.equal(ports.correspondence.plans.size, 1); assert.equal(ports.correspondence.sent, 0);
    const inquiry = await engine.addPlanItem(ctx(), inv.id, { kind: 'correspondence', questionId: q1.id, description: 'Ask the contractor for the tender reference', action: 'correspondence.draft_inquiry', params: { questions: ['Which tender reference applied to the 2019 contract?'] } });
    plan = await engine.planNextSteps(ctx(), inv.id);
    await engine.executeStep(ctx(), step(plan.steps, 'correspondence.draft_inquiry').id); await engine.runJobs({ worker: 'w1' });
    plan = await engine.planNextSteps(ctx(), inv.id);
    const thread = step(plan.steps, 'correspondence.get_thread_state');
    await engine.executeStep(ctx(), thread.id); await engine.runJobs({ worker: 'w1' });
    assert.equal((await engine.get<StepData>(ctx(), 'step', thread.id)).state, 'waiting', 'no reply yet: the step stays re-executable');
    ports.correspondence.threads.get('E03:thread:thread-1')!.state = 'declined';
    await engine.executeStep(ctx(), thread.id); await engine.runJobs({ worker: 'w1' });
    assert.ok((await engine.listAttempts(ctx(), inv.id, { outcome: 'refused' })).some((a) => a.method === 'correspondence.get_thread_state'));
    assert.equal((await engine.get(ctx(), 'plan_item', inquiry.id)).state, 'done');

    // a claim proposed through KnowledgePort is linked to its question
    const claimItem = await engine.addPlanItem(ctx(), inv.id, { kind: 'knowledge', questionId: q2.id, description: 'Record the payment authorisation claim', action: 'knowledge.propose_claim', params: { statement: 'The finance director authorised the schedule.', label: 'allegation', sources: [{ ref: EV1, selector: { page: 9 } }] } });
    plan = await engine.planNextSteps(ctx(), inv.id);
    await engine.executeStep(ctx(), step(plan.steps, 'knowledge.propose_claim').id); await engine.runJobs({ worker: 'w1' });
    assert.ok((await engine.get<QuestionData>(ctx(), 'question', q2.id)).data.claimRefs.includes('E07:claim:claim-1@1'));
    assert.equal((await engine.get(ctx(), 'plan_item', claimItem.id)).state, 'done');

    // manual attempt: a failed request must say what happened
    await assert.rejects(engine.recordAttempt(ctx(), inv.id, { kind: 'acquisition', target: 'Payment ledger 2018', method: 'records request', outcome: 'refused' }), code('invalid_input'));
    const refusedAttempt = await engine.recordAttempt(ctx(), inv.id, { kind: 'acquisition', target: 'Payment ledger 2018', method: 'records request', outcome: 'refused', detail: 'The records office declined, citing an ongoing audit.', questionId: q2.id, effort: { timeMinutes: 45 } });
    assert.equal(refusedAttempt.lane, 'documentary');

    // findings: checklist, exact selectors, words not scores
    await assert.rejects(engine.createFinding(ctx(), inv.id, { statement: 's', label: 'verified_fact', classification: 'established', questionIds: [q1.id], supporting: [{ ref: 'E05:evidence_version:ledger-2019' }], confidence: { level: 'probable', basis: 'b' } }), code('invalid_input'));
    await assert.rejects(engine.createFinding(ctx(), inv.id, { statement: 's', label: 'verified_fact', classification: 'established', questionIds: [q1.id], supporting: [{ ref: EV1 }], confidence: { level: 'probable', basis: 'b' } }), code('invalid_input'));
    await assert.rejects(engine.createFinding(ctx(), inv.id, { statement: 's', label: 'inference', classification: 'unknown', questionIds: [q1.id], confidence: { level: 0.8 as never, basis: 'b' } }), code('invalid_input'));
    const draft = await engine.createFinding(ctx(), inv.id, { statement: 'The contract was signed on 12 March 2019 without a published tender notice.', label: 'verified_fact', classification: 'established', questionIds: [q1.id], supporting: [{ ref: EV1, selector: { page: 4, lines: '10-18' } }, { ref: 'E07:claim:claim-a@1' }], contradicting: [{ ref: EV2, selector: 'whole', note: 'Gazette lists other notices only' }], confidence: { level: 'well_supported', basis: 'Two primary records agree.' } });
    await assert.rejects(engine.submitFinding(ctx(), draft.id), (e: unknown) => code('invalid_state')(e) && /limitations must be stated/.test((e as Error).message) && /checklist item primary_source_checked/.test((e as Error).message));
    plan = await engine.planNextSteps(ctx(), inv.id);
    const verify = step(plan.steps, 'manual.complete_verification', (s) => s.findingId === draft.id);
    await engine.completeStep(ctx(), verify.id, { outcome: 'succeeded', detail: 'Checked the ledger against the gazette; contractor not reachable.', effort: { timeMinutes: 30 } });
    await assert.rejects(engine.reviseFinding(ctx(), draft.id, { checklist: { subject_response_sought: { status: 'not_done' } } }), code('invalid_input'));
    await engine.reviseFinding(ctx(), draft.id, { limitations: ['The tender register before 2018 was not available.'], checklist: CHECKLIST_DONE });
    await engine.submitFinding(ctx(), draft.id);

    // reviewer ≠ author, human, and the approve capability
    await assert.rejects(engine.reviewFinding(ctx(), draft.id, { decision: 'approve' }), code('forbidden'));
    await assert.rejects(engine.reviewFinding(ctx({ id: 'agent-7', kind: 'agent' }), draft.id, { decision: 'approve' }), code('forbidden'));
    await assert.rejects(engine.reviewFinding(ctx({ id: 'reviewer-1', capabilities: ['investigation:read', 'investigation:write', 'investigation:*'] }), draft.id, { decision: 'approve' }), code('forbidden'));
    await assert.rejects(engine.reviewFinding(ctx({ id: 'reviewer-1' }), draft.id, { decision: 'return' }), code('invalid_input'));
    const returned = await engine.reviewFinding(ctx({ id: 'reviewer-1' }), draft.id, { decision: 'return', notes: 'State which gazette issues were checked.' });
    assert.equal(returned.state, 'returned');
    await engine.reviseFinding(ctx({ id: 'researcher-2' }), draft.id, { limitations: ['The tender register before 2018 was not available.', 'Only gazette issues 1–14 of 2019 were checked.'] });
    await engine.submitFinding(ctx({ id: 'researcher-2' }), draft.id);
    await assert.rejects(engine.reviewFinding(ctx({ id: 'researcher-2' }), draft.id, { decision: 'approve' }), code('forbidden'));
    const approved = await engine.reviewFinding(ctx({ id: 'reviewer-1' }), draft.id, { decision: 'approve' });
    assert.equal(approved.state, 'approved'); assert.deepEqual(approved.data.authors, ['researcher-1', 'researcher-2']);
    assert.ok((await engine.revisions(ctx(), 'finding', draft.id)).length >= 6, 'every revision is retained');

    // registers
    await assert.rejects(engine.addContradiction(ctx(), inv.id, { description: 'd', contradicting: [] }), code('invalid_input'));
    const contradiction = await engine.addContradiction(ctx(), inv.id, { description: 'The account says the contract was signed in January; the ledger shows 12 March.', accountExcerpt: 'signed in January', accountRef: EV3, contradicting: [{ ref: EV1, selector: { page: 4 } }], questionId: q1.id, findingId: draft.id });
    await engine.updateHypothesis(ctx(), h1.id, { status: 'supported', statusRationale: 'No notice in issues 1–14.', supporting: [{ ref: EV2, selector: 'whole' }] });
    await engine.updateHypothesis(ctx(), h2.id, { status: 'inconclusive', statusRationale: 'Later issues could not be obtained.' });

    // closure is refused while a material question is silently open
    const check = await engine.closureCheck(ctx(), inv.id);
    assert.equal(check.ready, false);
    assert.deepEqual(check.blockers.map((b) => b.code).sort(), ['contradiction_unassessed', 'material_question_open', 'material_question_open']);
    assert.ok(check.warnings.some((w) => w.code === 'non_material_question_open') && check.warnings.some((w) => w.code === 'plan_item_unexecuted') && check.warnings.some((w) => w.code === 'lead_open'));
    const early = await engine.buildPackage(ctx(), inv.id);
    assert.equal((early.content!.closure as { ready: boolean }).ready, false);
    await assert.rejects(engine.close(ctx({ id: 'lead-1' }), inv.id, { rationale: 'Good enough', packageVersion: early.version }), (e: unknown) => code('invalid_state')(e) && /Material question has no recorded disposition/.test((e as Error).message));
    assert.equal((await engine.requestReview(ctx(), inv.id)).investigation.state, 'open');

    // dispositions: answers need findings, unresolved needs a rationale, demotion needs a rationale
    await assert.rejects(engine.disposeQuestion(ctx(), q1.id, { status: 'answered', answer: 'No tender was published.', answerLabel: 'verified_fact' }), code('invalid_input'));
    await assert.rejects(engine.disposeQuestion(ctx(), q2.id, { status: 'unresolvable' }), code('invalid_input'));
    await assert.rejects(engine.disposeQuestion(ctx(), q2.id, { status: 'out_of_scope' }), code('invalid_input'));
    await assert.rejects(engine.updateQuestion(ctx(), q2.id, { material: false }), code('invalid_input'));
    await engine.disposeQuestion(ctx(), q1.id, { status: 'answered', answer: 'No tender notice was published before signature.', answerLabel: 'verified_fact', findingIds: [draft.id] });
    await engine.disposeQuestion(ctx(), q2.id, { status: 'unresolvable', rationale: 'The payment ledger was refused and the officer could not be interviewed.', whatWouldResolve: 'Release of the 2018 payment ledger.' });
    const unknowns = await engine.list(ctx(), inv.id, 'unknown');
    assert.equal(unknowns.length, 1); assert.ok((unknowns[0]!.data as { attemptIds: string[] }).attemptIds.includes(refusedAttempt.id));
    await engine.updateContradiction(ctx(), contradiction.id, { status: 'unresolved', resolutionNote: 'The clerk could not be re-contacted to explain the date.' });
    await engine.updatePlanItem(ctx(), interview.id, { status: 'skipped', statusNote: 'Officer could not be located.' });
    const ready = await engine.requestReview(ctx(), inv.id);
    assert.equal(ready.closure.ready, true); assert.equal(ready.investigation.state, 'review_ready');

    // the package
    await assert.rejects(engine.close(ctx({ id: 'lead-1' }), inv.id, { rationale: 'Complete', packageVersion: early.version }), (e: unknown) => code('invalid_state')(e) && /does not reflect the current state/.test((e as Error).message));
    const pkg = await engine.buildPackage(ctx(), inv.id, { idempotencyKey: 'pkg-2' });
    assert.equal(pkg.version, 2); assert.equal((await engine.buildPackage(ctx(), inv.id, { idempotencyKey: 'pkg-2' })).version, 2, 'idempotent replay builds nothing new');
    const c = pkg.content as Record<string, any>;
    assert.equal(c.digest, pkg.digest); assert.match(pkg.digest, /^[0-9a-f]{64}$/); assert.deepEqual(c.previousVersion, { version: 1, digest: early.digest });
    assert.equal(c.originalAccount.label, 'allegation'); assert.equal(c.originalAccount.ref, EV3); assert.match(c.scope.statement, /2019 harbour/);
    assert.deepEqual(c.questionTree.map((q: any) => [q.depth, q.status, q.material]), [[0, 'answered', true], [1, 'unresolvable', true], [0, 'open', false]]);
    assert.equal(c.questionTree[1].disposition.rationale, 'The payment ledger was refused and the officer could not be interviewed.');
    assert.equal(c.findings.length, 1);
    assert.deepEqual(c.findings[0].supporting[0], { ref: EV1, selector: { page: 4, lines: '10-18' }, note: null });
    assert.equal(c.findings[0].label, 'verified_fact'); assert.equal(c.findings[0].limitations.length, 2); assert.equal(c.findings[0].confidence.level, 'well_supported');
    assert.equal(c.findings[0].checklist.subject_response_sought.status, 'not_done');
    assert.deepEqual(c.explanations[0].hypotheses.map((h: any) => h.status), ['supported', 'inconclusive']); assert.equal(c.explanations[0].hypotheses[0].label, 'inference');
    assert.equal(c.contradictions.length, 1); assert.equal(c.contradictions[0].status, 'unresolved'); assert.equal(c.unknowns.length, 1); assert.equal(c.unknowns[0].label, 'unknown');
    assert.ok(c.attempts.notObtained.some((a: any) => a.outcome === 'refused' && a.target === 'Payment ledger 2018'));
    assert.ok(c.attempts.notObtained.some((a: any) => a.outcome === 'access_restricted') && c.attempts.byOutcome.zero_result >= 1);
    assert.deepEqual(c.chronology.entries.map((e: any) => [e.at, e.label]), [['2019-02-01', 'disputed'], ['2019-03-12', 'established']]);
    assert.deepEqual(c.evidenceIndex.map((e: any) => [e.ref, e.sha256, e.verified]), [[EV1, 'a'.repeat(64), true], [EV2, 'b'.repeat(64), true], [EV3, null, false]]);
    assert.equal(c.evidenceIndex[0].custodySummary, 'Received 2026-01-04; hash verified twice'); assert.deepEqual(c.evidenceIndex[0].origin, { source: 'municipal archive' });
    assert.ok(c.limitations.some((l: string) => /1 cited evidence version\(s\) could not be described/.test(l)));
    assert.equal(c.effortByLane.lanes.length, 2); assert.equal(c.closure.ready, true);
    assert.ok(c.notPursued.planItems.some((p: any) => p.status === 'skipped' && p.statusNote === 'Officer could not be located.'));
    for (const needle of ['Original account (as received)', '[allegation]', 'What could not be obtained', 'Contradictions with the account', 'What remains unknown', EV1, '"page":4', 'a'.repeat(64), 'Effort by research lane', 'The tender register before 2018 was not available.']) assert.ok(pkg.markdown!.includes(needle), `markdown contains ${needle}`);
    assert.match(pkg.html!, /^<!doctype html>/); assert.ok(pkg.html!.includes('&quot;page&quot;:4') && !pkg.html!.includes('<script'));

    // closure: a human decision with a rationale, on the current package
    await assert.rejects(engine.close(ctx({ id: 'agent-7', kind: 'agent' }), inv.id, { rationale: 'Complete', packageVersion: 2 }), code('forbidden'));
    await assert.rejects(engine.close(ctx({ id: 'lead-1', capabilities: ['investigation:*'] }), inv.id, { rationale: 'Complete', packageVersion: 2 }), code('forbidden'));
    await assert.rejects(engine.close(ctx({ id: 'lead-1' }), inv.id, { rationale: '', packageVersion: 2 }), code('invalid_input'));
    const closed = await engine.close(ctx({ id: 'lead-1' }), inv.id, { rationale: 'Material questions are answered or recorded as unresolved.', packageVersion: 2, reopeningTriggers: ['Release of the 2018 payment ledger'] });
    assert.equal(closed.state, 'closed'); assert.equal(closed.data.closures[0]!.packageDigest, pkg.digest);
    await assert.rejects(engine.addQuestion(ctx(), inv.id, { text: 'Late question', material: false }), code('invalid_state'));
    await assert.rejects(engine.planNextSteps(ctx(), inv.id), code('invalid_state'));

    // reopening on new information retains the earlier package versions
    await assert.rejects(engine.reopen(ctx(), inv.id, { reason: '' }), code('invalid_input'));
    const reopened = await engine.reopen(ctx(), inv.id, { reason: 'The 2018 payment ledger was released.', newInformationRefs: ['E05:evidence_version:ledger-2018@1'] });
    assert.equal(reopened.state, 'open'); assert.equal(reopened.data.closures.length, 1); assert.equal(reopened.data.reopenings.length, 1);
    await engine.disposeQuestion(ctx(), q2.id, { status: 'open', rationale: 'New ledger available.' });
    const v3 = await engine.buildPackage(ctx(), inv.id);
    assert.equal(v3.version, 3); assert.equal((v3.content!.closure as { ready: boolean }).ready, false);
    const kept = await engine.getPackage(ctx(), inv.id, 2);
    assert.equal(kept.digest, pkg.digest); assert.equal(kept.markdown, pkg.markdown); assert.equal(kept.current, false);
    assert.deepEqual((await engine.listPackages(ctx(), inv.id)).map((p) => p.version), [1, 2, 3]);

    // standard surface
    const events = await eventsOf(engine, ctx(), ['investigation.reopened', 'investigation.closed', 'investigation.package_built', 'investigation.finding_approved', 'investigation.question_opened', 'investigation.review_ready', 'investigation.outreach_required']);
    for (const t of ['investigation.opened', 'investigation.question_opened', 'investigation.outreach_required', 'investigation.finding_proposed', 'investigation.finding_returned', 'investigation.finding_approved', 'investigation.step_completed', 'investigation.package_built', 'investigation.review_ready', 'investigation.closed', 'investigation.reopened']) { assert.ok(events.some((e) => e.type === t), `event ${t}`); assert.ok(manifest.emits.includes(t)); }
    assert.equal(events.filter((e) => e.type === 'investigation.question_opened').length, 4, 'three opened and one re-opened');
    assert.ok(events.find((e) => e.type === 'investigation.finding_approved')!.subject.startsWith(`E08:finding:${draft.id}@`));
    await assert.rejects(engine.events(ctx({ capabilities: ['investigation:*'] })), code('forbidden'));
    const insp = (await engine.inspect(ctx(), `E08:finding:${draft.id}`))!;
    assert.equal(insp.state, 'approved'); assert.ok(insp.sources.includes(EV1)); assert.ok(insp.dependents.includes(`E08:investigation_package:${inv.id}@2`)); assert.ok(insp.versions.length >= 6); assert.ok(insp.history.length > 0); assert.equal(insp.decisions.length, 2);
    assert.equal((await engine.inspect(ctx(), `E08:investigation_package:${inv.id}@2`))!.state, 'superseded');
    assert.equal(await engine.inspect(ctx(), 'E08:finding:nope'), null); assert.equal(await engine.inspect(ctx(), 'E05:evidence:x'), null);
    assert.ok((await engine.search(ctx(), { q: 'tender notice' })).some((h) => h.kind === 'finding'));
    assert.equal((await engine.health()).ok, true);
    void q3;
  });
});

test('engine: stale and blocked propagation from upstream changes', needsPg, async () => {
  await withEngine(async ({ engine }) => {
    const inv = await openBasic(engine);
    const q = await engine.addQuestion(ctx(), inv.id, { text: 'Was a tender published?', material: true, whyMaterial: 'Core.' });
    const f = await approvedFinding(engine, inv.id, q.id);
    const other = await approvedFinding(engine, inv.id, q.id, { statement: 'The gazette carries no notice.', supporting: [{ ref: EV2, selector: 'whole' }] });
    await engine.disposeQuestion(ctx(), q.id, { status: 'answered', answer: 'No.', answerLabel: 'verified_fact', findingIds: [f.id] });
    const pkg = await engine.buildPackage(ctx(), inv.id);
    assert.equal(pkg.current, true);

    const change = { eventId: 'evt-1', kind: 'claim_changed' as const, refs: ['E07:claim:claim-a'], reason: 'Claim was corrected after a source retraction' };
    const applied = await engine.applyUpstreamChange(ctx({ id: 'router', kind: 'service' }), change);
    assert.deepEqual(applied.affected.sort(), [`E08:finding:${f.id}@${f.revision}`, `E08:investigation_package:${inv.id}@1`].sort());
    assert.deepEqual(await engine.applyUpstreamChange(ctx({ id: 'router', kind: 'service' }), change), applied, 'idempotent by eventId');
    const stale = await engine.get<FindingData>(ctx(), 'finding', f.id);
    assert.equal(stale.stale, true); assert.equal(stale.state, 'approved'); assert.equal(stale.revision, f.revision, 'nothing is rewritten'); assert.deepEqual(stale.data, f.data);
    assert.equal((await engine.get(ctx(), 'finding', other.id)).stale, false);
    const insp = (await engine.inspect(ctx(), `E08:finding:${f.id}`))!;
    assert.equal(insp.stale, true); assert.match(insp.staleReasons[0]!, /claim_changed.*source retraction/);
    const stalePkg = await engine.getPackage(ctx(), inv.id, 1);
    assert.equal(stalePkg.stale, true); assert.equal(stalePkg.current, false); assert.equal(stalePkg.digest, pkg.digest); assert.equal(stalePkg.markdown, pkg.markdown);
    const events = await eventsOf(engine, ctx(), ['investigation.finding_stale', 'investigation.package_stale']);
    const fs = events.filter((e) => e.type === 'investigation.finding_stale');
    assert.equal(fs.length, 1); assert.deepEqual((fs[0]!.payload as { cause: string; reason: string }).cause, 'evt-1'); assert.equal(events.filter((e) => e.type === 'investigation.package_stale').length, 1);

    // stale approval blocks closure and a stale package cannot support it; the planner asks for renewed review
    assert.ok((await engine.closureCheck(ctx(), inv.id)).blockers.some((b) => b.code === 'answer_finding_not_approved') && (await engine.closureCheck(ctx(), inv.id)).blockers.some((b) => b.code === 'finding_stale'));
    await assert.rejects(engine.close(ctx({ id: 'lead-1' }), inv.id, { rationale: 'r', packageVersion: 1 }), code('invalid_state'));
    assert.ok((await engine.planNextSteps(ctx(), inv.id)).steps.some((s) => s.data.action === 'manual.re_review_finding' && s.data.findingId === f.id));
    const v2 = await engine.buildPackage(ctx(), inv.id);
    assert.equal((v2.content!.findings as { stale: boolean }[])[0]!.stale, true);
    await assert.rejects(engine.reviewFinding(ctx(), f.id, { decision: 'approve' }), code('forbidden'));
    const renewed = await engine.reviewFinding(ctx({ id: 'reviewer-1' }), f.id, { decision: 'approve', notes: 'Correction does not change the finding.' });
    assert.equal(renewed.stale, false); assert.equal(renewed.data.reviews.at(-1)!.renewed, true);
    assert.equal((await engine.closureCheck(ctx(), inv.id)).ready, true);

    // a version-pinned change only touches matching revisions
    assert.deepEqual((await engine.applyUpstreamChange(ctx(), { eventId: 'evt-2', kind: 'source_corrected', refs: ['E05:evidence_version:ledger-2019@7'], reason: 'different revision' })).affected, []);

    // permission withdrawn → blocked: withheld from new packages, old package content withheld
    const blocked = await engine.applyUpstreamChange(ctx(), { eventId: 'evt-3', kind: 'permission_withdrawn', refs: [EV2], reason: 'Source withdrew permission' });
    assert.ok(blocked.affected.includes(`E08:finding:${other.id}@${other.revision}`));
    assert.equal((await engine.get(ctx(), 'finding', other.id)).blocked, true);
    const b = await eventsOf(engine, ctx(), ['investigation.finding_blocked', 'investigation.package_blocked']);
    assert.ok(b.some((e) => e.type === 'investigation.finding_blocked') && b.some((e) => e.type === 'investigation.package_blocked'));
    const withheld = await engine.getPackage(ctx(), inv.id, 1);
    assert.equal(withheld.blocked, true); assert.equal(withheld.content, null); assert.equal(withheld.markdown, null);
    await assert.rejects(engine.reviewFinding(ctx({ id: 'reviewer-1' }), other.id, { decision: 'approve' }), code('invalid_state'));
    const v3 = await engine.buildPackage(ctx(), inv.id);
    assert.ok(!(v3.content!.findings as { id: string }[]).some((x) => x.id === other.id));
    assert.match((v3.content!.findingsNotIncluded as { reason: string }[])[0]!.reason, /withheld/); assert.ok(!v3.markdown!.includes('The gazette carries no notice.'));
    assert.ok((await engine.closureCheck(ctx(), inv.id)).blockers.some((x) => x.code === 'finding_blocked'));
    // revising the finding to drop the withdrawn source lifts the block and requires a fresh review
    const revised = await engine.reviseFinding(ctx(), other.id, { supporting: [{ ref: EV1, selector: { page: 2 } }] });
    assert.equal(revised.blocked, false); assert.equal(revised.state, 'draft');
  });
});

test('engine: lane effort accounting is reported against configured shares, never enforced', needsPg, async () => {
  await withEngine(async ({ engine }) => {
    await assert.rejects(openBasic(engine, ctx(), { lanes: [{ id: 'a', name: 'A', targetShare: 0.7 }, { id: 'b', name: 'B', targetShare: 0.7 }] }), code('invalid_input'));
    const inv = await openBasic(engine, ctx(), { lanes: [{ id: 'records', name: 'Records', targetShare: 0.5, attemptKinds: ['search', 'acquisition'] }, { id: 'people', name: 'People', targetShare: 0.3, attemptKinds: ['contact'] }, { id: 'data', name: 'Datasets', targetShare: 0.2 }] });
    const rec = (over: Record<string, unknown>) => engine.recordAttempt(ctx(), inv.id, { kind: 'search', target: 't', method: 'manual search', outcome: 'succeeded', ...over } as never);
    await rec({ effort: { timeMinutes: 60, costUnits: 4 }, refs: [EV1] });
    await rec({ outcome: 'zero_result', detail: 'Nothing in the index', effort: { timeMinutes: 30 } });
    await rec({ kind: 'contact', outcome: 'refused', detail: 'Declined to speak', effort: { timeMinutes: 30, costUnits: 1 } });
    await rec({ kind: 'processing', lane: 'data', effort: { timeMinutes: 0, costUnits: 5 } });
    await rec({ kind: 'verification', effort: { timeMinutes: 0, attempts: 0 } });
    await assert.rejects(rec({ lane: 'nope' }), code('invalid_input'));
    const r = await engine.effortReport(ctx(), inv.id);
    assert.deepEqual(r.totals, { timeMinutes: 120, attempts: 4, costUnits: 10 });
    const by = Object.fromEntries(r.lanes.map((l) => [String(l.laneId), l]));
    assert.deepEqual(by.records!.actualShare, { time: 0.75, attempts: 0.5, cost: 0.4 }); assert.deepEqual(by.records!.deviation, { time: 0.25, attempts: 0, cost: -0.1 });
    assert.equal(by.records!.notObtained, 1); assert.equal(by.records!.refsProduced, 1); assert.deepEqual(by.records!.outcomes, { succeeded: 1, zero_result: 1 });
    assert.deepEqual(by.people!.actualShare, { time: 0.25, attempts: 0.25, cost: 0.1 }); assert.equal(by.people!.notObtained, 1);
    assert.equal(by.data!.actualShare.cost, 0.5); assert.equal(by.null!.targetShare, null); assert.match(r.note, /not enforced/);
    // a lopsided split is reported and does not stop work or closure checks
    assert.equal((await engine.closureCheck(ctx(), inv.id)).ready, true);
    const corr = await engine.listAttempts(ctx(), inv.id);
    const fix = await rec({ kind: 'contact', outcome: 'partial', detail: 'Correction: the person later agreed to a short call', corrects: corr[2]!.id });
    assert.equal(fix.corrects, corr[2]!.id); assert.equal((await engine.listAttempts(ctx(), inv.id)).length, 6, 'the corrected entry is retained');
  });
});

test('engine: jobs survive a crash, reconcile uncertain side effects, and honour pause and cancel', needsPg, async () => {
  await withEngine(async ({ engine, ports, sql, make }) => {
    const inv = await openBasic(engine);
    const q = await engine.addQuestion(ctx(), inv.id, { text: 'Was a tender published?', material: true, whyMaterial: 'Core.' });
    const mk = async (query: string) => { const item = await engine.addPlanItem(ctx(), inv.id, { kind: 'documentary_research', questionId: q.id, description: `Collect ${query}`, action: 'discovery.start_collection', params: { query } }); const plan = await engine.planNextSteps(ctx(), inv.id); return plan.steps.find((s) => s.data.planItemId === item.id)!; };

    // crash: a worker leases the job and dies; another engine instance on the same database finishes it exactly once
    const s1 = await mk('tender notices');
    const queued = await engine.executeStep(ctx(), s1.id, { idempotencyKey: 'exec-1' });
    assert.equal((await engine.executeStep(ctx(), s1.id, { idempotencyKey: 'exec-1' })).jobId, queued.jobId, 'idempotent replay queues nothing new');
    await assert.rejects(engine.executeStep(ctx(), s1.id), code('invalid_state'));
    const leased = await kit.leaseJobs(sql, SCHEMA, { worker: 'crashed-worker', kinds: [STEP_JOB], leaseMs: 60 });
    assert.equal(leased.length, 1);
    await new Promise((r) => setTimeout(r, 120));
    const second = make();
    assert.equal(await second.runJobs({ worker: 'w2' }), 1);
    assert.equal((await second.get<StepData>(ctx(), 'step', s1.id)).state, 'done');
    assert.equal(await second.runJobs({ worker: 'w2' }), 0);
    assert.equal((await engine.listAttempts(ctx(), inv.id)).filter((a) => a.stepId === s1.id).length, 1); assert.equal(ports.discovery.runs.size, 1);
    await assert.rejects(kit.completeJob(sql, SCHEMA, leased[0]!), code('lease_lost'));

    // the port performed the effect but the answer was lost: recorded as uncertain, reconciled by re-running with the same idempotency key
    const s2 = await mk('award decisions');
    ports.discovery.failNextStart = 'after';
    await engine.executeStep(ctx(), s2.id); await engine.runJobs({ worker: 'w1' });
    const uncertain = await engine.get<StepData>(ctx(), 'step', s2.id);
    assert.equal(uncertain.state, 'uncertain');
    const logged = (await engine.listAttempts(ctx(), inv.id)).filter((a) => a.stepId === s2.id);
    assert.equal(logged[0]!.outcome, 'uncertain'); assert.doesNotMatch(JSON.stringify(logged), /socket hang up|secret-host/);
    assert.ok((await engine.closureCheck(ctx(), inv.id)).blockers.some((b) => b.code === 'step_uncertain'));
    await engine.executeStep(ctx(), s2.id); await engine.runJobs({ worker: 'w1' });
    assert.equal((await engine.get<StepData>(ctx(), 'step', s2.id)).state, 'done'); assert.equal(ports.discovery.runs.size, 2, 'the effect was not repeated');
    assert.deepEqual((await engine.listAttempts(ctx(), inv.id)).filter((a) => a.stepId === s2.id).map((a) => a.outcome), ['uncertain', 'succeeded']);

    // a definite failure before the effect is recorded as failed, without the provider's message
    const s3 = await mk('payment schedules');
    ports.discovery.failNextStart = 'before';
    await engine.executeStep(ctx(), s3.id); await engine.runJobs({ worker: 'w1' });
    assert.equal((await engine.get<StepData>(ctx(), 'step', s3.id)).state, 'uncertain', 'an unanswered side-effecting call is never assumed to have failed cleanly');

    // pause: nothing runs until resumed
    const s4 = await mk('council minutes');
    const before = ports.discovery.calls.length;
    const j4 = await engine.executeStep(ctx(), s4.id);
    assert.equal((await engine.controlJob(ctx(), j4.jobId, 'pause')).state, 'paused');
    assert.equal(await engine.runJobs({ worker: 'w1' }), 0); assert.equal(ports.discovery.calls.length, before);
    await engine.controlJob(ctx(), j4.jobId, 'resume');
    assert.equal(await engine.runJobs({ worker: 'w1' }), 1); assert.equal((await engine.get<StepData>(ctx(), 'step', s4.id)).state, 'done');

    // cancel: no side effect, no attempt, the step can be queued again later
    const s5 = await mk('harbour invoices');
    const j5 = await engine.executeStep(ctx(), s5.id);
    const calls = ports.discovery.calls.length;
    assert.equal((await engine.controlJob(ctx(), j5.jobId, 'cancel')).state, 'cancelled');
    assert.equal(await engine.runJobs({ worker: 'w1' }), 0); assert.equal(ports.discovery.calls.length, calls);
    assert.equal((await engine.get<StepData>(ctx(), 'step', s5.id)).state, 'cancelled'); assert.equal((await engine.listAttempts(ctx(), inv.id)).filter((a) => a.stepId === s5.id).length, 0);
    await assert.rejects(engine.controlJob(ctx({ capabilities: ['investigation:read'] }), j5.jobId, 'retry'), code('forbidden'));

    // pause arriving while the job is already running is honoured before the side effect
    const s6 = await mk('dredging permits');
    let pauseNow: (() => Promise<unknown>) | null = null;
    const guarded = make({ ...ports, authorization: { authorize: async () => { await pauseNow?.(); return { allowed: true, reason: 'ok', policyVersion: '1' }; } } });
    const j6 = await guarded.executeStep(ctx(), s6.id);
    pauseNow = () => guarded.controlJob(ctx(), j6.jobId, 'pause');
    const n6 = ports.discovery.calls.length;
    await guarded.runJobs({ worker: 'w1' });
    assert.equal(ports.discovery.calls.length, n6, 'no port call after the pause'); assert.equal((await guarded.getJob(ctx(), j6.jobId)).state, 'paused');
    pauseNow = null;
    await guarded.controlJob(ctx(), j6.jobId, 'resume'); await guarded.runJobs({ worker: 'w1' });
    assert.equal((await guarded.get<StepData>(ctx(), 'step', s6.id)).state, 'done');

    // authorization re-check in the worker, absent ports, budget
    const s7 = await mk('audit letters');
    const denying = make({ ...ports, authorization: { authorize: async () => ({ allowed: false, reason: 'role removed', policyVersion: '2' }) } });
    await denying.executeStep(ctx(), s7.id); const n7 = ports.discovery.calls.length; await denying.runJobs({ worker: 'w1' });
    assert.equal(ports.discovery.calls.length, n7); assert.equal((await engine.listAttempts(ctx(), inv.id, { outcome: 'refused' })).filter((a) => a.stepId === s7.id).length, 1);
    const bare = make({});
    await bare.executeStep(ctx(), s7.id); await bare.runJobs({ worker: 'w1' });
    const un = (await engine.listAttempts(ctx(), inv.id, { outcome: 'unavailable' })).find((a) => a.stepId === s7.id)!;
    assert.match(un.detail, /DiscoveryPort \(E04\) is not configured/); assert.equal((await engine.get<StepData>(ctx(), 'step', s7.id)).state, 'blocked');
    const costed = make(ports, { stepCosts: { 'discovery.start_collection': { category: 'acquisition', amount: 60, unit: 'credits' } } });
    await costed.executeStep(ctx(), s7.id); await costed.runJobs({ worker: 'w1' });
    assert.equal((await engine.listAttempts(ctx(), inv.id)).filter((a) => a.stepId === s7.id).at(-1)!.effort.costUnits, 61, 'declared cost plus the port-reported cost');
    const s8 = await mk('port authority memos');
    await costed.executeStep(ctx(), s8.id); await costed.runJobs({ worker: 'w1' });
    const over = (await engine.listAttempts(ctx(), inv.id)).filter((a) => a.stepId === s8.id).at(-1)!;
    assert.equal(over.outcome, 'refused'); assert.match(over.detail, /budget_exhausted/);
    const noBudget = make({ discovery: ports.discovery }, { stepCosts: { 'discovery.start_collection': { category: 'acquisition', amount: 1, unit: 'credits' } } });
    const starts = ports.discovery.calls.length;
    await noBudget.executeStep(ctx(), s8.id); await noBudget.runJobs({ worker: 'w1' });
    assert.equal(ports.discovery.calls.length, starts, 'a costed action is denied, not skipped, when no BudgetPort is configured');
  });
});

test('engine: proposals are data until accepted; policy auto-accept is bounded', needsPg, async () => {
  await withEngine(async ({ engine }) => {
    const inv = await openBasic(engine, ctx(), { policy: { autoAccept: { questions: { enabled: true, max: 1 }, steps: { enabled: true, max: 5, actions: ['discovery.search_source'] } } } });
    const q = await engine.addQuestion(ctx(), inv.id, { text: 'Was a tender published?', material: true, whyMaterial: 'Core.' });
    const agent = ctx({ id: 'agent-3', kind: 'agent', capabilities: ['investigation:read', 'investigation:plan'] });
    await assert.rejects(engine.addQuestion(agent, inv.id, { text: 'x', material: false }), code('forbidden'));
    await assert.rejects(engine.proposeQuestions(agent, inv.id, { items: [{ text: 'No materiality flag' }], rationale: 'r' }), code('invalid_input'));
    const proposed = await engine.proposeQuestions(agent, inv.id, { rationale: 'The account mentions a second contract.', source: 'model suggestion', items: [
      { text: 'Is there a second contract with the same supplier?', material: true, whyMaterial: 'Pattern.' },
      { text: 'When was the supplier registered?', material: false },
      { text: 'Who witnessed the signature?', material: false, parentId: q.id }] });
    assert.deepEqual(proposed.map((p) => p.state), ['proposed', 'accepted', 'proposed'], 'material questions are never auto-accepted; the ceiling stops the third');
    assert.equal(proposed[1]!.data.decision!.by, 'policy');
    assert.equal((await engine.list(ctx(), inv.id, 'question')).length, 2);
    await assert.rejects(engine.decideProposal(agent, proposed[0]!.id, { decision: 'accept' }), code('forbidden'));
    await assert.rejects(engine.decideProposal(ctx({ id: 'agent-9', kind: 'agent' }), proposed[0]!.id, { decision: 'accept' }), code('forbidden'));
    const accepted = await engine.decideProposal(ctx(), proposed[0]!.id, { decision: 'accept' });
    assert.match(accepted.data.decision!.createdRef!, /^E08:question:/);
    await assert.rejects(engine.decideProposal(ctx(), proposed[2]!.id, { decision: 'reject' }), code('invalid_input'));
    assert.equal((await engine.decideProposal(ctx(), proposed[2]!.id, { decision: 'reject', rationale: 'Not relevant to scope.' })).state, 'rejected');
    await assert.rejects(engine.decideProposal(ctx(), proposed[2]!.id, { decision: 'accept' }), code('invalid_state'));
    const steps = await engine.proposeSteps(agent, inv.id, { rationale: 'Follow the supplier.', items: [
      { kind: 'documentary_research', questionId: q.id, description: 'Search for supplier filings', action: 'discovery.search_source', params: { query: 'supplier filings' } },
      { kind: 'correspondence', questionId: q.id, description: 'Write to the supplier', action: 'correspondence.draft_inquiry', params: { questions: ['Which tender?'] } }] });
    assert.deepEqual(steps.map((p) => p.state), ['accepted', 'proposed'], 'only listed actions are auto-accepted');
    await assert.rejects(engine.proposeSteps(agent, inv.id, { rationale: 'r', items: [{ kind: 'documentary_research', questionId: q.id, description: 'd', action: 'shell.exec', params: {} }] }), code('invalid_input'));
    const plan = await engine.planNextSteps(agent, inv.id);
    assert.ok(plan.steps.some((s) => s.data.action === 'discovery.search_source' && s.data.planItemId !== null));
    await assert.rejects(engine.executeStep(agent, plan.steps[0]!.id), code('forbidden'));
    assert.equal((await engine.getInvestigation(ctx(), inv.id)).data.autoAccepted.questions, 1);
  });
});

test('engine: planner consults knowledge gaps and degrades honestly without ports', needsPg, async () => {
  await withEngine(async ({ engine, ports, make }) => {
    const inv = await openBasic(engine);
    const q = await engine.addQuestion(ctx(), inv.id, { text: 'Was a tender published?', material: true, whyMaterial: 'Core.', claimRefs: ['E07:claim:claim-a@1'] });
    ports.knowledge.gaps = [{ id: 'g1', kind: 'single_source_family', description: 'Only municipal records support the signing date', claimRef: 'E07:claim:claim-a' }, { id: 'g2', kind: 'unprocessed', description: 'Ledger scan has no text layer', evidenceRef: EV1 }, { id: 'g3', kind: 'exotic', description: 'Something else' }];
    const plan = await engine.planNextSteps(ctx(), inv.id);
    const gapSteps = plan.steps.filter((s) => s.data.derivedFrom === 'knowledge_gap');
    assert.deepEqual(gapSteps.map((s) => s.data.action).sort(), ['discovery.search_source', 'manual.resolve_gap', 'processing.request']);
    assert.equal(gapSteps.find((s) => s.data.action === 'discovery.search_source')!.data.questionId, q.id);
    await engine.planNextSteps(ctx(), inv.id); await engine.planNextSteps(ctx(), inv.id);
    assert.equal((await engine.listAttempts(ctx(), inv.id)).filter((a) => a.method === 'knowledge.get_gaps').length, 1, 'an unchanged answer is logged once');
    ports.knowledge.failing = true;
    const failed = await engine.planNextSteps(ctx(), inv.id);
    assert.match(failed.notes[0]!, /could not be consulted \(unavailable\)/);
    assert.equal((await engine.listAttempts(ctx(), inv.id, { outcome: 'unavailable' })).filter((a) => a.method === 'knowledge.get_gaps').length, 1);
    // processing follow-up: request → text not ready (waiting) → text
    ports.knowledge.failing = false;
    const again = await engine.planNextSteps(ctx(), inv.id);
    await engine.executeStep(ctx(), again.steps.find((s) => s.data.action === 'processing.request')!.id); await engine.runJobs({ worker: 'w' });
    const next = await engine.planNextSteps(ctx(), inv.id);
    const read = next.steps.find((s) => s.data.action === 'processing.get_text')!;
    await engine.executeStep(ctx(), read.id); await engine.runJobs({ worker: 'w' });
    assert.equal((await engine.get<StepData>(ctx(), 'step', read.id)).state, 'waiting');
    ports.processing.texts.set(EV1, 'Contract signed 12 March 2019');
    await engine.executeStep(ctx(), read.id); await engine.runJobs({ worker: 'w' });
    assert.equal((await engine.get<StepData>(ctx(), 'step', read.id)).state, 'done');

    // no ports at all: the engine still works and says what is missing
    const alone = make({});
    const p = await alone.planNextSteps(ctx(), inv.id);
    assert.match(p.notes[0]!, /KnowledgePort is not configured/);
    await engine.createFinding(ctx(), inv.id, { statement: 'Unverified', label: 'inference', classification: 'unknown', questionIds: [q.id], supporting: [{ ref: EV1, selector: 'whole' }], confidence: { level: 'uncertain', basis: 'Single scan' } });
    await alone.updateHypothesis(ctx(), (await alone.addHypothesis(ctx(), q.id, { explanation: 'Signed late', supporting: [{ ref: EV1 }] })).id, { contraryTest: 'A dated notice' });
    const pkg = await alone.buildPackage(ctx(), inv.id);
    const c = pkg.content as Record<string, any>;
    assert.equal(c.chronology.available, false); assert.match(c.chronology.reason, /KnowledgePort/);
    assert.equal(c.evidenceIndex[0].verified, false); assert.match(c.evidenceIndex[0].note, /EvidencePort not configured/);
    assert.ok(c.limitations.some((l: string) => /evidence index is unverified/.test(l)) && c.limitations.some((l: string) => /No factual chronology/.test(l)));
    assert.match(pkg.markdown!, /Not available: KnowledgePort/);
    assert.deepEqual((await alone.health()).detail, { jobsPending: 0, jobsDead: 0, ports: { discovery: 'unavailable', evidence: 'unavailable', processing: 'unavailable', knowledge: 'unavailable', correspondence: 'unavailable', budget: 'unavailable', authorization: 'unavailable' } });
  });
});

test('engine: tenant, project and compartment isolation; fail-closed authorization; idempotent replay', needsPg, async () => {
  await withEngine(async ({ engine, sql }) => {
    const inv = await openBasic(engine, ctx(), { idempotencyKey: 'open-1' });
    assert.equal((await openBasic(engine, ctx(), { idempotencyKey: 'open-1' })).id, inv.id);
    await assert.rejects(openBasic(engine, ctx(), { idempotencyKey: 'open-1', title: 'Different' }), code('idempotency_conflict'));
    assert.equal((await engine.listInvestigations(ctx())).length, 1);
    const q = await engine.addQuestion(ctx(), inv.id, { text: 'Was a harbour tender published?', material: true, whyMaterial: 'Core.' });
    const f = await approvedFinding(engine, inv.id, q.id);
    const attempt = await engine.recordAttempt(ctx(), inv.id, { kind: 'search', target: 'gazette', method: 'manual', outcome: 'succeeded' });
    const plan = await engine.planNextSteps(ctx(), inv.id);
    const exec = await engine.executeStep(ctx(), plan.steps.find((s) => s.data.executable)!.id);
    await engine.buildPackage(ctx(), inv.id);

    for (const other of [ctx({ tenantId: 't2' }), ctx({ projectId: 'p2' })]) {
      for (const call of [
        () => engine.getInvestigation(other, inv.id), () => engine.getOverview(other, inv.id), () => engine.get(other, 'question', q.id), () => engine.get(other, 'finding', f.id), () => engine.list(other, inv.id, 'finding'),
        () => engine.revisions(other, 'finding', f.id), () => engine.listAttempts(other, inv.id), () => engine.effortReport(other, inv.id), () => engine.closureCheck(other, inv.id), () => engine.getPackage(other, inv.id), () => engine.listPackages(other, inv.id),
        () => engine.getJob(other, exec.jobId), () => engine.controlJob(other, exec.jobId, 'cancel'), () => engine.planNextSteps(other, inv.id), () => engine.executeStep(other, exec.step.id), () => engine.buildPackage(other, inv.id),
        () => engine.addQuestion(other, inv.id, { text: 'x', material: false }), () => engine.disposeQuestion(other, q.id, { status: 'out_of_scope', rationale: 'r' }), () => engine.reviseFinding(other, f.id, { statement: 'tampered' }), () => engine.reviewFinding(ctx({ ...other, id: 'reviewer-9' }), f.id, { decision: 'approve' }),
        () => engine.recordAttempt(other, inv.id, { kind: 'search', target: 't', method: 'm', outcome: 'succeeded' }), () => engine.close(ctx({ ...other, id: 'lead-1' }), inv.id, { rationale: 'r', packageVersion: 1 }), () => engine.reopen(other, inv.id, { reason: 'r' }),
      ]) await assert.rejects(call(), code('not_found'));
      assert.deepEqual(await engine.listInvestigations(other), []); assert.deepEqual(await engine.search(other, { q: 'harbour' }), []);
      assert.equal(await engine.inspect(other, `E08:finding:${f.id}`), null); assert.equal(await engine.inspect(other, `E08:investigation_package:${inv.id}@1`), null); assert.equal(await engine.inspect(other, attempt.ref), null);
      assert.deepEqual((await engine.applyUpstreamChange(other, { eventId: 'x-1', kind: 'claim_changed', refs: ['E07:claim:claim-a'], reason: 'r' })).affected, []);
      assert.deepEqual(await engine.audit(other), []);
    }
    assert.deepEqual(await engine.events(ctx({ tenantId: 't2' })), []);
    assert.equal((await engine.get(ctx(), 'finding', f.id)).stale, false, 'a foreign upstream change touched nothing');
    assert.equal((await engine.getJob(ctx(), exec.jobId)).state, 'queued', 'a foreign cancel touched nothing');
    // the same idempotency key in another tenant is independent
    assert.notEqual((await openBasic(engine, ctx({ tenantId: 't2' }), { idempotencyKey: 'open-1' })).id, inv.id);

    // compartments: hidden investigations are indistinguishable from missing ones
    await assert.rejects(openBasic(engine, ctx(), { compartment: 'sealed' }), code('forbidden'));
    const sealed = await openBasic(engine, ctx({ compartments: ['sealed'] }), { compartment: 'sealed', title: 'Sealed harbour inquiry' });
    const sq = await engine.addQuestion(ctx({ compartments: ['sealed'] }), sealed.id, { text: 'Sealed harbour question', material: false });
    await assert.rejects(engine.getInvestigation(ctx(), sealed.id), code('not_found')); await assert.rejects(engine.get(ctx(), 'question', sq.id), code('not_found'));
    await assert.rejects(engine.addQuestion(ctx(), sealed.id, { text: 'x', material: false }), code('not_found'));
    assert.ok(!(await engine.listInvestigations(ctx())).some((i) => i.id === sealed.id)); assert.ok(!(await engine.search(ctx(), { q: 'Sealed harbour' })).length);
    assert.equal(await engine.inspect(ctx(), `E08:question:${sq.id}`), null);
    assert.equal((await engine.search(ctx({ compartments: ['sealed'] }), { q: 'Sealed harbour' })).length, 2);

    // fail closed: no capability, wrong engine's wildcard, malformed context
    const none = ctx({ capabilities: [] }), wrong = ctx({ capabilities: ['knowledge:*', 'evidence:read'] });
    for (const c of [none, wrong]) for (const call of [() => engine.getInvestigation(c, inv.id), () => engine.search(c, { q: 'harbour' }), () => engine.inspect(c, `E08:finding:${f.id}`), () => engine.audit(c), () => engine.events(c), () => engine.applyUpstreamChange(c, { eventId: 'e', kind: 'claim_changed', refs: [], reason: 'r' }), () => engine.addQuestion(c, inv.id, { text: 'x', material: false }), () => engine.planNextSteps(c, inv.id), () => engine.buildPackage(c, inv.id), () => openBasic(engine, c)]) await assert.rejects(call(), code('forbidden'));
    await assert.rejects(engine.getInvestigation(undefined as never, inv.id), code('unauthenticated'));
    await assert.rejects(engine.addQuestion(ctx({ capabilities: ['investigation:read'] }), inv.id, { text: 'x', material: false }), code('forbidden'));

    // history is append-only in the database itself, and the audit chain verifies
    await assert.rejects(sql.query(`update ${SCHEMA}.attempts set outcome='succeeded'`), /append-only/);
    await assert.rejects(sql.query(`delete from ${SCHEMA}.record_revisions`), /append-only/);
    await assert.rejects(sql.query(`update ${SCHEMA}.packages set markdown='x'`), /immutable/); await assert.rejects(sql.query(`delete from ${SCHEMA}.packages`), /retained/);
    assert.ok(kit.verifyAuditChain(await kit.listAudit(sql, SCHEMA, ctx(), { allProjects: true, limit: 1000 })));
    assert.ok((await engine.audit(ctx(), { subject: `E08:finding:${f.id}` })).length >= 3);
  });
});

test('engine: HTTP end to end', needsPg, async () => {
  await withEngine(async ({ engine, ports }) => {
    ports.evidence.versions.set(EV1, { sha256: 'c'.repeat(64), filename: 'ledger.pdf', origin: { source: 'archive' }, custody: 'Received and hashed' });
    const key = kit.generateSigningKey('k1'), now = Math.floor(Date.now() / 1000);
    const token = (sub: string, caps: string[], tid = 't1') => kit.signAccessToken({ iss: 'iap', sub, kind: 'human', tid, pid: 'p1', roles: [], caps, cmp: [], purpose: 'investigation', pv: '1', iat: now, exp: now + 300, jti: `${sub}-${tid}` }, key);
    const server = await kit.serve(kit.createHttpHandler({ name: manifest.name, version: manifest.version, routes: routes(engine), verify: kit.createTokenVerifier({ publicKeys: { k1: key.publicKeyPem }, issuer: 'iap' }), health: () => engine.health() }), 0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const as = (sub: string, caps: string[] = ALL, tid = 't1') => kit.engineClient(base, () => token(sub, caps, tid));
    const researcher = as('researcher-1', ALL.filter((c) => c !== 'investigation:approve')), reviewer = as('reviewer-1'), stranger = as('stranger', ALL, 't2');
    try {
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
      assert.equal(((await (await fetch(`${base}/v1/manifest`)).json()) as { id: string }).id, 'E08');
      assert.equal((await fetch(`${base}/v1/investigations`)).status, 401);
      const created = await fetch(`${base}/v1/investigations`, { method: 'POST', headers: { authorization: `Bearer ${token('researcher-1', ALL)}`, 'content-type': 'application/json', 'idempotency-key': 'http-open' }, body: JSON.stringify({ title: 'Harbour contract', originRef: 'E00:objective:obj-1', scopeStatement: 'Tender compliance of the 2019 contract', originalAccount: { summary: 'A clerk reports no tender.' } }) });
      assert.equal(created.status, 201);
      const inv = await created.json() as { id: string };
      const replay = await researcher.call<{ id: string }>('POST', '/v1/investigations', { title: 'Harbour contract', originRef: 'E00:objective:obj-1', scopeStatement: 'Tender compliance of the 2019 contract', originalAccount: { summary: 'A clerk reports no tender.' }, idempotencyKey: 'http-open' });
      assert.equal(replay.id, inv.id);
      const q = await researcher.call<{ id: string }>('POST', `/v1/investigations/${inv.id}/questions`, { text: 'Was a tender published?', material: true, whyMaterial: 'Core.' });
      await researcher.call('POST', `/v1/questions/${q.id}/hypotheses`, { explanation: 'No tender was published.' });
      const plan = await researcher.call<{ steps: { id: string; data: StepData }[] }>('POST', `/v1/investigations/${inv.id}/plan`);
      const s = plan.steps.find((x) => x.data.action === 'discovery.search_source')!;
      const run = await researcher.call<{ jobId: string }>('POST', `/v1/steps/${s.id}/execute`, {});
      await engine.runJobs({ worker: 'http' });
      assert.equal((await researcher.call<{ state: string }>('GET', `/v1/jobs/${run.jobId}`)).state, 'done');
      assert.equal((await researcher.call<unknown[]>('GET', `/v1/investigations/${inv.id}/attempts?notObtained=true`)).length, 1);
      const f = await researcher.call<{ id: string }>('POST', `/v1/investigations/${inv.id}/findings`, { statement: 'No tender notice was published.', label: 'verified_fact', classification: 'established', questionIds: [q.id], supporting: [{ ref: EV1, selector: { page: 4 } }], limitations: ['Only 2019 issues were checked.'], confidence: { level: 'probable', basis: 'One primary record.' }, checklist: CHECKLIST_DONE });
      await researcher.call('POST', `/v1/findings/${f.id}/submit`, {});
      await assert.rejects(researcher.call('POST', `/v1/findings/${f.id}/review`, { decision: 'approve' }), code('forbidden'));
      assert.equal((await reviewer.call<{ state: string }>('POST', `/v1/findings/${f.id}/review`, { decision: 'approve' })).state, 'approved');
      await assert.rejects(reviewer.call('POST', `/v1/investigations/${inv.id}/close`, { rationale: 'Done', packageVersion: 1 }), code('invalid_state'));
      await researcher.call('POST', `/v1/questions/${q.id}/answers`, { answer: 'No.', answerLabel: 'verified_fact', findingIds: [f.id] });
      const pkg = await researcher.call<{ version: number; digest: string }>('POST', `/v1/investigations/${inv.id}/packages`, {});
      const md = await fetch(`${base}/v1/investigations/${inv.id}/packages/latest?format=markdown`, { headers: { authorization: `Bearer ${token('researcher-1', ALL)}` } });
      assert.match(md.headers.get('content-type')!, /text\/markdown/); assert.ok((await md.text()).includes(pkg.digest));
      const html = await fetch(`${base}/v1/investigations/${inv.id}/packages/${pkg.version}?format=html`, { headers: { authorization: `Bearer ${token('researcher-1', ALL)}` } });
      assert.match(html.headers.get('content-type')!, /text\/html/); assert.match(html.headers.get('content-security-policy')!, /default-src 'none'/);
      assert.equal((await reviewer.call<{ ready: boolean }>('GET', `/v1/investigations/${inv.id}/closure-check`)).ready, true);
      assert.equal((await reviewer.call<{ state: string }>('POST', `/v1/investigations/${inv.id}/close`, { rationale: 'Answered.', packageVersion: pkg.version })).state, 'closed');
      assert.equal((await researcher.call<{ state: string }>('POST', `/v1/investigations/${inv.id}/reopen`, { reason: 'New ledger.' })).state, 'open');
      assert.equal((await researcher.call<{ affected: string[] }>('POST', '/v1/upstream-changes', { eventId: 'h-1', kind: 'source_corrected', refs: [EV1], reason: 'Re-scan' })).affected.length, 2);
      assert.equal((await researcher.call<{ stale: boolean }>('GET', `/v1/inspect?ref=${encodeURIComponent(`E08:finding:${f.id}`)}`)).stale, true);
      assert.equal((await researcher.call<unknown[]>('GET', '/v1/search?q=tender')).length > 0, true);
      assert.equal((await researcher.call<{ lanes: unknown[] }>('GET', `/v1/investigations/${inv.id}/effort`)).lanes.length, 2);
      assert.equal((await researcher.call<{ questions: unknown[] }>('GET', `/v1/investigations/${inv.id}/overview`)).questions.length, 1);
      // other tenant, missing capability, malformed input
      for (const path of [`/v1/investigations/${inv.id}`, `/v1/investigations/${inv.id}/overview`, `/v1/investigations/${inv.id}/packages/latest`, `/v1/records/finding/${f.id}`, `/v1/jobs/${run.jobId}`, `/v1/inspect?ref=${encodeURIComponent(`E08:finding:${f.id}`)}`]) await assert.rejects(stranger.call('GET', path), code('not_found'));
      assert.deepEqual(await stranger.call('GET', '/v1/search?q=tender'), []); assert.deepEqual(await stranger.call('GET', '/v1/investigations'), []);
      await assert.rejects(as('reader', ['investigation:read']).call('POST', `/v1/investigations/${inv.id}/questions`, { text: 'x', material: false }), code('forbidden'));
      await assert.rejects(as('reader', ['investigation:read']).call('GET', '/v1/events'), code('forbidden'));
      const badReq = await fetch(`${base}/v1/investigations/${inv.id}/questions`, { method: 'POST', headers: { authorization: `Bearer ${token('researcher-1', ALL)}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'No flag' }) });
      assert.equal(badReq.status, 400);
      assert.equal((await fetch(`${base}/v1/records/bogus/${f.id}`, { headers: { authorization: `Bearer ${token('researcher-1', ALL)}` } })).status, 400);
    } finally { server.close(); }
  });
});
