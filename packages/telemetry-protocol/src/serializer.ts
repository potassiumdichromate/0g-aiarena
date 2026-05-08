import { TelemetryBatch, AnyTelemetryEvent } from './events';
import { createHash } from 'crypto';

export function serialize(batch: TelemetryBatch): Buffer {
  return Buffer.from(JSON.stringify(batch), 'utf-8');
}

export function deserialize(data: Buffer | string): TelemetryBatch {
  const str = typeof data === 'string' ? data : data.toString('utf-8');
  return JSON.parse(str) as TelemetryBatch;
}

export function computeChecksum(events: AnyTelemetryEvent[]): string {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}

export function buildBatch(params: {
  sessionId: string;
  agentId: string;
  events: AnyTelemetryEvent[];
}): TelemetryBatch {
  const checksum = computeChecksum(params.events);
  return {
    batchId: `${params.sessionId}-${Date.now()}`,
    sessionId: params.sessionId,
    agentId: params.agentId,
    events: params.events,
    submittedAt: Date.now(),
    checksum,
  };
}
