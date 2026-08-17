import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleCreateAgent } from '../lib/shared';

// Raw body access needed — handleCreateAgent reads/parses/rewrites the body
// itself (idempotency backfill), same as the original Render implementation.
export const config = { api: { bodyParser: false } };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleCreateAgent(req, res);
}
