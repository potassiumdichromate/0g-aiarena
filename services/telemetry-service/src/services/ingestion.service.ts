import { prisma } from '@ai-arena/db-client';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';
import { TelemetryBatch } from '@ai-arena/telemetry-protocol';

export class IngestionService {
  async startSession(agentId: string, gameId: string, battleId?: string) {
    return prisma.telemetrySession.create({
      data: { agentId, gameId, battleId, status: 'ACTIVE', eventCount: 0 } as any,
    });
  }

  async endSession(sessionId: string) {
    await prisma.telemetrySession.update({
      where: { id: sessionId },
      data: { status: 'COMPLETED', endedAt: new Date() } as any,
    });

    const session = await prisma.telemetrySession.findUnique({ where: { id: sessionId } }) as any;
    const bus = await getEventBus();
    await bus.publish(SUBJECTS.TELEMETRY_SESSION_ENDED, {
      sessionId,
      agentId: session?.agentId,
      occurredAt: new Date(),
    });
  }

  async processBatch(sessionId: string, batch: TelemetryBatch): Promise<void> {
    // Update event count
    await prisma.telemetrySession.update({
      where: { id: sessionId },
      data: { eventCount: { increment: batch.events.length } } as any,
    });

    // Publish to NATS for downstream processing
    const bus = await getEventBus();
    await bus.publish(SUBJECTS.TELEMETRY_BATCH_RECEIVED, {
      sessionId,
      agentId: batch.agentId,
      batchId: batch.batchId,
      eventCount: batch.events.length,
      events: batch.events,
    });
  }
}
