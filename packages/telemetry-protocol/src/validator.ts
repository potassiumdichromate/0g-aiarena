import { z } from 'zod';
import { TelemetryBatch } from './events';

const Vector3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

const BaseEventSchema = z.object({
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  battleId: z.string().optional(),
  eventType: z.string(),
  timestamp: z.number().positive(),
  sequenceNumber: z.number().int().min(0),
  payload: z.record(z.unknown()),
});

const TelemetryBatchSchema = z.object({
  batchId: z.string().min(1),
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  events: z.array(BaseEventSchema).min(1).max(500),
  submittedAt: z.number().positive(),
  checksum: z.string().min(1),
});

export function validateBatch(data: unknown): { valid: boolean; errors: string[]; batch?: TelemetryBatch } {
  const result = TelemetryBatchSchema.safeParse(data);
  if (!result.success) {
    return {
      valid: false,
      errors: result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
    };
  }
  return { valid: true, errors: [], batch: result.data as TelemetryBatch };
}

export function validateChecksum(batch: TelemetryBatch): boolean {
  // Recompute checksum from events
  const { createHash } = require('crypto');
  const data = JSON.stringify(batch.events);
  const expected = createHash('sha256').update(data).digest('hex');
  return expected === batch.checksum;
}
