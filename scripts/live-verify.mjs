#!/usr/bin/env node
// Opt-in verification of a deployed E08 service (standalone `npm run serve`, or the same routes mounted by a host).
// Skips (exit 0, "SKIPPED") unless E08_LIVE_BASE_URL and E08_LIVE_TOKEN are both set. Never prints the token.
//
//   E08_LIVE_BASE_URL  base URL of the deployed engine, e.g. https://<host>[/prefix]
//   E08_LIVE_TOKEN     bearer access token issued by the Identity engine for a sandbox tenant/project,
//                      with investigation:read (and investigation:write, investigation:plan for the write probe)
//   E08_LIVE_WRITE     "1" to also run the write probe: opens one clearly fictional investigation in the token's
//                      project, adds a question and explanation, plans, reads views and builds a package. It sends
//                      nothing to anyone and calls no paid service; records are append-only and remain as evidence.
//
// Exit codes: 0 passed or skipped, 1 a check failed.
const base = (process.env.E08_LIVE_BASE_URL ?? '').replace(/\/+$/, '');
const token = process.env.E08_LIVE_TOKEN ?? '';
const write = process.env.E08_LIVE_WRITE === '1';
const timeoutMs = Number(process.env.E08_LIVE_TIMEOUT_MS ?? 30000);

if (base === '' || token === '') {
  console.log('SKIPPED: E08_LIVE_BASE_URL and E08_LIVE_TOKEN are not both set; no live check was made.');
  process.exit(0);
}
if (!/^https?:\/\//.test(base)) { console.error('E08_LIVE_BASE_URL must be an http(s) URL'); process.exit(1); }

const results = [];
const check = async (name, fn) => {
  try { const detail = await fn(); results.push({ name, ok: true, detail: detail ?? '' }); }
  catch (error) { results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
};
const call = async (method, path, { auth = true, body, raw = false } = {}) => {
  const headers = { accept: raw ? 'text/html' : 'application/json' };
  if (auth) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
};
const expect = (cond, message) => { if (!cond) throw new Error(message); };

await check('healthz answers ok', async () => {
  const r = await call('GET', '/healthz', { auth: false });
  expect(r.status === 200, `status ${r.status}`);
  const h = r.json(); expect(h.ok === true, 'health not ok');
  return `ports ${JSON.stringify(h.detail?.ports ?? {})}`;
});
await check('manifest is E08', async () => {
  const r = await call('GET', '/v1/manifest', { auth: false });
  expect(r.status === 200, `status ${r.status}`);
  const m = r.json(); expect(m.id === 'E08', `manifest id ${m.id}`);
  return `${m.name} ${m.version} kit ${m.kit}`;
});
await check('unauthenticated requests are refused', async () => {
  const r = await call('GET', '/v1/investigations', { auth: false });
  expect(r.status === 401, `status ${r.status}`);
});
await check('authenticated list answers', async () => {
  const r = await call('GET', '/v1/investigations');
  expect(r.status === 200, `status ${r.status}`);
  expect(Array.isArray(r.json()), 'not a list');
});

if (write) {
  await check('write probe: open, question, explanation, plan, views, package', async () => {
    const stamp = new Date().toISOString();
    const open = await call('POST', '/v1/investigations', { body: { title: `Live verification probe ${stamp} (fictional)`, originRef: 'E00:objective:live-verification-probe', scopeStatement: 'Fictional probe used only to verify a deployment. Not a real matter.', originalAccount: { summary: 'Fictional account for deployment verification.' }, idempotencyKey: `live-verify-${stamp}` } });
    expect(open.status === 201, `open status ${open.status}`);
    const inv = open.json();
    const q = await call('POST', `/v1/investigations/${inv.id}/questions`, { body: { text: 'Does the deployment record questions?', material: true, whyMaterial: 'Verification probe.' } });
    expect(q.status === 201, `question status ${q.status}`);
    const h = await call('POST', `/v1/questions/${q.json().id}/hypotheses`, { body: { explanation: 'It does.' } });
    expect(h.status === 201, `hypothesis status ${h.status}`);
    const plan = await call('POST', `/v1/investigations/${inv.id}/plan`);
    expect(plan.status === 200 && Array.isArray(plan.json().steps), `plan status ${plan.status}`);
    const views = await call('GET', `/v1/investigations/${inv.id}/views?format=html`, { raw: true });
    expect(views.status === 200 && !/<script/i.test(views.text), `views status ${views.status}`);
    const pkg = await call('POST', `/v1/investigations/${inv.id}/packages`, { body: {} });
    expect(pkg.status === 201 && /^[0-9a-f]{64}$/.test(pkg.json().digest), `package status ${pkg.status}`);
    return `investigation ${inv.id}, package v${pkg.json().version}`;
  });
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `LIVE VERIFICATION PASSED (${results.length} checks${write ? ', write probe included' : ', read-only'})` : `LIVE VERIFICATION FAILED (${failed} of ${results.length})`);
process.exit(failed === 0 ? 0 : 1);
