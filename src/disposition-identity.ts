import { MembershipRegistry } from "@accountability/identity-policy/membership";
import {
  canonical,
  invariant,
  nonempty,
  requireScope,
  validateRef,
} from "@accountability/knowledge-verification/contracts";
import type {
  Context,
  Scope,
  Ref,
} from "@accountability/knowledge-verification/contracts";
import { FACTUAL_RESOURCE_ID } from "./identity-repository.ts";
import { QuestionDispositionRepository } from "./disposition-repository.ts";
import type { DispositionCommand } from "./disposition-repository.ts";

/** Host authenticates human ID; actual stored Identity roles/resource policy authorize each call. Sequential, not a distributed fence. */
export class IdentityQuestionDispositionRepository {
  readonly #resolve: MembershipRegistry["resolveResource"];
  readonly #load: QuestionDispositionRepository["load"];
  readonly #record: QuestionDispositionRepository["record"];
  readonly #policy: Scope & Readonly<{ purpose: string }>;
  readonly #timeout: number;
  constructor(
    repository: QuestionDispositionRepository,
    membership: MembershipRegistry,
    policy: Scope & Readonly<{ purpose: string }>,
    timeoutMs = 10000,
  ) {
    this.#resolve =
      MembershipRegistry.prototype.resolveResource.bind(membership);
    this.#load = QuestionDispositionRepository.prototype.load.bind(repository);
    this.#record =
      QuestionDispositionRepository.prototype.record.bind(repository);
    this.#policy = structuredClone(policy);
    this.#timeout = timeoutMs;
    for (const x of [policy.tenantId, policy.projectId, policy.purpose])
      nonempty(x, "Fixed policy", 128);
    invariant(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy",
      "Bounded deadline required",
    );
  }
  #start(context: Context, signal?: AbortSignal, admit?: () => void) {
    const started = performance.now(),
      c = structuredClone(context);
    requireScope(this.#policy, c);
    invariant(
      c.actor.kind === "human" && c.purpose === this.#policy.purpose,
      "disposition_unavailable",
      "Current disposition authority unavailable",
    );
    const gate = () => {
      invariant(
        !signal?.aborted && performance.now() - started < this.#timeout,
        "disposition_unavailable",
        "Current disposition operation unavailable",
      );
      const value: unknown = admit?.();
      if (value instanceof Promise) void value.catch(() => {});
      invariant(
        value === undefined,
        "disposition_unavailable",
        "Synchronous void admission required",
      );
    };
    const remaining = () =>
      Math.max(1, Math.ceil(this.#timeout - (performance.now() - started)));
    gate();
    return { c, gate, remaining };
  }
  async #current(c: Context, gate: () => void): Promise<Context> {
    gate();
    const principal = { ...c, actor: { ...c.actor, roles: [] } };
    const resolved = structuredClone(
      await this.#resolve(principal, FACTUAL_RESOURCE_ID, "investigate"),
    );
    gate();
    const actual = resolved.context;
    requireScope(this.#policy, actual);
    invariant(
      resolved.resourceId === FACTUAL_RESOURCE_ID &&
        actual.actor.kind === "human" &&
        actual.actor.id === c.actor.id &&
        actual.purpose === c.purpose &&
        actual.requestId === c.requestId,
      "disposition_unavailable",
      "Current disposition binding unavailable",
    );
    return actual;
  }
  #selection(c: Context, selected: Ref) {
    validateRef(selected);
    requireScope(c, selected);
    invariant(
      selected.kind === "investigation-plan" &&
        Number.isSafeInteger(selected.revision) &&
        selected.revision > 0 &&
        Object.keys(selected).length === 5,
      "disposition_unavailable",
      "Exact positive plan required",
    );
  }
  async load(
    context: Context,
    selected: Ref,
    signal?: AbortSignal,
    admit?: () => void,
  ) {
    try {
      const { c, gate, remaining } = this.#start(context, signal, admit),
        choice = structuredClone(selected);
      this.#selection(c, choice);
      gate();
      const actual = await this.#current(c, gate);
      gate();
      const output = await this.#load(
        actual,
        choice,
        signal,
        remaining(),
        gate,
      );
      gate();
      await this.#current(c, gate);
      gate();
      const copy = structuredClone(output);
      gate();
      return copy;
    } catch {
      invariant(
        false,
        "disposition_unavailable",
        "Current disposition read unavailable",
      );
    }
  }
  async record(
    context: Context,
    expectedStorageRevision: number,
    command: DispositionCommand,
    commandId: string,
    signal?: AbortSignal,
    admit?: () => void,
  ) {
    let owning = false;
    try {
      const { c, gate, remaining } = this.#start(context, signal, admit),
        q = structuredClone(command);
      invariant(
        Buffer.byteLength(canonical(q)) <= 128 * 1024,
        "disposition_unavailable",
        "Bounded command required",
      );
      this.#selection(c, q.review.selected);
      nonempty(commandId, "Command", 128);
      gate();
      const actual = await this.#current(c, gate);
      gate();
      owning = true;
      return await this.#record(
        actual,
        expectedStorageRevision,
        q,
        commandId,
        signal,
        remaining(),
        gate,
      );
    } catch {
      invariant(
        false,
        owning ? "disposition_write_unknown" : "disposition_unavailable",
        owning
          ? "Owning disposition outcome unknown"
          : "Current disposition authority unavailable",
      );
    }
  }
}
