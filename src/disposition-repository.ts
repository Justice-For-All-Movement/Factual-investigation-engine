import { scoped } from "@accountability/evidence-sql/database";
import type {
  Database,
  UnitOfWork,
} from "@accountability/evidence-sql/database";
import {
  canonical,
  digest,
  invariant,
  nonempty,
  requireScope,
  validateRef,
} from "@accountability/knowledge-verification/contracts";
import type {
  Context,
  Scope,
  Ref,
  Json,
} from "@accountability/knowledge-verification/contracts";
import { inspectPlans } from "./index.ts";
import type { PlanningState } from "./index.ts";
import { createEffortState, inspectEfforts } from "./efforts.ts";
import type { EffortState } from "./efforts.ts";
import {
  PLANNING_KIND,
  PLANNING_KEY,
  EFFORT_KIND,
  EFFORT_KEY,
} from "./repository.ts";
import {
  createQuestionDispositionState,
  recordQuestionDispositions,
  inspectQuestionDispositions,
} from "./question-dispositions.ts";
import type {
  QuestionDispositionInput,
  QuestionDispositionState,
} from "./question-dispositions.ts";
export const DISPOSITION_KIND = "factual-question-review-history";
export const DISPOSITION_KEY = digest({ aggregate: DISPOSITION_KIND });
export type DispositionCommand = Readonly<{
  planningStorage: Ref;
  effortStorage: Ref | null;
  review: QuestionDispositionInput;
}>;
export type DispositionAcknowledgement = Readonly<{
  storage: Ref;
  record: Ref;
  planningStorage: Ref;
  effortStorage: Ref | null;
}>;
const json = (v: unknown): Json => JSON.parse(canonical(v));
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function exact(v: unknown, keys: readonly string[]) {
  invariant(
    v !== null &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype &&
      Object.keys(v).length === keys.length &&
      keys.every((k) => Object.hasOwn(v, k)),
    "invalid_disposition",
    "Exact command fields required",
  );
}
/** Stable SQL SDK in this engine's OWN database. Context/list membership remain trusted host authority. */
export class QuestionDispositionRepository {
  readonly #db: Database;
  readonly #policy: Scope &
    Readonly<{ humanIds: readonly string[]; purpose: string }>;
  constructor(
    db: Database,
    policy: Scope & Readonly<{ humanIds: readonly string[]; purpose: string }>,
  ) {
    this.#db = db;
    this.#policy = structuredClone(policy);
    nonempty(this.#policy.tenantId, "Tenant", 128);
    nonempty(this.#policy.projectId, "Project", 128);
    nonempty(this.#policy.purpose, "Purpose", 200);
    invariant(
      Array.isArray(this.#policy.humanIds) &&
        this.#policy.humanIds.length > 0 &&
        this.#policy.humanIds.length <= 128 &&
        new Set(this.#policy.humanIds).size === this.#policy.humanIds.length,
      "invalid_policy",
      "Bounded distinct host human list required",
    );
    for (const id of this.#policy.humanIds) nonempty(id, "Human", 128);
  }
  #context(context: Context) {
    const c = structuredClone(context);
    requireScope(this.#policy, c);
    createQuestionDispositionState(c);
    invariant(
      this.#policy.humanIds.includes(c.actor.id) &&
        c.purpose === this.#policy.purpose,
      "forbidden",
      "Listed host human and fixed purpose required",
    );
    return c;
  }
  #ref(c: Context, kind: string, id: string, revision: number): Ref {
    return { tenantId: c.tenantId, projectId: c.projectId, kind, id, revision };
  }
  #gate(
    signal: AbortSignal | undefined,
    timeoutMs: number,
    admit?: () => void,
  ) {
    const started = performance.now();
    invariant(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy",
      "Bounded operation deadline required",
    );
    return () => {
      invariant(
        !signal?.aborted && performance.now() - started < timeoutMs,
        "disposition_unavailable",
        "Disposition operation unavailable",
      );
      const value: unknown = admit?.();
      if (value instanceof Promise) void value.catch(() => {});
      invariant(
        value === undefined,
        "disposition_unavailable",
        "Synchronous void admission required",
      );
    };
  }
  async #read(tx: UnitOfWork, c: Context, selected: Ref) {
    const planning = await tx.get<PlanningState>(PLANNING_KIND, PLANNING_KEY);
    invariant(
      planning,
      "missing_reference",
      "Owning planning history required",
    );
    inspectPlans(c, planning.value);
    invariant(
      planning.revision === planning.value.records.length,
      "invalid_plan",
      "Planning storage/history mismatch",
    );
    const effort = await tx.get<EffortState>(EFFORT_KIND, EFFORT_KEY),
      efforts = effort?.value ?? createEffortState(c);
    inspectEfforts(c, efforts);
    invariant(
      (effort?.revision ?? 0) === efforts.records.length,
      "invalid_effort",
      "Effort storage/history mismatch",
    );
    const stored = await tx.get<QuestionDispositionState>(
        DISPOSITION_KIND,
        DISPOSITION_KEY,
      ),
      state = stored?.value ?? createQuestionDispositionState(c);
    invariant(
      (stored?.revision ?? 0) === state.records.length,
      "invalid_disposition",
      "Review storage/history mismatch",
    );
    const capture = JSON.stringify({ plans: planning.value, efforts });
    // Validates EVERY prior captured prefix, not only the selected latest decision.
    const table = inspectQuestionDispositions(c, capture, state, selected);
    return {
      state,
      capture,
      table,
      revision: stored?.revision ?? 0,
      storage: stored
        ? this.#ref(c, DISPOSITION_KIND, DISPOSITION_KEY, stored.revision)
        : null,
      planningStorage: this.#ref(
        c,
        PLANNING_KIND,
        PLANNING_KEY,
        planning.revision,
      ),
      effortStorage: effort
        ? this.#ref(c, EFFORT_KIND, EFFORT_KEY, effort.revision)
        : null,
    };
  }
  async load(
    context: Context,
    selected: Ref,
    signal?: AbortSignal,
    timeoutMs = 10000,
    admit?: () => void,
  ) {
    const gate = this.#gate(signal, timeoutMs, admit),
      c = this.#context(context),
      choice = structuredClone(selected);
    gate();
    const result = await scoped(this.#db, c, async (tx) => {
      await tx.audit("factual.question_review.read_checked", {});
      gate();
      const read = await this.#read(tx, c, choice);
      gate();
      return structuredClone({
        storage: read.storage,
        planningStorage: read.planningStorage,
        effortStorage: read.effortStorage,
        table: read.table,
      });
    });
    gate();
    invariant(
      Buffer.byteLength(canonical(result)) <= 512 * 1024,
      "dispositions_full",
      "Complete owning table exceeds512KiB",
    );
    gate();
    return result;
  }
  async record(
    context: Context,
    expectedStorageRevision: number,
    command: DispositionCommand,
    commandId: string,
    signal?: AbortSignal,
    timeoutMs = 10000,
    admit?: () => void,
  ): Promise<DispositionAcknowledgement> {
    const gate = this.#gate(signal, timeoutMs, admit),
      c = this.#context(context),
      q = structuredClone(command);
    gate();
    exact(q, ["planningStorage", "effortStorage", "review"]);
    nonempty(commandId, "Command", 128);
    invariant(
      Buffer.byteLength(canonical(q)) <= 128 * 1024,
      "dispositions_full",
      "Whole command exceeds128KiB",
    );
    invariant(
      Number.isSafeInteger(expectedStorageRevision) &&
        expectedStorageRevision >= 0,
      "invalid_revision",
      "Expected review storage edition required",
    );
    for (const [r, kind, id] of [
      [q.planningStorage, PLANNING_KIND, PLANNING_KEY],
      [q.effortStorage, EFFORT_KIND, EFFORT_KEY],
    ] as const)
      if (r !== null) {
        exact(r, ["tenantId", "projectId", "kind", "id", "revision"]);
        validateRef(r);
        requireScope(c, r);
        invariant(
          r.kind === kind &&
            r.id === id &&
            Number.isSafeInteger(r.revision) &&
            r.revision > 0,
          "invalid_reference",
          "Exact positive owning aggregate edition required",
        );
      }
    gate();
    return scoped(this.#db, c, async (tx) => {
      // The stable SDK's checked audit obtains the project lock BEFORE every owning read/cache lookup.
      await tx.audit("factual.question_review.record_checked", {});
      gate();
      const read = await this.#read(tx, c, q.review.selected);
      gate();
      return (await tx.idempotent(
        commandId,
        json({
          operation: "question-dispositions",
          actorKind: c.actor.kind,
          purpose: c.purpose,
          expectedStorageRevision,
          command: q,
        }),
        async () => {
          gate();
          invariant(
            read.revision === expectedStorageRevision &&
              equal(read.planningStorage, q.planningStorage) &&
              equal(read.effortStorage, q.effortStorage),
            "revision_conflict",
            "Owning planning, effort or review basis changed",
          );
          const state = recordQuestionDispositions(
            c,
            read.capture,
            read.state,
            q.review,
          );
          gate();
          const stored = await tx.put(
            DISPOSITION_KIND,
            DISPOSITION_KEY,
            read.revision,
            state,
          );
          const result: DispositionAcknowledgement = {
            storage: this.#ref(
              c,
              DISPOSITION_KIND,
              DISPOSITION_KEY,
              stored.revision,
            ),
            record: state.records.at(-1)!.ref,
            planningStorage: read.planningStorage,
            effortStorage: read.effortStorage,
          };
          await tx.audit("factual.question_review.recorded", json(result));
          await tx.enqueue("factual.question_review.recorded", json(result));
          return json(result);
        },
      )) as DispositionAcknowledgement;
    }); // Acknowledged commit remains acknowledged after cancellation. Lost acknowledgement is unknown, never rollback proof.
  }
}
