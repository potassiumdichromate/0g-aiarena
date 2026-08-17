/**
 * Verify a contract via the Etherscan V2 unified API.
 *
 * Why this exists rather than `hardhat verify`:
 *
 * BaseScan's V1 API is retired. Hitting it now returns, for any request with
 * or without a key:
 *
 *   {"status":"0","message":"NOTOK",
 *    "result":"You are using a deprecated V1 endpoint, switch to Etherscan API V2"}
 *
 * hardhat.config's `customChains` entry pointed at that dead endpoint, and the
 * bundled hardhat-verify predates V2 support. Etherscan V2 is a single
 * endpoint keyed by chainId, and an existing BaseScan API key works against it
 * unchanged — verified before writing this.
 *
 * The solc standard-json input is taken straight from Hardhat's build-info, so
 * the compiler version, optimizer settings and source set are byte-identical
 * to what produced the deployed bytecode. Reconstructing that by hand is the
 * usual reason verification fails.
 *
 *   npx hardhat run scripts/verify-etherscan-v2.ts --network base
 *
 * Env: A2A_JOB_ESCROW_ADDRESS, BASESCAN_API_KEY,
 *      plus the constructor args (deployer/usdc/treasury) resolved from chain.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { ethers } from 'hardhat';

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const CHAIN_ID = 8453;
const CONTRACT_PATH = 'contracts/base/A2AJobEscrow.sol';
const CONTRACT_NAME = 'A2AJobEscrow';

/** Locate the build-info that actually contains our contract. */
function findBuildInfo(): { solcLongVersion: string; input: unknown } {
  const dir = join(__dirname, '..', 'artifacts', 'build-info');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const info = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (info?.output?.contracts?.[CONTRACT_PATH]?.[CONTRACT_NAME]) {
      console.log(`  build-info: ${file}`);
      return { solcLongVersion: info.solcLongVersion, input: info.input };
    }
  }
  throw new Error(`No build-info contains ${CONTRACT_PATH}:${CONTRACT_NAME} — run \`npx hardhat compile\` first`);
}

async function post(params: Record<string, string>): Promise<{ status: string; message: string; result: string }> {
  const body = new URLSearchParams(params);
  const res = await fetch(`${ETHERSCAN_V2}?chainid=${CHAIN_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return res.json() as Promise<{ status: string; message: string; result: string }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const address = process.env.A2A_JOB_ESCROW_ADDRESS;
  const apiKey = process.env.BASESCAN_API_KEY;

  if (!address) throw new Error('A2A_JOB_ESCROW_ADDRESS is not set');
  if (!apiKey) throw new Error('BASESCAN_API_KEY is not set');

  console.log(`\nVerifying ${CONTRACT_NAME} at ${address} on chain ${CHAIN_ID}\n`);

  // Read the constructor args back off the chain rather than trusting .env —
  // a mismatch is the most common cause of a failed verification, and the
  // deployed contract is the authority on what it was built with.
  const escrow = await ethers.getContractAt(CONTRACT_NAME, address);
  const [usdc, treasury] = await Promise.all([escrow.usdc(), escrow.treasury()]);
  const adminRole = await escrow.DEFAULT_ADMIN_ROLE();

  const deployTx = await ethers.provider.getTransactionCount(address).catch(() => 0);
  void deployTx;

  // The admin is whoever holds DEFAULT_ADMIN_ROLE — normally the deployer.
  const admin = process.env.BASE_DEPLOYER_ADDRESS
    ?? (await ethers.getSigners())[0].address;
  if (!(await escrow.hasRole(adminRole, admin))) {
    throw new Error(
      `${admin} does not hold DEFAULT_ADMIN_ROLE — cannot infer the constructor's admin argument. ` +
        'Set BASE_DEPLOYER_ADDRESS to the deploying wallet.',
    );
  }

  console.log(`  admin:    ${admin}`);
  console.log(`  usdc:     ${usdc}`);
  console.log(`  treasury: ${treasury}`);

  const constructorArgs = ethers.AbiCoder.defaultAbiCoder()
    .encode(['address', 'address', 'address'], [admin, usdc, treasury])
    .slice(2);

  const { solcLongVersion, input } = findBuildInfo();
  console.log(`  solc:     v${solcLongVersion}\n`);

  const submit = await post({
    apikey: apiKey,
    module: 'contract',
    action: 'verifysourcecode',
    contractaddress: address,
    sourceCode: JSON.stringify(input),
    codeformat: 'solidity-standard-json-input',
    contractname: `${CONTRACT_PATH}:${CONTRACT_NAME}`,
    compilerversion: `v${solcLongVersion}`,
    constructorArguements: constructorArgs,
  });

  if (submit.status !== '1') {
    if (/already verified/i.test(submit.result)) {
      console.log(`Already verified.\nhttps://basescan.org/address/${address}#code\n`);
      return;
    }
    throw new Error(`Submission rejected: ${submit.result}`);
  }

  const guid = submit.result;
  console.log(`  submitted, guid ${guid}`);
  process.stdout.write('  waiting for result ');

  for (let i = 0; i < 30; i += 1) {
    await sleep(5000);
    process.stdout.write('.');

    const check = await post({
      apikey: apiKey,
      module: 'contract',
      action: 'checkverifystatus',
      guid,
    });

    if (/pending/i.test(check.result)) continue;

    if (check.status === '1' || /already verified/i.test(check.result)) {
      console.log(`\n\nVerified.\nhttps://basescan.org/address/${address}#code\n`);
      return;
    }

    throw new Error(`\nVerification failed: ${check.result}`);
  }

  throw new Error('\nTimed out waiting for verification; check BaseScan directly');
}

main().catch((err) => { console.error(`\n${err.message ?? err}\n`); process.exitCode = 1; });
