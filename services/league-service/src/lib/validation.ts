const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * §17.3 — validate `:matchId`/`:agentId`/etc. path params are UUIDs before
 * any Prisma call, returning the first invalid param name or null if all valid.
 */
export function findInvalidUuidParam(params: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (value === undefined || !isUuid(value)) return key;
  }
  return null;
}
