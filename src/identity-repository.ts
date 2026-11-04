import { reviewPlanKnowledge } from "./knowledge-review.ts";
import type { IdentityKnowledgeRepository } from "@accountability/knowledge-verification/identity-repository";
import type { KnowledgeState } from "@accountability/knowledge-verification";
import type { EffortInput } from "./efforts.ts";
import type { MembershipRegistry } from "@accountability/identity-policy/membership";
import {
  canonical,
  digest,
  invariant,
  nonempty,
  requireScope,
} from "@accountability/knowledge-verification/contracts";
import type {
  Context,
  Ref,
  Scope,
} from "@accountability/knowledge-verification/contracts";
import type { FactualRepository, PlanningCommand } from "./repository.ts";
export const FACTUAL_RESOURCE_ID = digest({
  kind: "factual-private-history-v1",
});
/** Explicit opt-in; host authenticates human kind/id. Current stored roles replace incoming roles. */
export class IdentityFactualRepository {
  readonly #knowledge: IdentityKnowledgeRepository["load"] | null;
  readonly #resolve: MembershipRegistry["resolveResource"];
  readonly #load: FactualRepository["load"];
  readonly #efforts: FactualRepository["loadEfforts"];
  readonly #recordEffort: FactualRepository["recordEffort"];
  readonly #append: FactualRepository["append"];
  readonly #policy: Scope & Readonly<{ purpose: string }>;
  readonly #timeout: number;
  constructor(
    repository: FactualRepository,
    membership: MembershipRegistry,
    policy: Scope & Readonly<{ purpose: string }>,
    timeoutMs = 10000,
    knowledge?: IdentityKnowledgeRepository,
  ) {
    this.#knowledge = knowledge ? knowledge.load.bind(knowledge) : null;
    this.#resolve = membership.resolveResource.bind(membership);
    this.#load = repository.load.bind(repository);
    this.#efforts = repository.loadEfforts.bind(repository);
    this.#recordEffort = repository.recordEffort.bind(repository);
    this.#append = repository.append.bind(repository);
    this.#policy = structuredClone(policy);
    this.#timeout = timeoutMs;
    nonempty(this.#policy.tenantId, "Tenant", 128);
    nonempty(this.#policy.projectId, "Project", 128);
    nonempty(this.#policy.purpose, "Purpose", 128);
    invariant(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy",
      "Bounded Identity acceptance budget required",
    );
  }
  async #context(context: Context, signal?: AbortSignal): Promise<Context> {
    const started = performance.now(),
      c = structuredClone(context);
    requireScope(this.#policy, c);
    invariant(
      c.actor.kind === "human" && c.purpose === this.#policy.purpose,
      "forbidden",
      "Human and fixed purpose required",
    );
    // Caller roles have no authority. Begun Identity SQL is awaited, never raced or terminated.
    const principal = { ...c, actor: { ...c.actor, roles: [] } };
    const admitted = () =>
      !signal?.aborted && performance.now() - started < this.#timeout;
    invariant(
      admitted(),
      "identity_unavailable",
      "Current Identity observation unavailable",
    );
    let resolved: Awaited<ReturnType<MembershipRegistry["resolveResource"]>>;
    try {
      resolved = structuredClone(
        await this.#resolve(principal, FACTUAL_RESOURCE_ID, "investigate"),
      );
    } catch {
      invariant(
        false,
        "identity_unavailable",
        "Current Identity observation unavailable",
      );
    }
    invariant(
      admitted(),
      "identity_unavailable",
      "Current Identity observation unavailable",
    );
    const actual = resolved.context;
    requireScope(this.#policy, actual);
    invariant(
      resolved.resourceId === FACTUAL_RESOURCE_ID &&
        actual.actor.kind === "human" &&
        actual.actor.id === c.actor.id &&
        actual.purpose === c.purpose &&
        actual.requestId === c.requestId,
      "identity_unavailable",
      "Current Identity binding unavailable",
    );
    return actual;
  }
  async load(context: Context, signal?: AbortSignal) {
    return this.#load(await this.#context(context, signal));
  }
  async append(
    context: Context,
    expectedStorageRevision: number,
    knowledge: KnowledgeState,
    command: PlanningCommand,
    commandId: string,
    signal?: AbortSignal,
  ) {
    const q = structuredClone(command),
      upstream = structuredClone(knowledge);
    return this.#append(
      await this.#context(context, signal),
      expectedStorageRevision,
      upstream,
      q,
      commandId,
    );
  }
  async loadEfforts(context: Context, signal?: AbortSignal) {
    return this.#efforts(await this.#context(context, signal));
  }
  async recordEffort(
    context: Context,
    expectedStorageRevision: number,
    input: EffortInput,
    commandId: string,
    signal?: AbortSignal,
  ) {
    const q = structuredClone(input);
    return this.#recordEffort(
      await this.#context(context, signal),
      expectedStorageRevision,
      q,
      commandId,
    );
  }
  /** Explicit current owning-Knowledge path; no caller snapshot or fallback. */
  async appendFromKnowledge(
    context: Context,
    expectedStorageRevision: number,
    command: PlanningCommand,
    commandId: string,
    signal?: AbortSignal,
  ) {
    const q = structuredClone(command);
    const actual = await this.#context(context, signal);
    invariant(
      this.#knowledge,
      "knowledge_unavailable",
      "Current Knowledge observation unavailable",
    );
    const started = performance.now();
    let snapshot: Awaited<ReturnType<IdentityKnowledgeRepository["load"]>>;
    try {
      snapshot = structuredClone(await this.#knowledge(actual, signal));
    } catch {
      invariant(
        false,
        "knowledge_unavailable",
        "Current Knowledge observation unavailable",
      );
    }
    invariant(
      !signal?.aborted && performance.now() - started < this.#timeout,
      "knowledge_unavailable",
      "Current Knowledge observation unavailable",
    );
    // Reobserve Factual authority after the upstream stage; no distributed fence is claimed.
    return this.#append(
      await this.#context(actual, signal),
      expectedStorageRevision,
      snapshot.state,
      q,
      commandId,
    );
  }
  /** Read-only owning plan/Knowledge dependency review; no caller snapshots or fallback. */
  async reviewKnowledge(
    context: Context,
    selectedPlan: Ref,
    signal?: AbortSignal,
  ) {
    const started = performance.now(),
      c = structuredClone(context),
      selected = structuredClone(selectedPlan);
    const gate = () =>
      invariant(
        !signal?.aborted && performance.now() - started < this.#timeout,
        "knowledge_unavailable",
        "Current Knowledge review unavailable",
      );
    gate();
    const actual = await this.#context(c, signal);
    const before = await this.#load(actual);
    gate();
    invariant(
      this.#knowledge,
      "knowledge_unavailable",
      "Current Knowledge observation unavailable",
    );
    let source: Awaited<ReturnType<IdentityKnowledgeRepository["load"]>>;
    try {
      source = structuredClone(await this.#knowledge(actual, signal));
      gate();
    } catch {
      invariant(
        false,
        "knowledge_unavailable",
        "Current Knowledge observation unavailable",
      );
    }
    const fresh = await this.#context(actual, signal);
    const after = await this.#load(fresh);
    gate();
    invariant(
      canonical(before) === canonical(after),
      "planning_changed",
      "Planning history changed during Knowledge observation",
    );
    const review = reviewPlanKnowledge(
      fresh,
      source.state,
      after.state,
      selected,
    );
    const result = structuredClone({
      planningRevision: after.revision,
      knowledgeRevision: source.revision,
      review,
    });
    gate();
    return result;
  }
}
