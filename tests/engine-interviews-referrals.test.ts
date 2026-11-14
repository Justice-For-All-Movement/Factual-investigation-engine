import test from 'node:test';
import assert from 'node:assert/strict';
import type { InterviewData, ReferralData } from '../src/engine/model.ts';
import { EV1, EV3, approvedFinding, code, ctx, eventsOf, needsPg, openBasic, withEngine } from './engine-support.ts';

test('interview plans: planned → held with outcome; a pending interview on a material question blocks closure; nothing is contacted', needsPg, async () => {
  await withEngine(async ({ engine, ports }) => {
    const inv = await openBasic(engine);
    const q = await engine.addQuestion(ctx(), inv.id, { text: 'Who signed the contract?', material: true, whyMaterial: 'Responsibility.' });
    await assert.rejects(engine.addInterview(ctx(), inv.id, { questionId: q.id, interviewee: 'clerk at clerk@example.org', why: 'x' }), code('invalid_input'), 'no contact details in the plan');
    await assert.rejects(engine.addInterview(ctx({ capabilities: ['investigation:read'] }), inv.id, { questionId: q.id, interviewee: 'former clerk (pseudonym K)', why: 'x' }), code('forbidden'));
    const iv = await engine.addInterview(ctx(), inv.id, { questionId: q.id, interviewee: 'former procurement clerk (pseudonym K)', why: 'Handled the file in 2019', topics: ['who approved the award?'], channel: 'in person', plannedFor: '2026-03-01T10:00:00Z', idempotencyKey: 'iv-1' });
    assert.equal(iv.state, 'planned');
    assert.equal((await engine.addInterview(ctx(), inv.id, { questionId: q.id, interviewee: 'former procurement clerk (pseudonym K)', why: 'Handled the file in 2019', topics: ['who approved the award?'], channel: 'in person', plannedFor: '2026-03-01T10:00:00Z', idempotencyKey: 'iv-1' })).id, iv.id, 'idempotent');
    assert.equal(ports.correspondence.plans.size + ports.correspondence.drafts.size, 0, 'planning an interview contacts nobody');
    const blocked = await engine.closureCheck(ctx(), inv.id);
    assert.ok(blocked.blockers.some((b) => b.code === 'interview_pending' && b.ref.startsWith(`E08:interview:${iv.id}`)));
    await assert.rejects(engine.updateInterview(ctx(), iv.id, { status: 'held' }), code('invalid_input'), 'an outcome needs a note');
    const held = await engine.updateInterview(ctx(), iv.id, { status: 'held', outcomeNote: 'Confirmed the deputy signed; provided a scan.', outcomeRefs: [EV3] });
    assert.equal(held.state, 'held'); assert.deepEqual([...(held.data as InterviewData).outcomeRefs], [EV3]);
    await assert.rejects(engine.updateInterview(ctx(), iv.id, { status: 'cancelled', outcomeNote: 'n' }), code('invalid_state'), 'an outcome is not rewritten');
    assert.ok(!(await engine.closureCheck(ctx(), inv.id)).blockers.some((b) => b.code === 'interview_pending'));
    // A correction to the source the outcome cites flags the interview, without rewriting it.
    const applied = await engine.applyUpstreamChange(ctx({ id: 'router', kind: 'service' }), { eventId: 'iv-evt', kind: 'source_corrected', refs: [EV3], reason: 'transcript corrected' });
    assert.ok(applied.affected.some((r) => r.startsWith(`E08:interview:${iv.id}`)));
    const flagged = await engine.get<InterviewData>(ctx(), 'interview', iv.id);
    assert.equal(flagged.stale, true); assert.equal(flagged.state, 'held'); assert.equal(flagged.revision, held.revision);
    const pkg = await engine.buildPackage(ctx(), inv.id);
    const listed = (pkg.content!.interviews as { id: string; status: string; stale: boolean }[]).find((x) => x.id === iv.id)!;
    assert.equal(listed.status, 'held'); assert.equal(listed.stale, true);
    const events = await eventsOf(engine, ctx(), ['investigation.interview_planned', 'investigation.interview_held', 'investigation.interview_stale']);
    for (const t of ['investigation.interview_planned', 'investigation.interview_held', 'investigation.interview_stale']) assert.ok(events.some((e) => e.type === t), t);
  });
});

test('referral recommendations: proposed → approved by a person on approved findings; finding change makes it stale; nothing is sent', needsPg, async () => {
  await withEngine(async ({ engine }) => {
    const inv = await openBasic(engine);
    const q = await engine.addQuestion(ctx(), inv.id, { text: 'Was a tender published?', material: true, whyMaterial: 'Core.' });
    const f = await approvedFinding(engine, inv.id, q.id);
    await assert.rejects(engine.proposeReferral(ctx(), inv.id, { recipientType: 'oversight body', requestedAction: 'Review the award', summary: 's', basisFindingIds: [] }), code('invalid_input'));
    await assert.rejects(engine.proposeReferral(ctx(), inv.id, { recipientType: 'oversight body', requestedAction: 'Review the award', summary: 's', basisFindingIds: ['missing'] }), code('invalid_input'));
    const r = await engine.proposeReferral(ctx(), inv.id, { recipientType: 'public procurement oversight body', requestedAction: 'Review whether the award followed the published rules', summary: 'No tender notice was published before the award.', basisFindingIds: [f.id], limitations: ['Only the 2019 gazette was searched'] });
    assert.equal(r.state, 'proposed');
    assert.ok((await engine.closureCheck(ctx(), inv.id)).warnings.some((w) => w.code === 'referral_undecided'));
    await assert.rejects(engine.decideReferral(ctx({ id: 'bot', kind: 'agent' }), r.id, { decision: 'approve' }), code('forbidden'), 'agents cannot decide');
    await assert.rejects(engine.decideReferral(ctx({ capabilities: ['investigation:read', 'investigation:write'] }), r.id, { decision: 'approve' }), code('forbidden'), 'needs investigation:approve');
    await assert.rejects(engine.decideReferral(ctx(), r.id, { decision: 'reject' }), code('invalid_input'), 'rejection needs a rationale');
    const ok = await engine.decideReferral(ctx({ id: 'lead-1' }), r.id, { decision: 'approve', rationale: 'Findings are solid' });
    assert.equal(ok.state, 'approved'); assert.equal((ok.data as ReferralData).decision?.by, 'lead-1');
    // The finding's source is corrected: the finding and the referral resting on it become stale; closure is blocked until re-decided.
    const applied = await engine.applyUpstreamChange(ctx({ id: 'router', kind: 'service' }), { eventId: 'ref-evt', kind: 'source_corrected', refs: [EV1], reason: 'ledger re-scanned' });
    assert.ok(applied.affected.some((x) => x.startsWith(`E08:referral:${r.id}`)));
    const stale = await engine.get<ReferralData>(ctx(), 'referral', r.id);
    assert.equal(stale.stale, true); assert.equal(stale.state, 'approved');
    assert.ok((await engine.closureCheck(ctx(), inv.id)).blockers.some((b) => b.code === 'referral_stale'));
    await assert.rejects(engine.decideReferral(ctx({ id: 'lead-1' }), r.id, { decision: 'approve' }), code('invalid_state'), 'cannot re-approve while the basis finding is stale');
    await engine.reviewFinding(ctx({ id: 'reviewer-1' }), f.id, { decision: 'approve', notes: 'Correction does not change it.' });
    const renewed = await engine.decideReferral(ctx({ id: 'lead-1' }), r.id, { decision: 'approve', rationale: 'Re-checked after the correction' });
    assert.equal(renewed.stale, false);
    const pkg = await engine.buildPackage(ctx(), inv.id);
    const rec = (pkg.content!.referralRecommendations as { id: string; status: string; note: string }[]).find((x) => x.id === r.id)!;
    assert.equal(rec.status, 'approved'); assert.match(rec.note, /Nothing has been sent/);
    // Other organizations see nothing.
    await assert.rejects(engine.get(ctx({ tenantId: 'other-org' }), 'referral', r.id), code('not_found'));
  });
});
