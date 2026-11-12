import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./correction-impact-http-fixture.ts";
import { c } from "./disposition-identity-fixture.ts";
import { createCorrectionImpactReadHandler } from "../src/correction-impact-http.ts";
import { CurrentCorrectionImpactReader } from "../src/correction-impact-current.ts";
import { FactualRepository } from "../src/repository.ts";
import { scoped } from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
const origin = "https://impact.invalid",
  base = origin + "/private/correction-impact",
  csrf = "fixture-csrf-token-0000000000000000000000";
const headers = {
  origin,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
  "x-csrf-token": csrf,
};
function post(
  before: unknown,
  after: unknown,
  extra: Record<string, string> = {},
) {
  return new Request(base + "/read", {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify({ before, after }),
  });
}
async function ready(t: test.TestContext, timeout = 10000) {
  const f = await setup(t);
  let calls = 0;
  const handler = createCorrectionImpactReadHandler(
    f.reader,
    f.membership,
    {
      authenticate: async () => {
        calls++;
        return { actorId: c.actor.id, requestId: c.requestId, csrfToken: csrf };
      },
    },
    { ...f.fixed, origin, timeoutMs: timeout },
    () => c.now,
  );
  return { ...f, handler, calls: () => calls };
}
test("actual three-DB private HTTP reads bind exact correction pair and real containing editions", async (t) => {
  const f = await ready(t);
  const session = await f.handler(new Request(base + "/session"));
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    actorId: c.actor.id,
    csrfToken: csrf,
  });
  const response = await f.handler(post(f.first.record, f.second.record));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const body = await response.json();
  assert.deepEqual(body.planningStorage, f.plan.storage);
  assert.deepEqual(body.knowledgeStorage, f.second.storage);
  assert.deepEqual(body.impact.before, f.first.record);
  assert.deepEqual(body.impact.after, f.second.record);
  assert.equal(body.impact.plans[0].status, "review-required");
  assert.equal(Object.hasOwn(body, "command"), false);
  assert.equal(Object.hasOwn(body, "allowed"), false);
});
test("exact routes origins metadata body and positive scoped pair deny before host proofing", async (t) => {
  const f = await ready(t);
  for (const request of [
    post(f.first.record, f.second.record, { origin: "https://other.invalid" }),
    post({ ...f.first.record, projectId: "foreign" }, f.second.record),
    post(f.first.record, { ...f.second.record, revision: 3 }),
    post({ ...f.first.record, revision: 0 }, f.second.record),
    post(
      { ...f.first.record, kind: "case" },
      { ...f.second.record, kind: "case" },
    ),
    post(f.first.record, f.second.record, { "sec-fetch-site": "cross-site" }),
    new Request(base + "/write", { method: "POST" }),
    new Request(base + "/read", {
      method: "POST",
      headers,
      body: JSON.stringify({
        before: f.first.record,
        after: f.second.record,
        allowed: true,
      }),
    }),
  ])
    assert.notEqual((await f.handler(request)).status, 200);
  assert.equal(f.calls(), 0);
  assert.equal(
    (
      await f.handler(
        post(f.first.record, f.second.record, { "x-csrf-token": "wrong" }),
      )
    ).status,
    403,
  );
});
test("strict UTF8 bytes chunks declared length and pre-cancelled body cannot reach proofing", async (t) => {
  const f = await ready(t);
  const stream = (source: ReadableStream<Uint8Array>) =>
    new Request(base + "/read", {
      method: "POST",
      headers,
      body: source,
      duplex: "half",
    } as RequestInit);
  const bad = [
    new Request(base + "/read", {
      method: "POST",
      headers,
      body: new Uint8Array([0xff]),
    }),
    new Request(base + "/read", {
      method: "POST",
      headers,
      body: " ".repeat(1025),
    }),
    post(f.first.record, f.second.record, { "content-length": "1" }),
    stream(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < 4097; i++) controller.enqueue(new Uint8Array());
          controller.close();
        },
      }),
    ),
  ];
  const abort = new AbortController();
  abort.abort();
  bad.push(
    new Request(post(f.first.record, f.second.record), {
      signal: abort.signal,
    }),
  );
  for (const request of bad)
    assert.notEqual((await f.handler(request)).status, 200);
  assert.equal(f.calls(), 0);
});
test("stalled body precedes fresh authentication and actual resource withdrawal denies later read", async (t) => {
  const f = await ready(t);
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const request = new Request(base + "/read", {
    method: "POST",
    headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    }),
    duplex: "half",
  } as RequestInit);
  const pending = f.handler(request);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.calls(), 0);
  await f.membership.setResourcePolicy(
    c,
    2,
    { ...f.policy, memberIds: [] },
    "withdraw-before-body",
  );
  stream.enqueue(
    new TextEncoder().encode(
      JSON.stringify({ before: f.first.record, after: f.second.record }),
    ),
  );
  stream.close();
  assert.equal((await pending).status, 503);
  assert.equal(f.calls(), 1);
});
test("blocked late proofing and null session deny without read; every owned proofing signal closes", async (t) => {
  const f = await ready(t);
  let seen: AbortSignal | undefined;
  const handler = createCorrectionImpactReadHandler(
    f.reader,
    f.membership,
    {
      authenticate: async (_metadata, signal) => {
        seen = signal;
        const until = performance.now() + 80;
        while (performance.now() < until) {}
        return { actorId: c.actor.id, requestId: c.requestId, csrfToken: csrf };
      },
    },
    { ...f.fixed, origin, timeoutMs: 50 },
    () => c.now,
  );
  const response = await handler(new Request(base + "/session"));
  assert.equal(response.status, 503);
  assert.equal(seen?.aborted, true);
  assert.deepEqual(await response.json(), {
    error: "correction_impact_unavailable",
  });
  const missing = createCorrectionImpactReadHandler(
    f.reader,
    f.membership,
    { authenticate: async () => null },
    { ...f.fixed, origin },
    () => c.now,
  );
  assert.equal((await missing(new Request(base + "/session"))).status, 401);
});
test("lost actual owning read acknowledgement is private unknown; explicit later read retains audit history", async (t) => {
  const f = await ready(t);
  f.hooks.lostFactual = true;
  const unknown = await f.handler(post(f.first.record, f.second.record));
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), {
    error: "correction_impact_unavailable",
  });
  const fresh = await f.handler(post(f.first.record, f.second.record));
  assert.equal(fresh.status, 200);
  assert.deepEqual((await fresh.json()).planningStorage, f.plan.storage);
  const audits = await scoped(f.factual, c, (tx) => tx.audits());
  assert.equal(
    audits.filter((a) => a.type === "factual.correction_impact.read_checked")
      .length,
    3,
  );
});
test("HTTP overall deadline reaches actual owning checked lock and rolls back late read audit", async (t) => {
  const f = await ready(t);
  const before = await scoped(f.factual, c, (tx) => tx.audits());
  let observed = false;
  const db: Database = {
    ...f.factual,
    transaction: (fn) =>
      f.factual.transaction((q) =>
        fn({
          query: async <T>(sql: string, values?: unknown[]) => {
            const result = await q.query<T>(sql, values);
            if (values?.includes("factual.correction_impact.read_checked")) {
              observed = true;
              const until = performance.now() + 600;
              while (performance.now() < until) {}
            }
            return result;
          },
        }),
      ),
  };
  const reader = new CurrentCorrectionImpactReader(
    new FactualRepository(db, { ...f.fixed, humanIds: [c.actor.id] }),
    f.membership,
    f.kFacade!,
    f.fixed,
  );
  const handler = createCorrectionImpactReadHandler(
    reader,
    f.membership,
    {
      authenticate: async () => ({
        actorId: c.actor.id,
        requestId: c.requestId,
        csrfToken: csrf,
      }),
    },
    { ...f.fixed, origin, timeoutMs: 500 },
    () => c.now,
  );
  assert.equal(
    (await handler(post(f.first.record, f.second.record))).status,
    503,
  );
  assert(observed);
  assert.deepEqual(await scoped(f.factual, c, (tx) => tx.audits()), before);
});
