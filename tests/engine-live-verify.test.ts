// The opt-in live verification script, exercised against a local engine server (a controlled stand-in for a deployment:
// this is test infrastructure, not live-provider proof).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import * as kit from '../src/service-kit.ts';
import { manifest, routes } from '../src/engine/index.ts';
import { ALL, needsPg, withEngine } from './engine-support.ts';

const SCRIPT = fileURLToPath(new URL('../scripts/live-verify.mjs', import.meta.url));
const run = (env: Record<string, string>): Promise<{ code: number; out: string }> => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH ?? '', ...env } }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : (error as { code?: number }).code ?? 1, out: stdout + stderr }));
});

test('live-verify: skips visibly without configuration', async () => {
  const r = await run({});
  assert.equal(r.code, 0); assert.match(r.out, /^SKIPPED/);
  assert.match((await run({ E08_LIVE_BASE_URL: 'http://127.0.0.1:1' })).out, /^SKIPPED/);
});

test('live-verify: passes against a working engine (read-only and write probe) and fails against a wrong service', needsPg, async () => {
  await withEngine(async ({ engine }) => {
    const key = kit.generateSigningKey('lv'), now = Math.floor(Date.now() / 1000);
    const token = kit.signAccessToken({ iss: 'iap', sub: 'probe', kind: 'human', tid: 't1', pid: 'sandbox', roles: [], caps: ALL, cmp: [], purpose: 'investigation', pv: '1', iat: now, exp: now + 300, jti: 'lv' }, key);
    const server = await kit.serve(kit.createHttpHandler({ name: manifest.name, version: manifest.version, routes: routes(engine), verify: kit.createTokenVerifier({ publicKeys: { lv: key.publicKeyPem }, issuer: 'iap' }), health: () => engine.health() }), 0);
    const wrong = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"id":"E99"}'); });
    await new Promise<void>((r) => wrong.listen(0, '127.0.0.1', () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const ro = await run({ E08_LIVE_BASE_URL: base, E08_LIVE_TOKEN: token });
      assert.equal(ro.code, 0, ro.out); assert.match(ro.out, /LIVE VERIFICATION PASSED \(4 checks, read-only\)/);
      assert.ok(!ro.out.includes(token), 'the token is never printed');
      const rw = await run({ E08_LIVE_BASE_URL: `${base}/`, E08_LIVE_TOKEN: token, E08_LIVE_WRITE: '1' });
      assert.equal(rw.code, 0, rw.out); assert.match(rw.out, /write probe included/);
      const listed = await engine.listInvestigations({ tenantId: 't1', projectId: 'sandbox', purpose: 'investigation', requestId: 'x', now: new Date().toISOString(), actor: { id: 'probe', kind: 'human', roles: [] }, capabilities: ALL, compartments: [] });
      assert.equal(listed.length, 1); assert.match(listed[0]!.data.title, /fictional/);
      const bad = await run({ E08_LIVE_BASE_URL: `http://127.0.0.1:${(wrong.address() as { port: number }).port}`, E08_LIVE_TOKEN: token });
      assert.equal(bad.code, 1); assert.match(bad.out, /FAIL manifest is E08/); assert.match(bad.out, /FAIL unauthenticated requests are refused/);
    } finally { server.close(); wrong.close(); }
  });
});
