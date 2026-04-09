import * as p from "@clack/prompts";

const DIM   = "\x1b[2m";
const BOLD  = "\x1b[1m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED   = "\x1b[31m";
const CYAN  = "\x1b[36m";

export function maskToken(token: string): string {
  if (token.length < 8) return token;
  const prefix = token.slice(0, Math.min(16, token.length - 4));
  const suffix = token.slice(-4);
  return `${prefix}…${suffix}`;
}

export function wizardIntro(): void {
  p.intro(`${BOLD}octoctl setup${RESET} ${DIM}— interactive C2 deployment wizard${RESET}`);
}

export function wizardOutro(message: string): void {
  p.outro(message);
}

export function sectionHeader(title: string): void {
  p.log.step(`${BOLD}${title}${RESET}`);
}

export async function promptPassword(opts: {
  message: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string> {
  const result = await p.password({
    message: opts.message,
    validate: opts.validate,
  });
  if (p.isCancel(result)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return result;
}

export async function promptText(opts: {
  message: string;
  placeholder?: string;
  initialValue?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string> {
  const result = await p.text({
    message: opts.message,
    placeholder: opts.placeholder,
    initialValue: opts.initialValue,
    validate: opts.validate,
  });
  if (p.isCancel(result)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return result;
}

export async function promptSelect<T extends string>(opts: {
  message: string;
  options: { value: T; label: string; hint?: string }[];
}): Promise<T> {
  const result = await p.select({
    message: opts.message,
    options: opts.options,
  });
  if (p.isCancel(result)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return result as T;
}

export async function promptConfirm(opts: {
  message: string;
  initialValue?: boolean;
}): Promise<boolean> {
  const result = await p.confirm({
    message: opts.message,
    initialValue: opts.initialValue ?? true,
  });
  if (p.isCancel(result)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return result;
}

export async function withSpinner<T>(
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  const s = p.spinner();
  s.start(message);
  try {
    const result = await fn();
    s.stop(`${GREEN}done${RESET}`);
    return result;
  } catch (err) {
    s.stop(`${RED}failed${RESET}`);
    throw err;
  }
}
