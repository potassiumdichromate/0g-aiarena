import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    localhost: {
      url: 'http://127.0.0.1:8545',
    },
    // 0G Chain Mainnet (Chain ID: 16661)
    // Explorer: https://chainscan.0g.ai
    'zerog-mainnet': {
      url: process.env.ZEROG_EVM_RPC_MAINNET ?? 'https://evmrpc.0g.ai',
      accounts: process.env.EVM_PRIVATE_KEY ? [process.env.EVM_PRIVATE_KEY] : [],
      chainId: 16661,
    },
    // 0G Chain Testnet (Chain ID: 16600)
    'zerog-testnet': {
      url: process.env.ZEROG_EVM_RPC_TESTNET ?? 'https://evmrpc-testnet.0g.ai',
      accounts: process.env.EVM_PRIVATE_KEY ? [process.env.EVM_PRIVATE_KEY] : [],
      chainId: 16600,
    },
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
};

export default config;
