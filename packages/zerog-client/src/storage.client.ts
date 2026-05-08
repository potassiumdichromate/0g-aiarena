/**
 * 0G Storage client — wraps @0gfoundation/0g-storage-ts-sdk.
 *
 * KEY CONCEPT: 0G Storage is content-addressed.
 * Files are identified by their MERKLE ROOT HASH, not by path strings.
 *
 * This client provides a path-based abstraction on top of that:
 *   - upload(logicalPath, data)  → stores rootHash in caller's DB index
 *   - download(rootHash)         → fetches by hash
 *
 * The caller (storage-service) is responsible for maintaining the
 * path → rootHash mapping in PostgreSQL (table: storage_index).
 *
 * Official SDK: https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk
 * npm: @0gfoundation/0g-storage-ts-sdk
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

export interface StorageUploadOptions {
  /** AES-256 or ECIES encryption — leave undefined for plaintext */
  encryption?: AesEncryptionOptions | EciesEncryptionOptions;
}

export interface AesEncryptionOptions {
  type: 'aes256';
  key: Uint8Array;  // 32-byte AES key (crypto.randomBytes(32))
}

export interface EciesEncryptionOptions {
  type: 'ecies';
  recipientPublicKey: string;  // Compressed 33-byte hex public key
}

export class ZeroGStorageClient {
  private readonly indexer: Indexer;
  private readonly signer: ethers.Wallet;
  private readonly rpcUrl: string;

  constructor(private readonly config: ZeroGConfig) {
    const provider = new ethers.JsonRpcProvider(config.evmRpc);
    this.signer = new ethers.Wallet(config.storagePrivateKey, provider);
    this.indexer = new Indexer(config.storageIndexer);
    this.rpcUrl = config.evmRpc;
  }

  /**
   * Upload a Buffer or Uint8Array to 0G Storage.
   * Returns the Merkle root hash that uniquely identifies this content.
   *
   * @example
   * const { rootHash } = await storage.uploadBuffer(
   *   Buffer.from(JSON.stringify(agentMemory)),
   *   { encryption: { type: 'aes256', key: encKey } }
   * );
   * // Store rootHash in your DB: path → rootHash
   */
  async uploadBuffer(
    data: Buffer | Uint8Array,
    options: StorageUploadOptions = {},
  ): Promise<UploadResult> {
    const memData = new MemData(data instanceof Buffer ? new Uint8Array(data) : data);

    const uploadOptions = options.encryption
      ? { encryption: options.encryption }
      : {};

    const [tx, err] = await this.indexer.upload(
      memData,
      this.rpcUrl,
      this.signer,
      uploadOptions,
    );

    if (err !== null) {
      throw new Error(`0G Storage upload failed: ${err}`);
    }

    // tx can be a single result or a split result for large files
    if ('rootHash' in tx) {
      return { rootHash: tx.rootHash as string, txHash: tx.txHash as string };
    }
    return {
      rootHash: (tx.rootHashes as string[])[0],
      txHash: tx.txHashes as string[],
    };
  }

  /**
   * Upload a JSON-serialisable object.
   * Convenience wrapper over uploadBuffer.
   */
  async uploadJson(
    payload: unknown,
    options: StorageUploadOptions = {},
  ): Promise<UploadResult> {
    const data = Buffer.from(JSON.stringify(payload), 'utf-8');
    return this.uploadBuffer(data, options);
  }

  /**
   * Upload a file from the local filesystem (useful in workers).
   */
  async uploadFile(filePath: string, options: StorageUploadOptions = {}): Promise<UploadResult> {
    const file = await ZgFile.fromFilePath(filePath);

    const [, treeErr] = await file.merkleTree();
    if (treeErr !== null) throw new Error(`Merkle tree error: ${treeErr}`);

    const uploadOptions = options.encryption ? { encryption: options.encryption } : {};
    const [tx, err] = await this.indexer.upload(file, this.rpcUrl, this.signer, uploadOptions);
    await file.close();

    if (err !== null) throw new Error(`0G Storage upload failed: ${err}`);

    if ('rootHash' in tx) {
      return { rootHash: tx.rootHash as string, txHash: tx.txHash as string };
    }
    return {
      rootHash: (tx.rootHashes as string[])[0],
      txHash: tx.txHashes as string[],
    };
  }

  /**
   * Download content by Merkle root hash.
   * Returns raw Buffer.
   */
  async downloadToBuffer(
    rootHash: string,
    decryptionOptions?: { symmetricKey?: Uint8Array; privateKey?: string },
  ): Promise<Buffer> {
    const downloadOptions = decryptionOptions
      ? { proof: true, decryption: decryptionOptions }
      : { proof: true };

    const [blob, err] = await (this.indexer as any).downloadToBlob(rootHash, downloadOptions);
    if (err !== null) throw new Error(`0G Storage download failed: ${err}`);

    const arrayBuf = await blob.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  /**
   * Download and parse as JSON.
   */
  async downloadJson<T = unknown>(
    rootHash: string,
    decryptionOptions?: { symmetricKey?: Uint8Array; privateKey?: string },
  ): Promise<T> {
    const buf = await this.downloadToBuffer(rootHash, decryptionOptions);
    return JSON.parse(buf.toString('utf-8')) as T;
  }

  /**
   * Download content to a file path (useful in workers).
   */
  async downloadToFile(
    rootHash: string,
    outputPath: string,
    withProof = true,
  ): Promise<void> {
    const err = await this.indexer.download(rootHash, outputPath, withProof);
    if (err !== null) throw new Error(`0G Storage download failed: ${err}`);
  }

  /**
   * Peek at the encryption header without downloading the full file.
   * Returns null for plaintext, or encryption version number.
   */
  async peekHeader(rootHash: string): Promise<{ version: number } | null> {
    const [header, err] = await (this.indexer as any).peekHeader(rootHash);
    if (err !== null) return null;
    return header;
  }

  /**
   * Compute the Merkle root hash of a local file without uploading.
   * Useful for pre-computing the identifier before upload.
   */
  async computeRootHash(filePath: string): Promise<string> {
    const file = await ZgFile.fromFilePath(filePath);
    const [tree, err] = await file.merkleTree();
    await file.close();
    if (err !== null) throw new Error(`Merkle tree error: ${err}`);
    return tree.rootHash().toString();
  }
}
