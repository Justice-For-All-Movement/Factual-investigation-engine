import { inspectCapturedInvestigationCoverage } from "./coverage.ts";
import { createEffortState, inspectEfforts, recordEffort } from "./efforts.ts";
import type { EffortState, EffortInput } from "./efforts.ts";
import { scoped } from "@accountability/evidence-sql/database";
import type {
  Database,
  UnitOfWork,
} from "@accountability/evidence-sql/database";
import type { KnowledgeState } from "@accountability/knowledge-verification";
import {
  canonical,
  digest,
  invariant,
  nonempty,
  requireScope,
} from "@accountability/knowledge-verification/contracts";
import type {
  Context,
  Json,
  Ref,
  Scope,
} from "@accountability/knowledge-verification/contracts";
import { createPlanningState, inspectPlans, revisePlan } from "./index.ts";
import type { Plan, PlanningState } from "./index.ts";

export const EFFORT_KIND = "factual-effort-history";
export const EFFORT_KEY = digest({ aggregate: EFFORT_KIND });
export const PLANNING_KIND = "factual-planning-history";
export const PLANNING_KEY = digest({ aggregate: PLANNING_KIND });
export type PlanningCommand = Readonly<{
  id: string;
  expectedRevision: number;
  value: Plan;
}>;
export type PlanningSnapshot = Readonly<{
  revision: number;
  state: PlanningState;
}>;
export type PlanningAcknowledgement = Readonly<{ storage: Ref; record: Ref }>;
const json = (value: unknown): Json => JSON.parse(canonical(value));

/** Host-authenticated human planning over this engine's OWN operational database. */
export class FactualRepository {
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
      "Bounded distinct humans required",
    );
    for (const id of this.#policy.humanIds) nonempty(id, "Human", 128);
  }
  #context(context: Context) {
    const c = structuredClone(context);
    requireScope(this.#policy, c);
    inspectPlans(c, createPlanningState(c));
    invariant(
      c.actor.kind === "human" &&
        this.#policy.humanIds.includes(c.actor.id) &&
        c.purpose === this.#policy.purpose,
      "forbidden",
      "Listed human planning authority and fixed purpose required",
    );
    return c;
  }
  async #load(tx: UnitOfWork, c: Context): Promise<PlanningSnapshot> {
    const stored = await tx.get<PlanningState>(PLANNING_KIND, PLANNING_KEY);
    if (!stored) return { revision: 0, state: createPlanningState(c) };
    requireScope(c, stored.value);
    inspectPlans(c, stored.value);
    invariant(
      stored.revision === stored.value.records.length,
      "invalid_plan",
      "Storage and planning history sequence mismatch",
    );
    return { revision: stored.revision, state: stored.value };
  }
  async load(context: Context): Promise<PlanningSnapshot> {
    const c = this.#context(context);
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("factual.planning.read_checked", {});
      return structuredClone(await this.#load(tx, c));
    });
  }
  async append(
    context: Context,
    expectedStorageRevision: number,
    knowledge: KnowledgeState,
    command: PlanningCommand,
    commandId: string,
  ): Promise<PlanningAcknowledgement> {
    const c = this.#context(context),
      q = structuredClone(command),
      upstream = structuredClone(knowledge);
    nonempty(commandId, "Command", 128);
    invariant(
      Number.isSafeInteger(expectedStorageRevision) &&
        expectedStorageRevision >= 0,
      "invalid_revision",
      "Expected storage revision required",
    );
    return scoped(this.#db, c, async (tx) => {
      // SDK checked audit acquires our project lock BEFORE current reads and cached acknowledgement.
      await tx.audit("factual.planning.append_checked", {});
      const current = await this.#load(tx, c);
      return (await tx.idempotent(
        commandId,
        json({
          operation: "planning",
          actorKind: c.actor.kind,
          purpose: c.purpose,
          expectedStorageRevision,
          command: q,
        }),
        async () => {
          invariant(
            current.revision === expectedStorageRevision,
            "revision_conflict",
            "Planning storage edition changed",
          );
          const state = revisePlan(c, upstream, current.state, q);
          const stored = await tx.put(
            PLANNING_KIND,
            PLANNING_KEY,
            current.revision,
            state,
          );
          const result = {
            storage: {
              tenantId: c.tenantId,
              projectId: c.projectId,
              kind: PLANNING_KIND,
              id: PLANNING_KEY,
              revision: stored.revision,
            },
            record: state.records.at(-1)!.ref,
          };
          await tx.audit("factual.planning.appended", json(result));
          await tx.enqueue("factual.planning.revised", json(result));
          return json(result);
        },
      )) as PlanningAcknowledgement;
    });
  }
  async #efforts(tx: UnitOfWork, c: Context) {
    const stored = await tx.get<EffortState>(EFFORT_KIND, EFFORT_KEY);
    if (!stored) return { revision: 0, state: createEffortState(c) };
    requireScope(c, stored.value);
    inspectEfforts(c, stored.value);
    invariant(
      stored.revision === stored.value.records.length,
      "invalid_effort",
      "Storage and effort sequence mismatch",
    );
    return { revision: stored.revision, state: stored.value };
  }
  async loadEfforts(context: Context) {
    const c = this.#context(context);
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("factual.effort.read_checked", {});
      const planning = await this.#load(tx, c),
        efforts = await this.#efforts(tx, c);
      return structuredClone({
        ...efforts,
        planningRevision: planning.revision,
      });
    });
  }
  /** One owning checked read. Caller Context remains host-trusted; Identity facade is opt-in. */
  async loadCoverage(
    context: Context,
    selected: Ref,
    signal?: AbortSignal,
    timeoutMs = 10000,
  ) {
    const started = performance.now(),
      c = this.#context(context),
      choice = structuredClone(selected);
    invariant(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy",
      "Bounded coverage read required",
    );
    const gate = () =>
      invariant(
        !signal?.aborted && performance.now() - started < timeoutMs,
        "coverage_unavailable",
        "Coverage observation unavailable",
      );
    gate();
    return scoped(this.#db, c, async (tx) => {
      gate();
      await tx.audit("factual.coverage.read_checked", {});
      gate();
      const planning = await this.#load(tx, c);
      gate();
      const efforts = await this.#efforts(tx, c);
      gate();
      const coverage = inspectCapturedInvestigationCoverage(
        c,
        JSON.stringify({ plans: planning.state, efforts: efforts.state }),
        choice,
      );
      const storage = (kind: string, id: string, revision: number): Ref => ({
        tenantId: c.tenantId,
        projectId: c.projectId,
        kind,
        id,
        revision,
      });
      const output = {
        planningStorage: storage(
          PLANNING_KIND,
          PLANNING_KEY,
          planning.revision,
        ),
        effortStorage:
          efforts.revision === 0
            ? null
            : storage(EFFORT_KIND, EFFORT_KEY, efforts.revision),
        coverage,
      };
      invariant(
        Buffer.byteLength(canonical(output)) <= 512 * 1024,
        "coverage_full",
        "Complete owning coverage exceeds budget",
      );
      gate();
      const copy = structuredClone(output);
      gate();
      return copy;
    }).then((output) => {
      gate();
      return output;
    });
  }
  async recordEffort(
    context: Context,
    expectedStorageRevision: number,
    input: EffortInput,
    commandId: string,
  ): Promise<PlanningAcknowledgement> {
    const c = this.#context(context),
      q = structuredClone(input);
    nonempty(commandId, "Command", 128);
    invariant(
      Number.isSafeInteger(expectedStorageRevision) &&
        expectedStorageRevision >= 0,
      "invalid_revision",
      "Expected effort storage revision required",
    );
    return scoped(this.#db, c, async (tx) => {
      await tx.audit("factual.effort.append_checked", {});
      const planning = await this.#load(tx, c),
        efforts = await this.#efforts(tx, c);
      return (await tx.idempotent(
        commandId,
        json({
          operation: "effort",
          actorKind: c.actor.kind,
          purpose: c.purpose,
          expectedStorageRevision,
          input: q,
        }),
        async () => {
          invariant(
            efforts.revision === expectedStorageRevision,
            "revision_conflict",
            "Effort storage edition changed",
          );
          const state = recordEffort(c, planning.state, efforts.state, q);
          const stored = await tx.put(
            EFFORT_KIND,
            EFFORT_KEY,
            efforts.revision,
            state,
          );
          const result = {
            storage: {
              tenantId: c.tenantId,
              projectId: c.projectId,
              kind: EFFORT_KIND,
              id: EFFORT_KEY,
              revision: stored.revision,
            },
            record: state.records.at(-1)!.ref,
          };
          await tx.audit(
            "factual.effort.recorded",
            json({ ...result, planningRevision: planning.revision }),
          );
          await tx.enqueue("factual.effort.revised", json(result));
          return json(result);
        },
      )) as PlanningAcknowledgement;
    });
  }
}
