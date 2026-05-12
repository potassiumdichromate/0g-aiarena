import {
  connect,
  NatsConnection,
  JetStreamClient,
  JetStreamManager,
  StringCodec,
  JSONCodec,
  Subscription,
  consumerOpts,
} from 'nats';

export type Handler<T> = (data: T, subject: string) => Promise<void>;

const jc = JSONCodec();

export class EventBus {
  private nc!: NatsConnection;
  private js!: JetStreamClient;
  private jsm!: JetStreamManager;

  async connect(url = process.env.NATS_URL ?? 'nats://localhost:4222'): Promise<void> {
    this.nc = await connect({ servers: url });
    this.js = this.nc.jetstream();
    this.jsm = await this.nc.jetstreamManager();
  }

  async publish<T>(subject: string, data: T): Promise<void> {
    try {
      await this.js.publish(subject, jc.encode(data));
    } catch {
      // Fallback to core NATS if JetStream not configured for subject
      this.nc.publish(subject, jc.encode(data));
    }
  }

  subscribe<T>(subject: string, handler: Handler<T>): Subscription {
    const sub = this.nc.subscribe(subject);
    (async () => {
      for await (const msg of sub) {
        try {
          const data = jc.decode(msg.data) as T;
          await handler(data, msg.subject);
        } catch (err) {
          console.error(`Error handling message on ${subject}:`, err);
        }
      }
    })();
    return sub;
  }

  async createStream(config: {
    name: string;
    subjects: string[];
    maxAge?: number;
    maxMsgs?: number;
  }): Promise<void> {
    try {
      await this.jsm.streams.add({
        name: config.name,
        subjects: config.subjects,
        max_age: config.maxAge ? config.maxAge * 1_000_000_000 : undefined, // nanoseconds
        max_msgs: config.maxMsgs,
      });
    } catch (err: any) {
      if (err.message?.includes('stream name already in use')) {
        return; // Stream already exists
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.nc.close();
  }

  isConnected(): boolean {
    return !this.nc?.isClosed();
  }
}

// ── No-op bus used when NATS is unavailable ───────────────────────────────────
class NoopEventBus extends EventBus {
  override async publish<T>(_subject: string, _data: T): Promise<void> {
    // NATS unavailable — event silently dropped
  }
  override subscribe<T>(_subject: string, _handler: Handler<T>): Subscription {
    return {} as Subscription;
  }
  override isConnected(): boolean { return false; }
}

// Singleton instance
let eventBusInstance: EventBus | null = null;

export async function getEventBus(): Promise<EventBus> {
  if (eventBusInstance) return eventBusInstance;

  const url = process.env.NATS_URL;
  if (!url) {
    console.warn('[EventBus] NATS_URL not set — running in no-op mode (events disabled)');
    eventBusInstance = new NoopEventBus();
    return eventBusInstance;
  }

  try {
    const bus = new EventBus();
    await bus.connect(url);
    eventBusInstance = bus;
  } catch (err) {
    console.warn('[EventBus] Could not connect to NATS — running in no-op mode:', (err as Error).message);
    eventBusInstance = new NoopEventBus();
  }

  return eventBusInstance;
}
