import {
  ApplicationCleanupError,
  BeanDisposalError,
  BeanLifecycleError,
  type CleanupActionError,
  InvalidGeneratedDefinitionError,
} from "@/errors";
import type { CleanupAction, ResolutionState } from "@/resolution-state";

function invokeGeneratedInstanceAction(action: unknown, instance: object): unknown {
  if (typeof action !== "function") {
    throw new InvalidGeneratedDefinitionError("Generated instance action is not callable.");
  }
  return Reflect.apply(action, undefined, [instance]);
}

export class LifecycleRunner {
  private readonly state: ResolutionState;

  constructor(state: ResolutionState) {
    this.state = state;
  }

  async runStartActions(): Promise<void> {
    for (const id of this.state.definition.plans.startActionOrder) {
      await this.runStartAction(id);
    }
  }

  async runCleanup(): Promise<void> {
    const errors: CleanupActionError[] = [];
    for (const id of this.state.definition.plans.cleanupActionOrder) {
      const action = this.state.consumeCleanup(id);
      if (!action) {
        continue;
      }
      const error = await this.runCleanupAction(id, action);
      if (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new ApplicationCleanupError(errors);
    }
  }

  private async runStartAction(id: string): Promise<void> {
    const registration = this.state.registration(id);
    const record = this.state.record(id);
    if (
      registration?.kind !== "class" ||
      !registration.hooks.start ||
      record?.state !== "constructed"
    ) {
      throw new InvalidGeneratedDefinitionError(
        `Start action "${id}" has no constructed class hook.`,
      );
    }
    try {
      await invokeGeneratedInstanceAction(registration.hooks.start, record.instance);
    } catch (cause) {
      throw new BeanLifecycleError({ beanId: id, phase: "start", cause });
    }
  }

  private async runCleanupAction(
    id: string,
    action: CleanupAction,
  ): Promise<CleanupActionError | undefined> {
    try {
      await this.invokeCleanupAction(id, action);
      return undefined;
    } catch (cause) {
      if (action.registration.kind === "class") {
        return new BeanLifecycleError({ beanId: id, phase: "close", cause });
      }
      return new BeanDisposalError({ beanId: id, cause });
    }
  }

  private async invokeCleanupAction(id: string, action: CleanupAction): Promise<void> {
    if (action.registration.kind === "class") {
      const close = action.registration.hooks.close;
      if (!close) {
        throw new InvalidGeneratedDefinitionError(
          `Cleanup action "${id}" has no class close hook.`,
        );
      }
      await invokeGeneratedInstanceAction(close, action.instance);
      return;
    }
    const dispose = action.registration.dispose;
    if (!dispose) {
      throw new InvalidGeneratedDefinitionError(`Cleanup action "${id}" has no factory disposer.`);
    }
    await invokeGeneratedInstanceAction(dispose, action.instance);
  }
}
