export type ExecutorDirective =
  | { kind: "none" }
  | { kind: "update_sleep"; seconds: number; jitter: number }
  | { kind: "kill" }
  | { kind: "self_delete" };

export interface SelfDeleteOutcome {
  success: boolean;
  detail: string;
}

export type AppliedDirectiveEffect =
  | { kind: "none" }
  | { kind: "update_sleep"; seconds: number; jitter: number }
  | { kind: "kill" }
  | ({ kind: "self_delete" } & SelfDeleteOutcome);
