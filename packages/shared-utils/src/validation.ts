import { z } from 'zod';

export const AgentTraitsSchema = z.object({
  aggression: z.number().min(0).max(100),
  patience: z.number().min(0).max(100),
  adaptability: z.number().min(0).max(100),
  riskTolerance: z.number().min(0).max(100),
  teamwork: z.number().min(0).max(100),
  creativity: z.number().min(0).max(100),
  endurance: z.number().min(0).max(100),
  precision: z.number().min(0).max(100),
});

export const CreateAgentSchema = z.object({
  name: z.string().min(2).max(64),
  clan: z.enum(['CYBER', 'BIO', 'ARCANE', 'MECH', 'SHADOW']),
  archetype: z.enum(['BERSERKER', 'TACTICIAN', 'SUPPORT', 'ASSASSIN', 'DEFENDER', 'HYBRID']).optional(),
  backstory: z.string().max(1000).optional(),
  gameId: z.string().uuid().optional(),
});

export const TelemetryBatchSchema = z.object({
  batchId: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  events: z.array(z.object({
    eventId: z.string(),
    sessionId: z.string(),
    agentId: z.string(),
    eventType: z.string(),
    timestamp: z.number(),
    payload: z.record(z.unknown()),
    sequenceNumber: z.number(),
  })).min(1).max(500),
  submittedAt: z.number(),
  checksum: z.string(),
});

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export function validateOrThrow<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Validation failed: ${errors}`);
  }
  return result.data;
}
