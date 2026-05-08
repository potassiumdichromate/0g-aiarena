/**
 * StorageService — abstraction over 0G Storage for all AI Arena services.
 *
 * 0G Storage is content-addressed: files are identified by Merkle root hash,
 * not path strings. This service bridges that gap:
 *   1. upload(logicalPath, data) → calls ZeroGStorageClient.uploadBuffer → gets rootHash
 *   2. Persists logicalPath → rootHash in the `storage_index` Postgres table
 *   3. download(logicalPath) → looks up rootHash in DB → calls ZeroGStorageClient.downloadToBuffer
 *
 * Callers use logical paths (e.g. "agents/abc-123/memory/v4").
 * The rootHash is the on-chain identifier stored in 0G Storage.
 */

import { ZeroGStorageClient, getZeroGConfig, UploadResult } from '@ai-arena/zerog-client';
import { prisma } from '@ai-arena/db-client';

export interface StorageUploadOptions {
  mimeType?: string;
  uploadedBy?: string;
  tags?: string[];
  encrypt?: boolean;
}

export interface StorageRecord {
  logicalPath: string;
  rootHash: string;
  txHash?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  createdAt: Date;
}

export class StorageService {
  private readonly client: ZeroGStorageClient;

  constructor() {
    this.client = new ZeroGStorageClient(getZeroGConfig());
  }

  /**
   * Upload data to 0G Storage and index the rootHash against a logical path.
   * Returns the rootHash — store this if you need to bypass the index lookup.
   */
  async upload(
    logicalPath: string,
    data: Buffer,
    options: StorageUploadOptions = {},
  ): Promise<{ rootHash: string; txHash?: string }> {
    let result: UploadResult;

    if (options.encrypt) {
      const { randomBytes } = await import('crypto');
      const key = randomBytes(32);
      result = await this.client.uploadBuffer(data, {
        encryption: { type: 'aes256', key },
      });
    } else {
      result = await this.client.uploadBuffer(data);
    }

    await prisma.storageIndex.upsert({
      where: { logicalPath },
      update: {
        rootHash: result.rootHash,
        txHash:   result.txHash ?? null,
        mimeType: options.mimeType ?? null,
        sizeBytes: data.byteLength,
        uploadedBy: options.uploadedBy ?? null,
        tags: options.tags ?? [],
      },
      create: {
        logicalPath,
        rootHash:  result.rootHash,
        txHash:    result.txHash ?? null,
        mimeType:  options.mimeType ?? null,
        sizeBytes: data.byteLength,
        uploadedBy: options.uploadedBy ?? null,
        tags: options.tags ?? [],
      },
    });

    return { rootHash: result.rootHash, txHash: result.txHash };
  }

  /**
   * Upload a JSON-serialisable object. Convenience wrapper around upload().
   */
  async uploadJson<T>(
    logicalPath: string,
    value: T,
    options: StorageUploadOptions = {},
  ): Promise<{ rootHash: string; txHash?: string }> {
    const buf = Buffer.from(JSON.stringify(value), 'utf8');
    return this.upload(logicalPath, buf, { mimeType: 'application/json', ...options });
  }

  /**
   * Download data from 0G Storage by logical path.
   * Resolves the rootHash from the storage_index table first.
   */
  async download(logicalPath: string): Promise<Buffer> {
    const record = await prisma.storageIndex.findUnique({
      where: { logicalPath },
    });

    if (!record) {
      throw new Error(`StorageService: no index entry for path "${logicalPath}"`);
    }

    return this.client.downloadToBuffer(record.rootHash);
  }

  /**
   * Download and deserialise a JSON value by logical path.
   */
  async downloadJson<T>(logicalPath: string): Promise<T> {
    const buf = await this.download(logicalPath);
    return JSON.parse(buf.toString('utf8')) as T;
  }

  /**
   * Download directly by rootHash (skips the index lookup).
   * Useful when callers already have the hash (e.g. from on-chain INFT metadata).
   */
  async downloadByHash(rootHash: string): Promise<Buffer> {
    return this.client.downloadToBuffer(rootHash);
  }

  async downloadJsonByHash<T>(rootHash: string): Promise<T> {
    const buf = await this.downloadByHash(rootHash);
    return JSON.parse(buf.toString('utf8')) as T;
  }

  /**
   * Look up the rootHash for a logical path without downloading.
   */
  async getRootHash(logicalPath: string): Promise<string | null> {
    const record = await prisma.storageIndex.findUnique({
      where: { logicalPath },
    });
    return record?.rootHash ?? null;
  }

  /**
   * List all indexed paths with a given prefix.
   * Note: this queries the local Postgres index, NOT 0G Storage directly
   * (0G Storage has no concept of path prefixes).
   */
  async listByPrefix(prefix: string): Promise<StorageRecord[]> {
    const records = await prisma.storageIndex.findMany({
      where: { logicalPath: { startsWith: prefix } },
      orderBy: { createdAt: 'desc' },
    });
    return records.map(r => ({
      logicalPath: r.logicalPath,
      rootHash:    r.rootHash,
      txHash:      r.txHash,
      mimeType:    r.mimeType,
      sizeBytes:   r.sizeBytes,
      createdAt:   r.createdAt,
    }));
  }

  /**
   * Remove a logical path from the index.
   * The data on 0G Storage is content-addressed and immutable — it cannot be deleted.
   * This only removes the local index entry.
   */
  async removeIndex(logicalPath: string): Promise<void> {
    await prisma.storageIndex.deleteMany({ where: { logicalPath } });
  }
}
