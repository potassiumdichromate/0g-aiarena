export function nowMs(): number {
  return Date.now();
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function addMinutes(date: Date, minutes: number): Date {
  return addSeconds(date, minutes * 60);
}

export function addHours(date: Date, hours: number): Date {
  return addMinutes(date, hours * 60);
}

export function addDays(date: Date, days: number): Date {
  return addHours(date, days * 24);
}

export function isExpired(expiresAt: Date | number): boolean {
  const ts = expiresAt instanceof Date ? expiresAt.getTime() : expiresAt;
  return Date.now() > ts;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function toUnixTimestamp(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function fromUnixTimestamp(ts: number): Date {
  return new Date(ts * 1000);
}

/**
 * Start (00:00 UTC Sunday) of the week immediately before the week
 * containing `now`. Used by the league weekly reset (§14.3), which runs at
 * 00:00 UTC every Sunday and snapshots the week that just ended.
 */
export function startOfPreviousWeekUTC(now: Date = new Date()): Date {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayOfWeek = midnight.getUTCDay(); // 0 = Sunday
  midnight.setUTCDate(midnight.getUTCDate() - dayOfWeek - 7);
  return midnight;
}
