import { UserEventCategory, UserEventType } from './types';

export interface ExitCodePolicy {
  positiveExitCodes: ReadonlySet<number>;
  allowedExitCodes: ReadonlySet<number>;
}

/** `undefined` means "don't react" (e.g. Ctrl+C, or the shell couldn't report a code). */
export function categorizeExitCode(code: number | undefined, policy: ExitCodePolicy): UserEventCategory | undefined {
  if (code === undefined) return undefined;
  if (policy.positiveExitCodes.has(code)) return UserEventCategory.Positive;
  if (policy.allowedExitCodes.has(code)) return undefined;
  return UserEventCategory.Negative;
}

const TEST_COMMAND =
  /(^|[\s/;&|])(jest|vitest|mocha|ava|pytest|phpunit|pest|rspec|ctest|tox|nox)(\s|$)|\b(npm|pnpm|yarn|bun|deno|cargo|go|mvn|gradle|gradlew|dotnet|mix|swift|flutter|dart|rake|make)\s+(run\s+)?(test|tests|check|nextest)\b/;

export function terminalEventType(commandLine: string): UserEventType {
  return TEST_COMMAND.test(commandLine) ? UserEventType.Test : UserEventType.Process;
}

/** Strips env assignments / sudo / leading paths so `FOO=1 ./node_modules/.bin/jest` matches `jest`. */
export function commandName(commandLine: string): string {
  const tokens = commandLine.trim().split(/\s+/);
  const first = tokens.find((t) => !/^\w+=/.test(t) && t !== 'sudo' && t !== 'time' && t !== 'env') ?? '';
  return first;
}

export function isAllowedCommand(commandLine: string, allowList: readonly string[]): boolean {
  if (allowList.length === 0) return true;
  const name = commandName(commandLine);
  const base = name.split('/').pop() ?? name;
  return allowList.some((allowed) => allowed === name || allowed === base || allowed.split('/').pop() === base);
}

export function findLogTerm(chunk: string, terms: readonly string[], ignoreCase: boolean): string | undefined {
  const haystack = ignoreCase ? chunk.toLowerCase() : chunk;
  return terms.find((t) => haystack.includes(ignoreCase ? t.toLowerCase() : t));
}
