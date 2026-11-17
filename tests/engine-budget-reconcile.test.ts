import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/contracts.ts';
import type { StepData } from '../src/engine/index.ts';
import { ctx, needsPg, openBasic, withEngine } from './engine-support.ts';

test('budget: an uncertain run is charged once; reconciling re-runs reuse that charge and a definite non-effect is flagged for correction', needsPg, async () => {
  await withEngine(async ({ ports, make }) => {
    const engine = make(ports, { stepCosts: { 'discovery.start_collection': { category: 'acquisition', amount: 10, unit: 'credits' } } });
    const inv = await openBasic(engine);
    const q = await engine.addQuestion(ctx(), inv.id, { text: 'Was a tender published?', material: true, whyMaterial: 'Core.' });
    const mk = async (query: string) => { const item = await engine.addPlanItem(ctx(), inv.id, { kind: 'documentary_research', questionId: q.id, description: `Collect ${query}`, action: 'discovery.start_collection', params: { query } }); return (await engine.planNextSteps(ctx(), inv.id)).steps.find((s) => s.data.planItemId === item.id)!; };
    const committed = () => [...ports.budget.reserved.values()].filter((r) => r.state === 'committed');

    // uncertain → reconciled as succeeded: one charge in total.
    const s1 = await mk('award decisions');
    ports.discovery.failNextStart = 'after';
    await engine.executeStep(ctx(), s1.id); await engine.runJobs({ worker: 'w' });
    const u = await engine.get<StepData>(ctx(), 'step', s1.id);
    assert.equal(u.state, 'uncertain'); assert.equal(u.data.uncertainCharge?.amount, 10); assert.equal(committed().length, 1);
    await engine.executeStep(ctx(), s1.id); await engine.runJobs({ worker: 'w' });
    const done = await engine.get<StepData>(ctx(), 'step', s1.id);
    assert.equal(done.state, 'done'); assert.equal(done.data.uncertainCharge, null);
    assert.equal(ports.budget.reserved.size, 1, 'no second reservation'); assert.equal(committed().length, 1);
    const a1 = (await engine.listAttempts(ctx(), inv.id)).filter((a) => a.stepId === s1.id);
    assert.deepEqual(a1.map((a) => a.outcome), ['uncertain', 'succeeded']);
    assert.match(a1[1]!.detail, /not charged again/);
    assert.equal(a1[0]!.effort.costUnits, 10); assert.equal(a1[1]!.effort.costUnits, 1, 'only the provider-reported effort, no second budget charge');

    // uncertain → uncertain again: still the one charge, kept for the next reconciliation.
    const s2 = await mk('payment schedules');
    ports.discovery.failNextStart = 'after';
    await engine.executeStep(ctx(), s2.id); await engine.runJobs({ worker: 'w' });
    ports.discovery.failNextStart = 'after';
    await engine.executeStep(ctx(), s2.id); await engine.runJobs({ worker: 'w' });
    const still = await engine.get<StepData>(ctx(), 'step', s2.id);
    assert.equal(still.state, 'uncertain'); assert.equal(still.data.uncertainCharge?.run, 1);
    assert.equal(ports.budget.reserved.size, 2);

    // uncertain → definite refusal: the committed charge was not incurred; the attempt says so for the budget engine.
    const original = ports.discovery.startCollectionRun.bind(ports.discovery);
    ports.discovery.startCollectionRun = async () => { throw new DomainError('forbidden', 'Provider refused the run'); };
    await engine.executeStep(ctx(), s2.id); await engine.runJobs({ worker: 'w' });
    ports.discovery.startCollectionRun = original;
    const refused = await engine.get<StepData>(ctx(), 'step', s2.id);
    assert.equal(refused.data.lastOutcome, 'refused'); assert.equal(refused.data.uncertainCharge, null);
    assert.equal(ports.budget.reserved.size, 2, 'no reservation for the reconciling run');
    const last = (await engine.listAttempts(ctx(), inv.id)).filter((a) => a.stepId === s2.id).at(-1)!;
    assert.match(last.detail, /must be corrected in the budget engine/);

    // A later fresh run after the definite outcome reserves normally again.
    await engine.executeStep(ctx(), s2.id); await engine.runJobs({ worker: 'w' });
    assert.equal(ports.budget.reserved.size, 3);
    assert.equal((await engine.get<StepData>(ctx(), 'step', s2.id)).state, 'done');
  });
});
