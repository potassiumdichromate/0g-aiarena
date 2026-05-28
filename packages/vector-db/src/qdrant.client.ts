/**
 * QdrantWrapper — lazy ESM-compatible shim around @qdrant/js-client-rest.
 *
 * @qdrant/js-client-rest v1+ is ESM-only.  This package compiles to CommonJS,
 * so a static `import { QdrantClient }` would be compiled to `require()` which
 * Node refuses to use on an ESM package (TS1479).
 *
 * Solution: keep only `import type` (erased at compile-time, no require() call)
 * and use a dynamic `await import(...)` inside an async helper so the real
 * import happens at runtime via the ESM loader.
 */

import { COLLECTION_CONFIGS, CollectionName } from './collections';

// @qdrant/js-client-rest is ESM-only — we cannot static-import or import-type it
// in a CommonJS package without hitting TS1479 / TS1541.  We use `any` for the
// private field and resolve the real class at runtime via dynamic import().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QdrantClientType = any;

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
  private _client: QdrantClientType | null = null;
  private readonly url: string;
  private readonly apiKey: string | undefined;

  constructor(
    url    = process.env.QDRANT_URL    ?? 'http://localhost:6333',
    apiKey = process.env.QDRANT_API_KEY
  ) {
    this.url    = url;
    this.apiKey = apiKey;
  }

  /** Lazy ESM dynamic import — only runs once per instance. */
  private async client(): Promise<QdrantClientType> {
    if (!this._client) {
      // dynamic import() works in CJS modules even for ESM-only packages.
      const { QdrantClient } = await import('@qdrant/js-client-rest');
      this._client = new QdrantClient({
        url:                this.url,
        apiKey:             this.apiKey,
        checkCompatibility: false,
      });
    }
    return this._client;
  }

  async createCollection(name: CollectionName): Promise<void> {
    const config = COLLECTION_CONFIGS[name];
    const c = await this.client();
    try {
      await c.createCollection(name, {
        vectors: {
          size:     config.vectorSize,
          distance: config.distance,
        } as any,
        optimizers_config: { default_segment_number: 2 },
        replication_factor: 1,
      });
    } catch (err: any) {
      if (err.message?.includes('already exists')) return;
      throw err;
    }
  }

  async upsertVector(collection: string, point: VectorPoint): Promise<void> {
    const c = await this.client();
    await c.upsert(collection, {
      wait:   true,
      points: [{ id: point.id, vector: point.vector, payload: point.payload }],
    });
  }

  async upsertVectors(collection: string, points: VectorPoint[]): Promise<void> {
    const c = await this.client();
    await c.upsert(collection, {
      wait:   true,
      points: points.map(p => ({ id: p.id, vector: p.vector, payload: p.payload })),
    });
  }

  async search(
    collection: string,
    vector: number[],
    filter?: Record<string, unknown>,
    limit = 10
  ): Promise<ScoredPoint[]> {
    const c = await this.client();
    const results = await c.search(collection, {
      vector,
      limit,
      filter:       filter as any,
      with_payload: true,
    });
    return results.map(r => ({
      id:      r.id,
      score:   r.score,
      payload: r.payload as Record<string, unknown>,
    }));
  }

  async delete(collection: string, filter: Record<string, unknown>): Promise<void> {
    const c = await this.client();
    await c.delete(collection, { wait: true, filter: filter as any });
  }

  async deleteById(collection: string, ids: (string | number)[]): Promise<void> {
    const c = await this.client();
    await c.delete(collection, { wait: true, points: ids });
  }

  async getPoint(collection: string, id: string | number): Promise<VectorPoint | null> {
    const c = await this.client();
    try {
      const result = await c.retrieve(collection, {
        ids:         [id],
        with_payload: true,
        with_vector:  true,
      });
      if (!result.length) return null;
      const point = result[0];
      return {
        id:      point.id,
        vector:  point.vector as number[],
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
