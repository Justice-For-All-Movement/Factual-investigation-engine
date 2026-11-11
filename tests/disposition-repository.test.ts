import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { scoped, verifyAudit } from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
import { fixture as pureFixture } from "./disposition-fixture.ts";
import { FactualRepository } from "../src/repository.ts";
import {
  QuestionDispositionRepository,
  DISPOSITION_KIND,
  DISPOSITION_KEY,
} from "../src/disposition-repository.ts";
import type { DispositionCommand } from "../src/disposition-repository.ts";
async function fixture(t: test.TestContext) {
  const x = pureFixture(),
    pg = new PGlite();
  await pg.exec(
    await readFile(
      new URL(
        "../migrations/001_foundation.sql",
        import.meta.resolve("@accountability/evidence-sql/database"),
      ),
      "utf8",
    ),
  );
  await pg.exec(
    "CREATE ROLE factual_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO factual_login; SET SESSION AUTHORIZATION factual_login",
  );
  const hooks: {
    lost: boolean;
    rollback: boolean;
    afterAudit: (() => void | Promise<void>) | null;
    afterEffect: (() => void) | null;
  } = { lost: false, rollback: false, afterAudit: null, afterEffect: null };
  const db: Database = {
    transaction: (fn) =>
      pg
        .transaction(
          async (query) =>
            await fn({
              query: async <T>(sql: string, values?: unknown[]) => {
                const result = await query.query(sql, values);
                if (
                  values?.includes("factual.question_review.record_checked") ||
                  values?.includes("factual.question_review.read_checked")
                )
                  await hooks.afterAudit?.();
                if (
                  sql.includes("INSERT INTO public.evidence_outbox") &&
                  values?.includes("factual.question_review.recorded")
                ) {
                  hooks.afterEffect?.();
                  if (hooks.rollback) throw Error("synthetic rollback");
                }
                return { rows: result.rows as T[] };
              },
            }),
        )
        .then((v) => {
          if (hooks.lost) {
            hooks.lost = false;
            throw Error("synthetic lost COMMIT acknowledgement");
          }
          return v;
        }),
    close: () => pg.close(),
  };
  t.after(() => pg.close());
  const policy = {
    tenantId: x.c.tenantId,
    projectId: x.c.projectId,
    humanIds: [x.c.actor.id],
    purpose: x.c.purpose,
  };
  const owning = new FactualRepository(db, policy),
    repo = new QuestionDispositionRepository(db, policy);
  const plan = await owning.append(
    x.c,
    0,
    x.knowledge,
    { id: "plan", expectedRevision: 0, value: x.value },
    "plan",
  );
  const command: DispositionCommand = {
    planningStorage: plan.storage,
    effortStorage: null,
    review: x.input,
  };
  const counts = async () => ({
    audits: await scoped(db, x.c, (tx) => tx.audits()),
    outbox: await db.transaction(async (q) => {
      await q.query("SET LOCAL ROLE evidence_runtime");
      await q.query(
        "SELECT set_config('evidence.tenant_id',$1,true),set_config('evidence.project_id',$2,true)",
        [x.c.tenantId, x.c.projectId],
      );
      return (
        await q.query<{ topic: string }>(
          "SELECT topic FROM public.evidence_outbox",
        )
      ).rows;
    }),
  });
  return { ...x, pg, db, hooks, owning, repo, plan, command, counts };
}
test("owning locked plan/empty effort editions bind one immutable review plus atomic audit/outbox and detached table", async (t) => {
  const f = await fixture(t),
    ack = await f.repo.record(f.c, 0, f.command, "review");
  assert.equal(ack.storage.kind, DISPOSITION_KIND);
  assert.equal(ack.storage.id, DISPOSITION_KEY);
  assert.equal(ack.storage.revision, 1);
  assert.deepEqual(ack.planningStorage, f.plan.storage);
  assert.equal(ack.effortStorage, null);
  const d = await f.repo.load(f.c, f.plan.record);
  assert.deepEqual(d.storage, ack.storage);
  assert.equal(d.table.reviewRequired, null);
  assert.deepEqual(
    d.table.questions.map((q) => q.disposition.status),
    ["unresolved", "deferred", "assigned"],
  );
  const found = await scoped(f.db, f.c, (tx) =>
    tx.get<any>(DISPOSITION_KIND, DISPOSITION_KEY),
  );
  assert.equal(found!.value.records[0].basis.effortSequence, 0);
  assert.equal(found!.value.records[0].basis.planningRecordCount, 1);
  (d.table.latestReview!.questions[0] as { reason: string }).reason = "changed";
  assert.equal(
    (await f.repo.load(f.c, f.plan.record)).table.latestReview!.questions[0]!
      .reason,
    "Unknown",
  );
  const counts = await f.counts();
  assert.equal(
    counts.audits.filter((x) => x.type === "factual.question_review.recorded")
      .length,
    1,
  );
  assert.equal(
    counts.outbox.filter((x) => x.topic === "factual.question_review.recorded")
      .length,
    1,
  );
  assert.equal(verifyAudit(await scoped(f.db, f.c, (tx) => tx.audits())), true);
});
test("actual owning effort or plan changes reject stale new commands, retain old reviews and never carry disposition authority forward", async (t) => {
  const f = await fixture(t);
  const ack = await f.repo.record(f.c, 0, f.command, "review");
  const {
    ref,
    sequence,
    visibility,
    actorId,
    actorKind,
    createdAt,
    requestId,
    purpose,
    ...value
  } = f.efforts.records[0]!;
  const effort = await f.owning.recordEffort(
    f.c,
    0,
    { ...value, id: "attempt", expectedSequence: 0 },
    "actual-effort",
  );
  let d = await f.repo.load(f.c, f.plan.record);
  assert.equal(d.table.reviewRequired, "basis-changed");
  assert.deepEqual(await f.repo.record(f.c, 0, f.command, "review"), ack);
  assert.equal((await f.repo.load(f.c, f.plan.record)).table.history.length, 1);
  assert(d.table.questions.every((q) => q.disposition.status === "unresolved"));
  const next = {
    ...f.command,
    review: {
      ...f.input,
      id: "second",
      expectedSequence: 1,
      supersedes: ack.record,
    },
  };
  await assert.rejects(f.repo.record(f.c, 1, next, "stale"), {
    code: "revision_conflict",
  });
  const second = await f.repo.record(
    f.c,
    1,
    { ...next, effortStorage: effort.storage },
    "second",
  );
  assert.equal(second.storage.revision, 2);
  const plan2 = await f.owning.append(
    f.c,
    1,
    f.knowledge,
    { id: "plan", expectedRevision: 1, value: f.value },
    "plan2",
  );
  await assert.rejects(f.repo.load(f.c, f.plan.record), { code: "stale_plan" });
  d = await f.repo.load(f.c, plan2.record);
  assert.equal(d.table.history.length, 2);
  assert.equal(d.table.reviewRequired, "basis-changed");
});
test("lost actual write acknowledgement replays one historical effect and current host authority is checked before cache", async (t) => {
  const f = await fixture(t);
  f.hooks.lost = true;
  await assert.rejects(f.repo.record(f.c, 0, f.command, "lost"));
  const ack = await f.repo.record(f.c, 0, f.command, "lost");
  assert.equal(ack.storage.revision, 1);
  await assert.rejects(
    f.repo.record(
      { ...f.c, actor: { ...f.c.actor, roles: [] } },
      0,
      f.command,
      "lost",
    ),
  );
  await assert.rejects(
    f.repo.record(
      { ...f.c, actor: { ...f.c.actor, id: "unlisted" } },
      0,
      f.command,
      "lost",
    ),
  );
  const counts = await f.counts();
  assert.equal(
    counts.outbox.filter((x) => x.topic === "factual.question_review.recorded")
      .length,
    1,
  );
  assert.equal((await f.repo.load(f.c, f.plan.record)).table.history.length, 1);
});
test("failed atomic outbox rolls back review and effect audit while a later exact command succeeds once", async (t) => {
  const f = await fixture(t);
  f.hooks.rollback = true;
  await assert.rejects(f.repo.record(f.c, 0, f.command, "rollback"));
  f.hooks.rollback = false;
  assert.equal((await f.repo.load(f.c, f.plan.record)).storage, null);
  assert.equal(
    (await f.counts()).audits.filter(
      (x) => x.type === "factual.question_review.recorded",
    ).length,
    0,
  );
  const ack = await f.repo.record(f.c, 0, f.command, "rollback");
  assert.equal(ack.storage.revision, 1);
});
test("prewrite deadline/cancellation denies under actual checked lock; acknowledged write stays acknowledged after cancellation and lost read is withheld", async (t) => {
  const f = await fixture(t);
  const abort = new AbortController();
  f.hooks.afterAudit = () => abort.abort();
  await assert.rejects(
    f.repo.record(f.c, 0, f.command, "cancel", abort.signal),
    { code: "disposition_unavailable" },
  );
  f.hooks.afterAudit = () => {
    const end = performance.now() + 30;
    while (performance.now() < end) {}
  };
  await assert.rejects(
    f.repo.record(f.c, 0, f.command, "late", undefined, 10),
    { code: "disposition_unavailable" },
  );
  f.hooks.afterAudit = null;
  assert.equal((await f.repo.load(f.c, f.plan.record)).storage, null);
  const after = new AbortController();
  f.hooks.afterEffect = () => after.abort();
  const ack = await f.repo.record(f.c, 0, f.command, "ack", after.signal);
  assert.equal(ack.storage.revision, 1);
  assert(after.signal.aborted);
  f.hooks.afterEffect = null;
  f.hooks.lost = true;
  await assert.rejects(f.repo.load(f.c, f.plan.record));
  assert.equal((await f.repo.load(f.c, f.plan.record)).table.history.length, 1);
});
test("foreign or fabricated aggregate editions and corrupted stored history deny without deletion or repair", async (t) => {
  const f = await fixture(t);
  for (const storage of [
    { ...f.plan.storage, projectId: "other" },
    { ...f.plan.storage, id: "invented" },
    { ...f.plan.storage, revision: 0 },
  ])
    await assert.rejects(
      f.repo.record(f.c, 0, { ...f.command, planningStorage: storage }, "bad"),
    );
  const ack = await f.repo.record(f.c, 0, f.command, "ok");
  await scoped(f.db, f.c, async (tx) => {
    const stored = await tx.get<any>(DISPOSITION_KIND, DISPOSITION_KEY);
    stored!.value.records[0].basis.captureDigest = "0".repeat(64);
    await tx.put(DISPOSITION_KIND, DISPOSITION_KEY, 1, stored!.value);
  });
  await assert.rejects(f.repo.load(f.c, f.plan.record));
  await assert.rejects(f.repo.record(f.c, 0, f.command, "ok"));
  const retained = await scoped(f.db, f.c, (tx) =>
    tx.get<any>(DISPOSITION_KIND, DISPOSITION_KEY),
  );
  assert.equal(retained!.revision, 2);
  assert.equal(retained!.value.records.length, 1);
  assert.equal(ack.storage.revision, 1);
});

test("context, command and fixed host policy are detached before a held owning checked audit", async (t) => {
  const f = await fixture(t),
    c = structuredClone(f.c),
    command = structuredClone(f.command);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve)),
    started = new Promise<void>((resolve) => (entered = resolve));
  f.hooks.afterAudit = async () => {
    entered();
    await held;
  };
  const pending = f.repo.record(c, 0, command, "captured");
  await started;
  (c as { purpose: string }).purpose = "changed";
  (c.actor as { id: string }).id = "changed";
  (command.review.questions[0] as { reason: string }).reason = "mutated";
  (command.planningStorage as { revision: number }).revision = 99;
  release();
  const ack = await pending;
  f.hooks.afterAudit = null;
  assert.equal(ack.planningStorage.revision, 1);
  const d = await f.repo.load(f.c, f.plan.record);
  assert.equal(d.table.latestReview!.questions[0]!.reason, "Unknown");
  assert.equal(d.table.latestReview!.actorId, f.c.actor.id);
  assert.equal(d.table.purpose, f.c.purpose);
});

test("two owning public writers with the same expected review revision commit one effect without overwrite", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.repo.record(f.c, 0, f.command, "contender-a"),
    f.repo.record(
      f.c,
      0,
      { ...f.command, review: { ...f.input, id: "other-review" } },
      "contender-b",
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "revision_conflict");
  const d = await f.repo.load(f.c, f.plan.record);
  assert.equal(d.storage!.revision, 1);
  assert.equal(d.table.history.length, 1);
  assert.equal(
    (await f.counts()).outbox.filter(
      (x) => x.topic === "factual.question_review.recorded",
    ).length,
    1,
  );
  // PGlite queues these transactions; this is not independent TCP-session contention evidence.
});
