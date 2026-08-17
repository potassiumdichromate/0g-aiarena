import { ethers } from 'hardhat';

/**
 * One-time fix: authorizes the inft-service signer as an operator on the
 * already-deployed AIArenaINFT contract, so mintAgent() (onlyOperator) stops
 * reverting with "AIArenaINFT: not authorised operator".
 *
 * Must be run with the ORIGINAL INFT contract owner's key in
 * EVM_DEPLOYER_PRIVATE_KEY (0x63F63DC442299cCFe470657a769fdC6591d65eCa) --
 * NOT the ARENA economy deployer key from today's deploy. Swap .env's
 * EVM_DEPLOYER_PRIVATE_KEY to that owner's key before running this, then
 * swap it back afterward if you still need it for other scripts.
 */
const INFT_CONTRACT_ADDRESS = '0x67493Bb91e904840d39397E350f4A7865B779E10';
const OPERATOR_TO_AUTHORIZE = '0x043091b10bBcD3F8C5158C27AD291CC56B4F46db'; // inft-service's current signer

async function main() {
  const [signer] = await ethers.getSigners();
  console.log('Calling setOperator with account:', signer.address);

  const abi = [
    'function owner() view returns (address)',
    'function setOperator(address operator, bool authorised) external',
    'function authorisedOperators(address) view returns (bool)',
  ];
  const inft = new ethers.Contract(INFT_CONTRACT_ADDRESS, abi, signer);

  const owner = await inft.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`This signer (${signer.address}) is not the contract owner (${owner}). Wrong key.`);
  }

  const tx = await inft.setOperator(OPERATOR_TO_AUTHORIZE, true);
  console.log('Tx submitted:', tx.hash);
  await tx.wait();

  const isNowAuthorized = await inft.authorisedOperators(OPERATOR_TO_AUTHORIZE);
  console.log(`${OPERATOR_TO_AUTHORIZE} authorised operator:`, isNowAuthorized);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
