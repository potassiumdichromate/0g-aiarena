import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import * as dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

const DEPLOYER_KEY = process.env.EVM_DEPLOYER_PRIVATE_KEY ?? '';

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
    // Tokens   : USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
    //            USDT 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2
    'base-mainnet': {
      url:      process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
      chainId:  8453,
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
      base:            process.env.BASESCAN_API_KEY ?? '',
      'zerog-mainnet': 'no-api-key-required',
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
    ],
  },
};

export default config;
