import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as kit from '../src/service-kit.ts';
import { VIEW_NAMES, createEngine, manifest, routes } from '../src/engine/index.ts';
import type { InvestigationViews } from '../src/engine/index.ts';
import { ALL, EV1, approvedFinding, code, ctx, needsPg, openBasic, withEngine } from './engine-support.ts';

test('views: question tree, hypothesis matrix, lead board, interview schedule, coverage map and findings timeline', needsPg, async () => {
  await withEngine(async ({ engine }) => {
    const inv = await openBasic(engine);
    const q1 = await engine.addQuestion(ctx(), inv.id, { text: 'Was a tender published?', material: true, whyMaterial: 'Core.' });
    const q2 = await engine.addQuestion(ctx(), inv.id, { text: 'Who approved the <payment>?', material: true, whyMaterial: 'Responsibility.', parentId: q1.id });
    const q3 = await engine.addQuestion(ctx(), inv.id, { text: 'Was the harbour dredged?', material: false });
    const h1 = await engine.addHypothesis(ctx(), q1.id, { explanation: 'No tender was published.', predictedObservations: ['No gazette notice'], contraryTest: 'A dated notice exists.' });
    const h2 = await engine.addHypothesis(ctx(), q1.id, { explanation: 'Notice misfiled.', supporting: [{ ref: EV1, selector: 'whole' }] });
    await engine.addLead(ctx(), inv.id, { kind: 'documentary', description: 'Gazette archive', priority: 2, questionIds: [q1.id] });
    const l2 = await engine.addLead(ctx(), inv.id, { kind: 'person', description: 'Former clerk', priority: 1, questionIds: [q2.id] });
    await engine.updateLead(ctx(), l2.id, { status: 'exhausted', assessment: 'Could not be located.' });
    await engine.addPlanItem(ctx(), inv.id, { kind: 'documentary_research', questionId: q1.id, hypothesisId: h1.id, description: 'Search 2019 gazette issues' });
    await engine.recordAttempt(ctx(), inv.id, { kind: 'search', target: 'land registry', method: 'portal', outcome: 'access_restricted', detail: 'Login required', questionId: q1.id });
    await engine.recordAttempt(ctx(), inv.id, { kind: 'search', target: 'archive', method: 'request', outcome: 'failed', detail: 'Timed out', questionId: q1.id });
    await engine.recordAttempt(ctx(), inv.id, { kind: 'search', target: 'archive', method: 'request', outcome: 'succeeded', detail: 'Retrieved', questionId: q1.id });
    await engine.addUnknown(ctx(), inv.id, { description: 'Date of award', whyUnknown: 'Register missing', whatWouldResolve: 'Ministry archive', questionId: q1.id });
    await engine.addInterview(ctx(), inv.id, { questionId: q2.id, interviewee: 'pseudonym B', why: 'Witness', plannedFor: '2026-05-02T09:00:00Z' });
    await engine.addInterview(ctx(), inv.id, { questionId: q1.id, interviewee: 'pseudonym A', why: 'Witness', plannedFor: '2026-04-01T09:00:00Z', consentRef: 'E11:permission:p-1@1' });
    await engine.addInterview(ctx(), inv.id, { questionId: q1.id, interviewee: 'pseudonym C', why: 'Background' });
    const f = await approvedFinding(engine, inv.id, q1.id);
    await engine.applyUpstreamChange(ctx({ id: 'router', kind: 'service' }), { eventId: 'v-1', kind: 'source_corrected', refs: [EV1], reason: 'page renumbered' });

    const v = await engine.getViews(ctx(), inv.id);
    assert.equal(v.schema, 'investigation-views/v1');
    for (const name of VIEW_NAMES) assert.ok(name in v, name);
    // Tree: q1 root (material first) with q2 nested; q3 a root.
    assert.deepEqual(v.questionTree.map((n) => n.id), [q1.id, q3.id]);
    assert.equal(v.questionTree[0]!.children[0]!.id, q2.id); assert.equal(v.questionTree[0]!.children[0]!.depth, 1);
    assert.equal(v.questionTree[0]!.hypotheses, 2);
    // Matrix: h1 has a plan item but no observation or source → planned but not yet tested; h2 has a source.
    const m1 = v.hypothesisMatrix.find((h) => h.hypothesisId === h1.id)!, m2 = v.hypothesisMatrix.find((h) => h.hypothesisId === h2.id)!;
    assert.equal(m1.planItems, 1); assert.equal(m1.tested, false); assert.equal(m1.predicted.notTested, 1); assert.equal(m1.contraryTest, 'A dated notice exists.');
    assert.equal(m2.tested, true); assert.equal(m2.supporting, 1);
    // Lead board columns in lifecycle order, sorted by priority.
    assert.deepEqual(v.leadBoard.map((c) => c.status), ['new', 'assessing', 'active', 'exhausted', 'dismissed', 'converted']);
    assert.equal(v.leadBoard.find((c) => c.status === 'exhausted')!.leads[0]!.assessment, 'Could not be located.');
    // Interview schedule: by date, unscheduled last; consent shown only as recorded/not recorded.
    assert.deepEqual(v.interviewSchedule.map((i) => i.interviewee), ['pseudonym A', 'pseudonym B', 'pseudonym C']);
    assert.equal(v.interviewSchedule[0]!.consentRecorded, true); assert.equal(v.interviewSchedule[1]!.material, true);
    assert.ok(!JSON.stringify(v.interviewSchedule).includes('E11:permission'), 'consent references are not exposed in the schedule');
    // Coverage: the restricted registry stays missing; the archive failure was later obtained and is not listed.
    const missing = v.coverageMap.missingEvidence;
    assert.ok(missing.some((m) => m.code === 'not_obtained_access_restricted' && m.description.includes('land registry')));
    assert.ok(!missing.some((m) => m.description.startsWith('search archive')), 'a later success clears an earlier failure');
    assert.ok(missing.some((m) => m.code === 'unknown_open'));
    assert.ok(missing.some((m) => m.code === 'material_question_untried' && m.questionId === q2.id));
    assert.ok(!missing.some((m) => m.questionId === q3.id && m.code === 'material_question_untried'), 'non-material questions are not flagged as untried material');
    assert.ok(missing.some((m) => m.code === 'explanation_untested' && m.ref === m1.ref));
    const c1 = v.coverageMap.questions.find((q) => q.questionId === q1.id)!;
    assert.equal(c1.attempts.succeeded, 1); assert.equal(c1.notObtained, 2); assert.equal(c1.openUnknowns, 1);
    assert.ok(v.coverageMap.effortByLane.length >= 2);
    // Timeline: opened → drafted → approved → stale, in time order.
    const events = v.findingsTimeline.map((t) => t.event);
    assert.equal(events[0], 'investigation_opened');
    for (const e of ['finding_drafted', 'finding_approved', 'finding_stale']) assert.ok(events.includes(e), e);
    assert.ok(v.findingsTimeline.filter((t) => t.findingId === f.id).length >= 3);
    const ats = v.findingsTimeline.map((t) => t.at); assert.deepEqual(ats, [...ats].sort());
    assert.equal(v.closure.ready, false);

    // Read only, scoped and authorized.
    await assert.rejects(engine.getViews(ctx({ capabilities: ['investigation:write'] }), inv.id), code('forbidden'));
    await assert.rejects(engine.getViews(ctx({ tenantId: 't2' }), inv.id), code('not_found'));
    await assert.rejects(engine.getViews(ctx({ projectId: 'p2' }), inv.id), code('not_found'));
    const secret = await openBasic(engine, ctx({ compartments: ['c-1'] }), { compartment: 'c-1' });
    await assert.rejects(engine.getViews(ctx(), secret.id), code('not_found'));
    assert.equal((await engine.getViews(ctx({ compartments: ['c-1'] }), secret.id)).investigationId, secret.id);
    const before = (await engine.audit(ctx(), { limit: 1000 })).length;
    await engine.getViews(ctx(), inv.id);
    assert.equal((await engine.audit(ctx(), { limit: 1000 })).length, before, 'views write nothing');
  });
});

test('views over HTTP: JSON and escaped, script-free HTML with a restrictive CSP', needsPg, async () => {
  await withEngine(async ({ engine }) => {
    const inv = await openBasic(engine, ctx(), { title: '<script>alert(1)</script> harbour' });
    await engine.addQuestion(ctx(), inv.id, { text: 'Was "x" <b>bold</b>?', material: false });
    const key = kit.generateSigningKey('k1'), now = Math.floor(Date.now() / 1000);
    const token = (caps: string[], tid = 't1') => kit.signAccessToken({ iss: 'iap', sub: 'researcher-1', kind: 'human', tid, pid: 'p1', roles: [], caps, cmp: [], purpose: 'investigation', pv: '1', iat: now, exp: now + 300, jti: `j-${tid}-${caps.length}` }, key);
    const server = await kit.serve(kit.createHttpHandler({ name: manifest.name, version: manifest.version, routes: routes(engine), verify: kit.createTokenVerifier({ publicKeys: { k1: key.publicKeyPem }, issuer: 'iap' }), health: () => engine.health() }), 0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const json = await fetch(`${base}/v1/investigations/${inv.id}/views`, { headers: { authorization: `Bearer ${token(ALL)}` } });
      assert.equal(json.status, 200);
      assert.equal(((await json.json()) as InvestigationViews).investigationId, inv.id);
      const html = await fetch(`${base}/v1/investigations/${inv.id}/views?format=html`, { headers: { authorization: `Bearer ${token(ALL)}` } });
      assert.equal(html.status, 200);
      assert.match(html.headers.get('content-type') ?? '', /text\/html/);
      assert.match(html.headers.get('content-security-policy') ?? '', /default-src 'none'/);
      const body = await html.text();
      assert.ok(!/<script/i.test(body), 'no script element survives');
      assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
      assert.ok(body.includes('&lt;b&gt;bold&lt;/b&gt;'));
      for (const h of ['Question tree', 'Hypothesis matrix', 'Lead board', 'Interview schedule', 'Coverage and missing evidence', 'Findings timeline']) assert.ok(body.includes(h), h);
      assert.equal((await fetch(`${base}/v1/investigations/${inv.id}/views`)).status, 401);
      assert.equal((await fetch(`${base}/v1/investigations/${inv.id}/views`, { headers: { authorization: `Bearer ${token(ALL, 't2')}` } })).status, 404);
    } finally { server.close(); }
  });
});

test('package copies: a copy lost after the database commit is restored from the stored version; blocked versions are not copied', needsPg, async () => {
  await withEngine(async ({ sql, ports }) => {
    const dir = await mkdtemp(join(tmpdir(), 'e08-objects-'));
    try {
      const objects = new kit.FsObjectStore(dir);
      const engine = createEngine({ sql, ports, objects });
      const inv = await openBasic(engine);
      const q = await engine.addQuestion(ctx(), inv.id, { text: 'Was a tender published?', material: true, whyMaterial: 'Core.' });
      await approvedFinding(engine, inv.id, q.id);
      const p1 = await engine.buildPackage(ctx(), inv.id);
      const base = `t1/p1/investigation/${inv.id}/package-v${p1.version}`;
      assert.ok(await objects.head(`${base}.json`) !== null);
      // Simulate an interruption between the commit and the object copy.
      await objects.delete(`${base}.html`); await objects.delete(`${base}.json`);
      await assert.rejects(engine.syncPackageCopies(ctx({ capabilities: ['investigation:read'] }), inv.id), code('forbidden'));
      await assert.rejects(engine.syncPackageCopies(ctx({ tenantId: 't2' }), inv.id), code('not_found'));
      const r = await engine.syncPackageCopies(ctx(), inv.id);
      assert.equal(r.checked, 1); assert.deepEqual(r.restored.sort(), [`${base}.html`, `${base}.json`]);
      const restored = JSON.parse(new TextDecoder().decode(await objects.get(`${base}.json`))) as { digest: string };
      assert.equal(restored.digest, p1.digest);
      assert.equal(new TextDecoder().decode(await objects.get(`${base}.html`)), p1.html);
      assert.deepEqual((await engine.syncPackageCopies(ctx(), inv.id)).restored, [], 'idempotent');
      assert.ok((await engine.audit(ctx(), { limit: 1000 })).some((a) => a.action === 'package.copies_restored'));
      // A blocked version is withheld everywhere, including from restored copies.
      await engine.applyUpstreamChange(ctx({ id: 'router', kind: 'service' }), { eventId: 'pc-1', kind: 'permission_withdrawn', refs: [EV1], reason: 'withdrawn' });
      await objects.delete(`${base}.md`);
      const after = await engine.syncPackageCopies(ctx(), inv.id);
      assert.deepEqual(after.skippedBlocked, [p1.version]); assert.deepEqual(after.restored, []);
      assert.equal(await objects.head(`${base}.md`), null);
      // Without an object store the operation is reported unavailable, not silently skipped.
      await assert.rejects(createEngine({ sql, ports }).syncPackageCopies(ctx(), inv.id), code('unavailable'));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
