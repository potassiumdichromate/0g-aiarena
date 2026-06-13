/** Parse a query-string integer with a default and optional bounds; non-numeric input falls back to `def`. */
export function parseIntParam(raw: unknown, def: number, opts: { min?: number; max?: number } = {}): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  let value = Number.isFinite(n) ? n : def;
  if (opts.min !== undefined) value = Math.max(opts.min, value);
  if (opts.max !== undefined) value = Math.min(opts.max, value);
  return value;
}
