import type { IncomingMessage, ServerResponse } from 'node:http';
import { UPSTREAM_HEALTH } from '../lib/shared';

export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  let upstreamOk = false;
  try {
    const r = await fetch(UPSTREAM_HEALTH, { signal: AbortSignal.timeout(4000) });
    upstreamOk = r.ok;
  } catch { /* upstream unreachable */ }

  res.statusCode = upstreamOk ? 200 : 503;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    status:   upstreamOk ? 'ok' : 'degraded',
    service:  'okx-payment-proxy',
    upstream: upstreamOk ? 'ok' : 'unreachable',
  }));
}
