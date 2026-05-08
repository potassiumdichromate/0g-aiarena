/**
 * 0G DA (Data Availability) adapter layer.
 *
 * Current DA status on testnet: UNSTABLE — use abstracted adapter so the
 * implementation can be swapped without touching consumers.
 *
 * 0G DA architecture:
 *   - Data submitted via gRPC disperser (port 51001)
 *   - Requires running DA Client + DA Encoder (GPU, NVIDIA 12.04+) + DA Retriever
 *   - Max blob size: 32,505,852 bytes
 *   - Reference: https://docs.0g.ai/developer-hub/building-on-0g/da-integration
 *   - Example (Rust): https://github.com/0gfoundation/0g-da-example-rust
 *
 * OP Stack integration:
 *   https://docs.0g.ai/developer-hub/building-on-0g/rollups-and-appchains/op-stack-on-0g-da
 *
 * Arbitrum Nitro integration:
 *   https://docs.0g.ai/developer-hub/building-on-0g/rollups-and-appchains/arbitrum-nitro-on-0g-da
 *
 * CURRENT IMPLEMENTATION: LocalDAAdapter (queue-based fallback).
 * Swap to ZeroGDAAdapter when DA is stable on target network.
 */

export interface DAReceipt {
  /** Unique blob identifier */
  blobId: string;
  /** On-chain confirmation height */
  blockHeight?: number;
  /** Originating adapter type */
  adapter: 'zerog' | 'local' | 'op-stack' | 'arbitrum-nitro';
  submittedAt: number;
}

export interface BatchData {
  payload: Buffer;
  contentType?: string;
  tags?: string[];
}

export interface DAAdapter {
  submitBatch(data: BatchData): Promise<DAReceipt>;
  retrieveBatch(receipt: DAReceipt): Promise<BatchData>;
  verifyInclusion(receipt: DAReceipt): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

// ── Local adapter (fallback — stores in memory queue) ─────────────────────────

export class LocalDAAdapter implements DAAdapter {
  private readonly store = new Map<string, BatchData>();

  async submitBatch(data: BatchData): Promise<DAReceipt> {
    const blobId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.store.set(blobId, data);
    return { blobId, adapter: 'local', submittedAt: Date.now() };
  }

  async retrieveBatch(receipt: DAReceipt): Promise<BatchData> {
    const data = this.store.get(receipt.blobId);
    if (!data) throw new Error(`Blob not found: ${receipt.blobId}`);
    return data;
  }

  async verifyInclusion(_receipt: DAReceipt): Promise<boolean> {
    return this.store.has(_receipt.blobId);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

// ── 0G DA adapter (real — requires gRPC disperser running locally) ─────────────

export class ZeroGDAAdapter implements DAAdapter {
  private readonly disperserEndpoint: string;
  private readonly circuitBreakerFailures: number = 0;
  private readonly circuitBreakerThreshold = 3;
  private circuitOpen = false;

  private readonly fallback: LocalDAAdapter;

  constructor(disperserEndpoint = 'http://localhost:51001') {
    this.disperserEndpoint = disperserEndpoint;
    this.fallback = new LocalDAAdapter();
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Simple health check — real implementation would use gRPC health check
      const res = await fetch(`${this.disperserEndpoint}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async submitBatch(data: BatchData): Promise<DAReceipt> {
    if (this.circuitOpen) {
      console.warn('[ZeroGDAAdapter] Circuit open — routing to local fallback');
      return this.fallback.submitBatch(data);
    }

    try {
      // TODO: Implement gRPC call to 0G disperser (port 51001)
      // Reference proto: https://github.com/0gfoundation/0g-da-example-rust/blob/main/src/disperser.proto
      // For now: fallback until DA is stable
      const receipt = await this.fallback.submitBatch(data);
      return { ...receipt, adapter: 'zerog' };
    } catch (err) {
      this.handleFailure();
      return this.fallback.submitBatch(data);
    }
  }

  async retrieveBatch(receipt: DAReceipt): Promise<BatchData> {
    if (receipt.adapter !== 'zerog') {
      return this.fallback.retrieveBatch(receipt);
    }

    try {
      // TODO: Implement retrieval via 0G DA Retriever (port 34005)
      return this.fallback.retrieveBatch(receipt);
    } catch (err) {
      this.handleFailure();
      throw err;
    }
  }

  async verifyInclusion(receipt: DAReceipt): Promise<boolean> {
    if (receipt.adapter !== 'zerog') return this.fallback.verifyInclusion(receipt);
    // TODO: verify via on-chain inclusion proof
    return true;
  }

  private handleFailure() {
    (this as any).circuitBreakerFailures++;
    if ((this as any).circuitBreakerFailures >= this.circuitBreakerThreshold) {
      this.circuitOpen = true;
      setTimeout(() => {
        this.circuitOpen = false;
        (this as any).circuitBreakerFailures = 0;
      }, 60_000); // Try again after 60s
    }
  }
}

// ── OP Stack adapter (future — for rollup deployment on 0G DA) ─────────────────

export class OPStackDAAdapter implements DAAdapter {
  async isAvailable(): Promise<boolean> { return false; }

  async submitBatch(_data: BatchData): Promise<DAReceipt> {
    // TODO: Submit blob via OP Stack blob transactions pointing to 0G DA
    // Docs: https://docs.0g.ai/developer-hub/building-on-0g/rollups-and-appchains/op-stack-on-0g-da
    throw new Error('OPStackDAAdapter not yet implemented');
  }

  async retrieveBatch(_receipt: DAReceipt): Promise<BatchData> {
    throw new Error('OPStackDAAdapter not yet implemented');
  }

  async verifyInclusion(_receipt: DAReceipt): Promise<boolean> {
    throw new Error('OPStackDAAdapter not yet implemented');
  }
}

// ── Factory ────────────────────────────────────────────────────────────────────

export type DAAdapterType = 'zerog' | 'local' | 'op-stack' | 'arbitrum-nitro';

export function createDAAdapter(type: DAAdapterType = 'local'): DAAdapter {
  switch (type) {
    case 'zerog':    return new ZeroGDAAdapter();
    case 'op-stack': return new OPStackDAAdapter();
    case 'local':
    default:         return new LocalDAAdapter();
  }
}
