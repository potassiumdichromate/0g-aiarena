/**
 * 0G Ecosystem configuration.
 *
 * All values are read from environment variables so that mainnet/testnet
 * switching is a single env change (ZEROG_NETWORK=mainnet|testnet).
 *
 * Official docs: https://docs.0g.ai/developer-hub/building-on-0g
 */

export type ZeroGNetwork = 'mainnet' | 'testnet';

export interface ZeroGConfig {
  network: ZeroGNetwork;

  // 0G Chain
  chainId: number;
  evmRpc: string;

  // 0G Storage (SDK: @0gfoundation/0g-storage-ts-sdk)
  // IMPORTANT: files are keyed by Merkle root hash, not path strings.
  // Store path→rootHash in PostgreSQL table `storage_index`.
  storageIndexer: string;
  storagePrivateKey: string;

  // 0G Storage smart contracts
  flowContract: string;

  // 0G Compute Router (OpenAI-compatible)
  // Base URL: https://router-api.0g.ai/v1
  computeBaseUrl: string;
  computeApiKey: string;         // Format: sk-xxxx (from pc.0g.ai Dashboard)

  // 0G Compute — default models (source: pc.0g.ai/api-reference)
  // Chat:   deepseek/deepseek-chat-v3-0324 | qwen/qwen3-vl-30b-a3b-instruct |
  //         qwen3.6-plus | zai-org/GLM-5-FP8 | zai-org/GLM-5.1-FP8
  // Image:  z-image
  // Audio:  openai/whisper-large-v3
  modelChat: string;
  modelImage: string;
  modelAudio: string;

  // 0G Compute — inference options
  verifyTee: boolean;            // Enable TEE verifiable execution proofs
  providerSort: 'latency' | 'price' | null;

  // 0G Fine-tuning (via @0gfoundation/0g-compute-ts-sdk CLI)
  finetuneProvider: string;
  finetuneDefaultModel: 'Qwen2.5-0.5B-Instruct' | 'Qwen3-32B';

  // 0G INFT
  inftContractAddress: string;
  inftOracleAddress: string;

  // Payment contract for depositing 0G tokens
  paymentContract: string;
}

const MAINNET: Readonly<Partial<ZeroGConfig>> = {
  chainId: 16661,
  evmRpc: 'https://evmrpc.0g.ai',
  storageIndexer: 'https://indexer-storage-turbo.0g.ai',
  flowContract: '0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526',
  paymentContract: '0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32',
};

const TESTNET: Readonly<Partial<ZeroGConfig>> = {
  chainId: 16600,
  evmRpc: 'https://evmrpc-testnet.0g.ai',
  storageIndexer: 'https://indexer-storage-testnet-turbo.0g.ai',
  // Flow contract auto-discovered by SDK on testnet
  flowContract: '',
  paymentContract: '0x0AD9690e0b34aB2d493DE02cDF149ee34f6C9939',
};

export function getZeroGConfig(): ZeroGConfig {
  const network = (process.env.ZEROG_NETWORK ?? 'mainnet') as ZeroGNetwork;
  const netDefaults = network === 'mainnet' ? MAINNET : TESTNET;

  return {
    network,
    chainId:            netDefaults.chainId!,
    evmRpc:             netDefaults.evmRpc!,
    storageIndexer:     netDefaults.storageIndexer!,
    flowContract:       netDefaults.flowContract!,
    paymentContract:    netDefaults.paymentContract!,

    storagePrivateKey:  process.env.ZEROG_STORAGE_PRIVATE_KEY ?? '',

    // Compute Router — same endpoint for all networks
    computeBaseUrl:     process.env.ZEROG_COMPUTE_BASE_URL ?? 'https://router-api.0g.ai/v1',
    computeApiKey:      process.env.ZEROG_COMPUTE_API_KEY  ?? '',

    modelChat:          process.env.ZEROG_MODEL_CHAT  ?? 'zai-org/GLM-5.1-FP8',
    modelImage:         process.env.ZEROG_MODEL_IMAGE ?? 'z-image',
    modelAudio:         process.env.ZEROG_MODEL_AUDIO ?? 'openai/whisper-large-v3',
    verifyTee:          process.env.ZEROG_VERIFY_TEE === 'true',
    providerSort:       (process.env.ZEROG_PROVIDER_SORT as 'latency' | 'price') || null,

    finetuneProvider:      process.env.ZEROG_FINETUNE_PROVIDER ?? '',
    finetuneDefaultModel: (process.env.ZEROG_FINETUNE_DEFAULT_MODEL ?? 'Qwen2.5-0.5B-Instruct') as 'Qwen2.5-0.5B-Instruct' | 'Qwen3-32B',

    inftContractAddress: process.env.ZEROG_INFT_CONTRACT_ADDRESS ?? '',
    inftOracleAddress:   process.env.ZEROG_INFT_ORACLE_ADDRESS   ?? '',
  };
}
