import { QdrantClient } from '@qdrant/js-client-rest';
import { COLLECTION_CONFIGS, CollectionName } from './collections';

export interface VectorPoint {
  id: string | number;
  vector: number[];
  payload?: Record<string, unknown>;
}

export interface ScoredPoint {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

export class QdrantWrapper {
  private readonly client: QdrantClient;

  constructor(
    url = process.env.QDRANT_URL ?? 'http://localhost:6333',
    apiKey = process.env.QDRANT_API_KEY
  ) {
    this.client = new QdrantClient({ url, apiKey, checkCompatibility: false });
  }

  async createCollection(name: CollectionName): Promise<void> {
    const config = COLLECTION_CONFIGS[name];
    try {
      await this.client.createCollection(name, {
        vectors: {
          size: config.vectorSize,
          distance: config.distance,
        } as any,
        optimizers_config: {
          default_segment_number: 2,
        },
        replication_factor: 1,
      });
    } catch (err: any) {
      if (err.message?.includes('already exists')) return;
      throw err;
    }
  }

  async upsertVector(collection: string, point: VectorPoint): Promise<void> {
    await this.client.upsert(collection, {
      wait: true,
      points: [
        {
          id: point.id,
          vector: point.vector,
          payload: point.payload,
        },
      ],
    });
  }

  async upsertVectors(collection: string, points: VectorPoint[]): Promise<void> {
    await this.client.upsert(collection, {
      wait: true,
      points: points.map(p => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    });
  }

  async search(
    collection: string,
    vector: number[],
    filter?: Record<string, unknown>,
    limit = 10
  ): Promise<ScoredPoint[]> {
    const results = await this.client.search(collection, {
      vector,
      limit,
      filter: filter as any,
      with_payload: true,
    });

    return results.map(r => ({
      id: r.id,
      score: r.score,
      payload: r.payload as Record<string, unknown>,
    }));
  }

  async delete(collection: string, filter: Record<string, unknown>): Promise<void> {
    await this.client.delete(collection, {
      wait: true,
      filter: filter as any,
    });
  }

  async deleteById(collection: string, ids: (string | number)[]): Promise<void> {
    await this.client.delete(collection, {
      wait: true,
      points: ids,
    });
  }

  async getPoint(collection: string, id: string | number): Promise<VectorPoint | null> {
    try {
      const result = await this.client.retrieve(collection, {
        ids: [id],
        with_payload: true,
        with_vector: true,
      });
      if (!result.length) return null;
      const point = result[0];
      return {
        id: point.id,
        vector: point.vector as number[],
        payload: point.payload as Record<string, unknown>,
      };
    } catch {
      return null;
    }
  }
}

let qdrantInstance: QdrantWrapper | null = null;

export function getQdrantClient(): QdrantWrapper {
  if (!qdrantInstance) {
    qdrantInstance = new QdrantWrapper();
  }
  return qdrantInstance;
}
