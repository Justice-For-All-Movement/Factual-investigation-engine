// Automated check of the standalone server (`npm run serve`): configuration refusal, migrations, HTTP surface,
// token verification, the job worker loop with no collaborator ports, and clean shutdown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as kit from '../src/service-kit.ts';
import { ALL, ADMIN, needsPg } from './engine-support.ts';

const SERVE = fileURLToPath(new URL('../src/engine/serve.ts', import.meta.url));
type Proc = { child: ReturnType<typeof spawn>; out: string[]; err: string[]; exited: Promise<number | null> };
function start(env: Record<string, string>): Proc {
  const child = spawn(process.execPath, [SERVE], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out: string[] = [], err: string[] = [];
  child.stdout!.on('data', (d: Buffer) => out.push(d.toString()));
  child.stderr!.on('data', (d: Buffer) => err.push(d.toString()));
  return { child, out, err, exited: new Promise((resolve) => child.on('exit', (c) => resolve(c))) };
}
async function listening(p: Proc): Promise<number> {
  for (let i = 0; i < 300; i++) {
    const line = p.out.join('').split('\n').find((l) => l.includes('listening'));
    if (line !== undefined) return (JSON.parse(line) as { address: { port: number } }).address.port;
    if (p.child.exitCode !== null) throw new Error(`server exited early: ${p.err.join('')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

test('serve: refuses to start without a database or without token verification keys', async () => {
  const a = start({});
  assert.equal(await a.exited, 1); assert.match(a.err.join(''), /DATABASE_URL is required/);
  const b = start({ DATABASE_URL: 'postgresql://unused@127.0.0.1:1/none' });
  assert.equal(await b.exited, 1); assert.match(b.err.join(''), /IDENTITY_PUBLIC_KEYS or IDENTITY_JWKS_FILE is required/);
});

test('serve: migrates, serves the authenticated API, runs the worker standalone and stops cleanly', needsPg, async () => {
  const pg = (await import('pg')).default;
  await kit.withDisposableDatabase(pg, ADMIN, async (url) => {
    const key = kit.generateSigningKey('srv'), now = Math.floor(Date.now() / 1000);
    const token = (tid = 't1') => kit.signAccessToken({ iss: 'iap', sub: 'researcher-1', kind: 'human', tid, pid: 'p1', roles: [], caps: ALL, cmp: [], purpose: 'investigation', pv: '1', iat: now, exp: now + 300, jti: `srv-${tid}` }, key);
    const p = start({ DATABASE_URL: url, PORT: '0', IDENTITY_PUBLIC_KEYS: JSON.stringify({ srv: key.publicKeyPem }), IDENTITY_ISSUER: 'iap', INVESTIGATION_WORKER_INTERVAL_MS: '100' });
    try {
      const base = `http://127.0.0.1:${await listening(p)}`;
      const health = await fetch(`${base}/healthz`);
      assert.equal(health.status, 200);
      const detail = (await health.json() as { ok: boolean; detail: { ports: Record<string, string> } });
      assert.equal(detail.ok, true); assert.equal(detail.detail.ports.discovery, 'unavailable', 'standalone reports absent ports');
      assert.equal(((await (await fetch(`${base}/v1/manifest`)).json()) as { id: string }).id, 'E08');
      assert.equal((await fetch(`${base}/v1/investigations`)).status, 401);
      const forged = kit.signAccessToken({ iss: 'iap', sub: 'x', kind: 'human', tid: 't1', pid: 'p1', roles: [], caps: ALL, cmp: [], purpose: 'investigation', pv: '1', iat: now, exp: now + 300, jti: 'forged' }, kit.generateSigningKey('srv'));
      assert.equal((await fetch(`${base}/v1/investigations`, { headers: { authorization: `Bearer ${forged}` } })).status, 401, 'a token signed by another key is refused');
      const client = kit.engineClient(base, () => token());
      const inv = await client.call<{ id: string }>('POST', '/v1/investigations', { title: 'Harbour contract', originRef: 'E00:objective:obj-1', scopeStatement: 'Tender compliance', originalAccount: { summary: 'A clerk reports no tender.' } });
      const q = await client.call<{ id: string }>('POST', `/v1/investigations/${inv.id}/questions`, { text: 'Was a tender published?', material: true, whyMaterial: 'Core.' });
      await client.call('POST', `/v1/questions/${q.id}/hypotheses`, { explanation: 'No tender was published.' });
      const plan = await client.call<{ steps: { id: string; data: { action: string } }[] }>('POST', `/v1/investigations/${inv.id}/plan`);
      const search = plan.steps.find((s) => s.data.action === 'discovery.search_source');
      assert.ok(search, 'planner proposes a first search');
      const run = await client.call<{ jobId: string }>('POST', `/v1/steps/${search.id}/execute`, {});
      let state = '';
      for (let i = 0; i < 100 && state !== 'done'; i++) { state = (await client.call<{ state: string }>('GET', `/v1/jobs/${run.jobId}`)).state; if (state !== 'done') await new Promise((r) => setTimeout(r, 100)); }
      assert.equal(state, 'done', 'the server worker loop ran the job');
      const attempts = await client.call<{ outcome: string; detail: string }[]>('GET', `/v1/investigations/${inv.id}/attempts?notObtained=true`);
      assert.equal(attempts.length, 1); assert.equal(attempts[0]!.outcome, 'unavailable'); assert.match(attempts[0]!.detail, /not configured/);
      const views = await fetch(`${base}/v1/investigations/${inv.id}/views?format=html`, { headers: { authorization: `Bearer ${token()}` } });
      assert.equal(views.status, 200);
      assert.equal((await fetch(`${base}/v1/investigations/${inv.id}`, { headers: { authorization: `Bearer ${token('t2')}` } })).status, 404);
      p.child.kill('SIGTERM');
      assert.equal(await p.exited, 0, 'SIGTERM stops the server and worker cleanly');
      assert.ok(!p.err.join('').includes('"level":"error"'), p.err.join(''));
    } finally { if (p.child.exitCode === null) { p.child.kill('SIGKILL'); await p.exited; } }
  });
});
