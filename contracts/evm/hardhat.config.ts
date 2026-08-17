import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import * as dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

const DEPLOYER_KEY = process.env.EVM_DEPLOYER_PRIVATE_KEY ?? '';

/** Base deployer — intentionally NOT EVM_DEPLOYER_PRIVATE_KEY (see the `base` network note). */
const BASE_DEPLOYER_KEY = process.env.BASE_DEPLOYER_PRIVATE_KEY ?? '';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      viaIR: true,
    },
  },

  networks: {
    localhost: {
      url: 'http://127.0.0.1:8545',
    },

    // ── 0G Chain Mainnet ──────────────────────────────────────────────────────
    // Chain ID : 16661
    // Explorer : https://chainscan.0g.ai
    // Tokens   : native 0G token only (no USDT/USDC on-chain yet)
    'zerog-mainnet': {
      url:      process.env.ZEROG_EVM_RPC_MAINNET ?? 'https://evmrpc.0g.ai',
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
      chainId:  16661,
      gasPrice: 'auto',
    },

    // ── Base Mainnet ──────────────────────────────────────────────────────────
    // Chain ID : 8453
    // Explorer : https://basescan.org
    // Tokens   : USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (canonical, EIP-3009)
    //
    // Home of the A2A agent-commerce marketplace: ERC-8004 agent identity +
    // reputation (canonical registries, already deployed — we do not deploy
    // our own) and the A2AJobEscrow that custodies USDC between agents.
    // See docs/architecture/A2A_MARKETPLACE_BASE.md.
    //
    // Deliberately a separate signer from the 0G deployer: the 0G
    // EVM_DEPLOYER_PRIVATE_KEY was committed to .env.example and pushed, so
    // nothing that touches real USDC may reuse it.
    base: {
      url:      process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
      // The public endpoint rate-limits and drops connections. A deploy that
      // times out midway leaves the contract deployed but its roles ungranted,
      // which is far worse than a slow deploy — see scripts/grant-a2a-roles.ts.
      timeout: 120_000,
      accounts: BASE_DEPLOYER_KEY ? [BASE_DEPLOYER_KEY] : [],
      chainId:  8453,
      gasPrice: 'auto',
    },

    // ── Base Mainnet fork (local testing against real USDC/ERC-8004) ──────────
    // `pnpm hardhat node --fork $BASE_RPC_URL` then target this network. Escrow
    // tests run here so they exercise the real USDC contract rather than a mock.
    'base-fork': {
      url:     'http://127.0.0.1:8545',
      chainId: 8453,
    },

    // ── 0G Chain Testnet ──────────────────────────────────────────────────────
    // Chain ID : 16600
    // Used for staging the ARENA economy contracts before a mainnet deploy.
    // Previously referenced by package.json's deploy:testnet script but never
    // defined here — that script was broken until this entry was added.
    'zerog-testnet': {
      url:      process.env.ZEROG_EVM_RPC_TESTNET ?? 'https://evmrpc-testnet.0g.ai',
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
      chainId:  16600,
      gasPrice: 'auto',
    },
  },

  paths: {
    sources:   './contracts',
    tests:     './test',
    cache:     './cache',
    artifacts: './artifacts',
  },

  sourcify: {
    enabled: true,
  },

  etherscan: {
    apiKey: {
      'zerog-mainnet': 'no-api-key-required',
      base:            process.env.BASESCAN_API_KEY ?? '',
    },
    customChains: [
      {
        network:  'zerog-mainnet',
        chainId:  16661,
        urls: {
          apiURL:      'https://chainscan.0g.ai/api',
          browserURL:  'https://chainscan.0g.ai',
        },
      },
      {
        network:  'base',
        chainId:  8453,
        urls: {
          apiURL:     'https://api.basescan.org/api',
          browserURL: 'https://basescan.org',
        },
      },
    ],
  },
};

export default config;
