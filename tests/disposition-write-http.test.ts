import test from "node:test";
import assert from "node:assert/strict";
import { fixture, input, c } from "./disposition-identity-fixture.ts";
import { QuestionDispositionRepository } from "../src/disposition-repository.ts";
import { IdentityQuestionDispositionRepository } from "../src/disposition-identity.ts";
import { createDispositionWriteHandler } from "../src/disposition-write-http.ts";
import type { Database } from "@accountability/evidence-sql/database";
const origin = "https://write.invalid",
  base = origin + "/private/disposition-write",
  csrf = "fixture-csrf-token-0000000000000000000000";
const headers = {
  origin,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
  "x-csrf-token": csrf,
};
const post = (
  body: unknown,
  extra: Record<string, string> = {},
  signal?: AbortSignal,
) =>
  new Request(base + "/record", {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
async function ready(t: test.TestContext) {
  const f = await fixture(t),
    x = input();
  await f.membership.setResourcePolicy(c, 0, f.policy, "policy");
  const plan = await f.repo.append(c, 0, x.knowledge, x.command, "plan");
  const store = new QuestionDispositionRepository(f.factual, {
      ...f.fixed,
      humanIds: ["owner"],
    }),
    facade = new IdentityQuestionDispositionRepository(
      store,
      f.membership,
      f.fixed,
    );
  const body = {
    expectedStorageRevision: 0,
    commandId: "review",
    command: {
      planningStorage: plan.storage,
      effortStorage: null,
      review: {
        id: "review",
        expectedSequence: 0,
        supersedes: null,
        selected: plan.record,
        questions: [
          {
            questionId: "time",
            status: "deferred",
            reason: "Fixture unavailable",
            assigneeId: null,
            reviewAt: "2026-02-01T00:00:00.000Z",
          },
        ],
        reopeningTriggers: ["New authorized records"],
      },
    },
  };
  let calls = 0;
  const signals: AbortSignal[] = [];
  const provider = {
    authenticate: async (_request: unknown, signal: AbortSignal) => {
      calls++;
      signals.push(signal);
      return { actorId: c.actor.id, requestId: c.requestId, csrfToken: csrf };
    },
  };
  const handler = createDispositionWriteHandler(
    facade,
    f.membership,
    provider,
    { ...f.fixed, origin },
    () => c.now,
  );
  return {
    ...f,
    store,
    facade,
    body,
    plan,
    handler,
    provider,
    calls: () => calls,
    signals,
  };
}
test("actual write session and exact private ACK persist whole review once without read or closure routes", async (t) => {
  const f = await ready(t),
    session = await f.handler(new Request(base + "/session"));
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    actorId: c.actor.id,
    csrfToken: csrf,
  });
  const response = await f.handler(post(f.body));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const ack = await response.json();
  assert.deepEqual(Object.keys(ack).sort(), [
    "effortStorage",
    "planningStorage",
    "record",
    "storage",
  ]);
  assert.deepEqual(ack.planningStorage, f.plan.storage);
  assert.equal(ack.effortStorage, null);
  const loaded = await f.store.load(c, f.plan.record);
  assert.equal(loaded.table.questions[0]!.disposition.status, "deferred");
  assert.equal(loaded.table.history.length, 1);
  assert.equal(
    (await f.handler(new Request(base + "/read", { method: "POST" }))).status,
    404,
  );
  assert(f.signals.every((s) => s.aborted));
});
test("exact envelope command row and scoped aggregate/ref profiles deny before proofing; badCSRF never writes", async (t) => {
  const f = await ready(t);
  const variants = [
    { ...f.body, allowed: true },
    { ...f.body, expectedStorageRevision: -1 },
    { ...f.body, command: { ...f.body.command, roles: ["owner"] } },
    {
      ...f.body,
      command: {
        ...f.body.command,
        planningStorage: { ...f.plan.storage, id: "invented" },
      },
    },
    {
      ...f.body,
      command: {
        ...f.body.command,
        review: { ...f.body.command.review, closed: true },
      },
    },
    {
      ...f.body,
      command: {
        ...f.body.command,
        review: {
          ...f.body.command.review,
          selected: { ...f.plan.record, revision: 0 },
        },
      },
    },
    {
      ...f.body,
      command: {
        ...f.body.command,
        review: {
          ...f.body.command.review,
          questions: [
            { ...f.body.command.review.questions[0], status: "answered" },
          ],
        },
      },
    },
  ];
  for (const value of variants)
    assert.notEqual((await f.handler(post(value))).status, 200);
  assert.equal(f.calls(), 0);
  assert.equal(
    (await f.handler(post(f.body, { "x-csrf-token": "bad" }))).status,
    403,
  );
  assert.equal((await f.store.load(c, f.plan.record)).storage, null);
});
test("lost actual owning COMMIT yields unknown; explicit identical replay is one effect and current policy gates cached ACK", async (t) => {
  const f = await ready(t);
  f.hooks.lostFactual = true;
  const lost = await f.handler(post(f.body));
  assert.equal(lost.status, 503);
  assert.deepEqual(await lost.json(), { error: "disposition_write_unknown" });
  const replay = await f.handler(post(f.body));
  assert.equal(replay.status, 200);
  assert.equal((await f.store.load(c, f.plan.record)).table.history.length, 1);
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, memberIds: [] },
    "revoke",
  );
  assert.equal((await f.handler(post(f.body))).status, 503);
  assert.equal((await f.store.load(c, f.plan.record)).table.history.length, 1);
});
test("malformed UTF8 body bytes empty chunks and cancellation deny before session provider", async (t) => {
  const f = await ready(t),
    stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 4097; i++) controller.enqueue(new Uint8Array());
        controller.close();
      },
    });
  for (const body of [
    new Uint8Array([255]),
    "x".repeat(132 * 1024 + 1),
    stream,
  ]) {
    const req = new Request(base + "/record", {
      method: "POST",
      headers,
      body,
      duplex: "half",
    } as RequestInit);
    assert.notEqual((await f.handler(req)).status, 200);
  }
  const abort = new AbortController();
  abort.abort();
  assert.equal((await f.handler(post(f.body, {}, abort.signal))).status, 503);
  assert.equal(f.calls(), 0);
});
test("policy withdrawn while request body stalls is observed after admission and prevents write", async (t) => {
  const f = await ready(t);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const pending = f.handler(
    new Request(base + "/record", {
      method: "POST",
      headers,
      body: stream,
      duplex: "half",
    } as RequestInit),
  );
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, memberIds: [] },
    "revoke",
  );
  controller.enqueue(new TextEncoder().encode(JSON.stringify(f.body)));
  controller.close();
  assert.equal((await pending).status, 503);
  assert.equal((await f.store.load(c, f.plan.record)).storage, null);
});
test("write ACK remains 200 after actual COMMIT cancellation", async (t) => {
  const f = await ready(t),
    abort = new AbortController();
  f.hooks.factual = () => {
    f.hooks.factual = null;
    abort.abort();
  };
  const response = await f.handler(post(f.body, {}, abort.signal));
  assert.equal(response.status, 200);
  assert(abort.signal.aborted);
  assert.equal((await f.store.load(c, f.plan.record)).table.history.length, 1);
});
test("HTTP deadline reaches own locked NEW and CACHED admission before acknowledgement or new effect", async (t) => {
  const f = await ready(t);
  let hit = 0;
  const db: Database = {
    transaction: (fn) =>
      f.factual.transaction((q) =>
        fn({
          query: async <T>(sql: string, values?: unknown[]) => {
            const r = await q.query<T>(sql, values);
            if (values?.includes("factual.question_review.record_checked")) {
              hit++;
              const end = performance.now() + 150;
              while (performance.now() < end) {}
            }
            return r;
          },
        }),
      ),
    close: () => f.factual.close(),
  };
  const facade = new IdentityQuestionDispositionRepository(
    new QuestionDispositionRepository(db, { ...f.fixed, humanIds: ["owner"] }),
    f.membership,
    f.fixed,
  );
  const handler = createDispositionWriteHandler(
    facade,
    f.membership,
    f.provider,
    { ...f.fixed, origin, timeoutMs: 100 },
    () => c.now,
  );
  assert.equal((await handler(post(f.body))).status, 503);
  assert.equal((await f.store.load(c, f.plan.record)).storage, null);
  assert.equal((await f.handler(post(f.body))).status, 200);
  assert.equal((await handler(post(f.body))).status, 503);
  assert.equal(hit, 2);
  assert.equal((await f.store.load(c, f.plan.record)).table.history.length, 1);
});
