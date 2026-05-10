/**
 * 0G Storage client — wraps @0gfoundation/0g-storage-ts-sdk v1.x
 *
 * KEY CONCEPT: 0G Storage is content-addressed.
 * Files are identified by their MERKLE ROOT HASH, not by path strings.
 *
 * This client provides a path-based abstraction on top of that:
 *   - uploadBuffer(data)  → returns rootHash
 *   - downloadToBuffer(rootHash) → fetches by hash
 *
 * The caller (storage-service) is responsible for maintaining the
 * path → rootHash mapping in PostgreSQL (table: storage_index).
 *
 * Official SDK: https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk
 * npm: @0gfoundation/0g-storage-ts-sdk@^1.2.9
 */

import { ZgFile, Indexer, MemData } from '@0gfoundation/0g-storage-ts-sdk';
import { ethers } from 'ethers';
import { ZeroGConfig } from './config';

export interface UploadResult {
  /** Merkle root hash — use this as the file identifier for download */
  rootHash: string;
  /** On-chain transaction hash(es) */
  txHash: string | string[];
}

export class ZeroGStorageClient {
  private readonly indexer: Indexer;
  private readonly signer: ethers.Wallet;

  constructor(private readonly config: ZeroGConfig) {
    const provider = new ethers.JsonRpcProvider(config.evmRpc);
    // Use a throwaway dev key if none configured — storage calls will fail at
    // runtime but the service can still start and serve non-storage endpoints.
    const privKey = config.storagePrivateKey ||
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Hardhat dev key #0
    this.signer = new ethers.Wallet(privKey, provider);
    this.indexer = new Indexer(config.storageIndexer);
  }

  /**
   * Upload a Buffer or Uint8Array to 0G Storage.
   * Returns the Merkle root hash that uniquely identifies this content.
   */
  async uploadBuffer(data: Buffer | Uint8Array): Promise<UploadResult> {
    const bytes = data instanceof Buffer ? new Uint8Array(data) : data;
    const memData = new MemData(bytes);

    const [tx, err] = await this.indexer.upload(
      memData,
      this.config.evmRpc,
      this.signer,
    );

    if (err !== null) {
      throw new Error(`0G Storage upload failed: ${err}`);
    }

    return this.extractResult(tx);
  }

  /**
   * Upload a JSON-serialisable object.
   * Convenience wrapper over uploadBuffer.
   */
  async uploadJson(payload: unknown): Promise<UploadResult> {
    const data = Buffer.from(JSON.stringify(payload), 'utf-8');
    return this.uploadBuffer(data);
  }

  /**
   * Upload a file from the local filesystem.
   */
  async uploadFile(filePath: string): Promise<UploadResult> {
    const file = await ZgFile.fromFilePath(filePath);

    const [, treeErr] = await file.merkleTree();
    if (treeErr !== null) throw new Error(`Merkle tree error: ${treeErr}`);

    const [tx, err] = await this.indexer.upload(
      file,
      this.config.evmRpc,
      this.signer,
    );
    await file.close();

    if (err !== null) throw new Error(`0G Storage upload failed: ${err}`);
    return this.extractResult(tx);
  }

  /**
   * Download content by Merkle root hash. Returns raw Buffer.
   */
  async downloadToBuffer(rootHash: string): Promise<Buffer> {
    const [blob, err] = await (this.indexer as any).downloadToBlob(rootHash, { proof: true });
    if (err !== null) throw new Error(`0G Storage download failed: ${err}`);
    const arrayBuf = await blob.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  /**
   * Download and parse as JSON.
   */
  async downloadJson<T = unknown>(rootHash: string): Promise<T> {
    const buf = await this.downloadToBuffer(rootHash);
    return JSON.parse(buf.toString('utf-8')) as T;
  }

  /**
   * Download content to a local file path.
   */
  async downloadToFile(rootHash: string, outputPath: string, withProof = true): Promise<void> {
    const err = await this.indexer.download(rootHash, outputPath, withProof);
    if (err !== null) throw new Error(`0G Storage download failed: ${err}`);
  }

  /**
   * Compute the Merkle root hash of a local file without uploading.
   */
  async computeRootHash(filePath: string): Promise<string> {
    const file = await ZgFile.fromFilePath(filePath);
    const [tree, err] = await file.merkleTree();
    await file.close();
    if (err !== null || !tree) throw new Error(`Merkle tree error: ${err}`);
    return tree!.rootHash().toString();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private extractResult(tx: any): UploadResult {
    if (!tx) throw new Error('0G Storage: empty upload result');
    // v1.x returns either { rootHash, txHash } or { rootHashes, txHashes }
    if (tx.rootHash) {
      return { rootHash: tx.rootHash as string, txHash: tx.txHash as string };
    }
    if (tx.rootHashes?.length) {
      return { rootHash: tx.rootHashes[0] as string, txHash: tx.txHashes as string[] };
    }
    throw new Error(`0G Storage: unexpected upload result shape: ${JSON.stringify(tx)}`);
  }
}
