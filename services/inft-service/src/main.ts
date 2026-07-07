/**
 * INFT Service — ERC-7857 "Living NFT" management on 0G Chain.
 *
 * 0G Chain (EVM):
 *   Mainnet: Chain ID 16661 | RPC https://evmrpc.0g.ai
 *   Explorer: https://chainscan.0g.ai
 *
 * ERC-7857 key operations (all require oracle TEE proof):
 *   - transfer(from, to, tokenId, sealedKey, proof)  → TEE re-encrypts metadata for new owner
 *   - clone(to, tokenId, sealedKey, proof)           → spawn child INFT (max 3 per parent)
 *   - authorizeUsage(tokenId, executor, permissions) → grant inference rights
 *   - revokeUsage(tokenId, executor)                 → revoke inference rights
 *
 * All metadata stored on 0G Storage by Merkle root hash (not path strings).
 * The sealed AES key (ECIES) is stored on-chain per token.
 */

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import { ethers } from 'ethers';

const PORT         = parseInt(process.env.PORT ?? '8032', 10);
const SERVICE_NAME = 'inft-service';

// 0G Chain provider
const evmRpc = process.env.ZEROG_EVM_RPC
  ?? (process.env.ZEROG_NETWORK === 'mainnet'
    ? 'https://evmrpc.0g.ai'
    : 'https://evmrpc-testnet.0g.ai');

// AgentTraits tuple as defined in AIArenaINFT.sol
// struct AgentTraits { aggression, patience, adaptability, riskTolerance, precision, endurance, creativity, teamwork }
const TRAITS_TUPLE = 'tuple(uint8 aggression, uint8 patience, uint8 adaptability, uint8 riskTolerance, uint8 precision, uint8 endurance, uint8 creativity, uint8 teamwork)';

// AgentMetadata tuple as defined in AIArenaINFT.sol — matches the real
// public-getter ABI exactly (verified against the compiled artifact; the
// nested AgentTraits struct IS included since it has no arrays/mappings).
const AGENT_METADATA_TUPLE = `tuple(string agentId, string clan, string archetype, uint8 evolutionStage, uint32 wins, uint32 losses, uint32 draws, uint32 totalBattles, bytes32 memoryRootHash, string modelRootHash, string genesisRootHash, bytes32 encryptedMetadataHash, bytes sealedKey, uint256 mintedAt, uint256 lastEvolvedAt, uint256 lastBattleAt, uint256 lastTrainingAt, ${TRAITS_TUPLE} traits)`;

const INFT_ABI = [
  // ERC-7857 core
  'function transfer(address from, address to, uint256 tokenId, bytes calldata sealedKey, bytes calldata proof) external',
  'function clone(address to, uint256 tokenId, bytes calldata sealedKey, bytes calldata proof) external returns (uint256)',
  'function authorizeUsage(uint256 tokenId, address executor, bytes calldata permissions) external',
  'function revokeUsage(uint256 tokenId, address executor) external',
  'function hasValidUsage(uint256 tokenId, address executor) external view returns (bool)',
  // Metadata reads — matches AIArenaINFT.sol exactly (verified against the compiled ABI)
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function tokenURI(uint256 tokenId) external view returns (string)',
  `function getTraits(uint256 tokenId) external view returns (${TRAITS_TUPLE})`,
  'function getEvolutionStage(uint256 tokenId) external view returns (uint8)',
  `function agentMetadata(uint256 tokenId) external view returns (${AGENT_METADATA_TUPLE})`,
  'function cloneParent(uint256 tokenId) external view returns (uint256)',
  'function cloneCount(uint256 tokenId) external view returns (uint256)',
  'function agentIdToTokenId(string calldata agentId) external view returns (uint256)',
  'function setOperator(address operator, bool authorised) external',
  // Mint — matches AIArenaINFT.sol exactly
  // mintAgent(to, agentId, clan, archetype, traits, encryptedMetadataHash, sealedKey, genesisRootHash, tokenUri)
  `function mintAgent(address to, string calldata agentId, string calldata clan, string calldata archetype, ${TRAITS_TUPLE} calldata traits, bytes32 encryptedMetadataHash, bytes calldata sealedKey, string calldata genesisRootHash, string calldata tokenUri) external returns (uint256)`,
  // Evolve — matches AIArenaINFT.sol exactly: evolveAgent(tokenId, newTraits, newTokenUri).
  // The contract auto-increments evolutionStage; there is no newStage parameter.
  `function evolveAgent(uint256 tokenId, ${TRAITS_TUPLE} calldata newTraits, string calldata newTokenUri) external`,
  'function updateMemoryRoot(uint256 tokenId, bytes32 newMemoryRoot) external',
  // updateModelVersion(tokenId, modelRootHash, newEncryptedMetadataHash) — matches AIArenaINFT.sol exactly.
  // (The old ABI called a nonexistent `updateModelRoot(tokenId, modelRootHash)`.)
  'function updateModelVersion(uint256 tokenId, string calldata modelRootHash, bytes32 newEncryptedMetadataHash) external',
  // recordBattleResult(tokenId, won, draw) — matches AIArenaINFT.sol exactly.
  // (The old ABI called recordBattleResult(tokenId, won, eloChange) with a uint256 third
  // arg; the real contract's third parameter is a bool "draw" flag, not an ELO delta.
  // ELO is computed and stored off-chain in Postgres, not on this contract.)
  'function recordBattleResult(uint256 tokenId, bool won, bool draw) external',
  // Events — matches AIArenaINFT.sol
  'event AgentMinted(uint256 indexed tokenId, string agentId, address indexed owner, string clan)',
  'event AgentEvolved(uint256 indexed tokenId, uint8 fromStage, uint8 toStage)',
  'event BattleResultRecorded(uint256 indexed tokenId, bool won, uint32 totalBattles)',
  'event MemoryRootUpdated(uint256 indexed tokenId, bytes32 memoryRoot)',
  'event ModelVersionUpdated(uint256 indexed tokenId, string modelRootHash)',
  'event AgentCloned(uint256 indexed parentId, uint256 indexed cloneId, address to)',
  'event UsageAuthorized(uint256 indexed tokenId, address indexed executor, bytes permissions)',
  'event UsageRevoked(uint256 indexed tokenId, address indexed executor)',
];

function getProvider() {
  return new ethers.JsonRpcProvider(evmRpc);
}

function getContract(signerOrProvider?: ethers.Signer | ethers.Provider) {
  const address = process.env.ZEROG_INFT_CONTRACT_ADDRESS;
  if (!address) throw new Error('ZEROG_INFT_CONTRACT_ADDRESS not configured');
  return new ethers.Contract(address, INFT_ABI, signerOrProvider ?? getProvider());
}

function getAdminSigner() {
  const pk = process.env.ZEROG_STORAGE_PRIVATE_KEY;
  if (!pk) throw new Error('ZEROG_STORAGE_PRIVATE_KEY not configured');
  return new ethers.Wallet(pk, getProvider());
}

// ── Fastify app ──────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev-secret' });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.routerPath === '/health') return;
    // Internal service-to-service calls bypass JWT using a shared secret header
    const serviceKey    = req.headers['x-service-key'];
    const internalSecret = process.env.INTERNAL_SERVICE_SECRET;
    if (internalSecret && serviceKey === internalSecret) return;
    // Fall through to JWT verification for external / user-facing requests
    try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'Unauthorized' }); }
  });

  // ── Health ────────────────────────────────────────────────────────────────

  app.get('/health', async () => ({
    status: 'ok',
    service: SERVICE_NAME,
    network: process.env.ZEROG_NETWORK ?? 'testnet',
    evmRpc,
    contractAddress: process.env.ZEROG_INFT_CONTRACT_ADDRESS ?? 'NOT_SET',
  }));

  // ── GET /inft/:tokenId — fetch INFT metadata ──────────────────────────────

  app.get<{ Params: { tokenId: string } }>('/inft/:tokenId', async (req, reply) => {
    const tokenId = BigInt(req.params.tokenId);
    const contract = getContract();

    const [owner, uri, metadata, traits, parentTokenId, cloneCount] = await Promise.all([
      contract.ownerOf(tokenId),
      contract.tokenURI(tokenId),
      contract.agentMetadata(tokenId),
      contract.getTraits(tokenId),
      contract.cloneParent(tokenId),
      contract.cloneCount(tokenId),
    ]);

    return {
      tokenId: req.params.tokenId,
      owner,
      tokenUri: uri,
      metadata: {
        agentId:               metadata.agentId,
        clan:                  metadata.clan,
        archetype:             metadata.archetype,
        encryptedMetadataHash: metadata.encryptedMetadataHash,
        memoryRootHash:        metadata.memoryRootHash,
        modelRootHash:         metadata.modelRootHash,
        genesisRootHash:       metadata.genesisRootHash,
        evolutionStage:        Number(metadata.evolutionStage),
        wins:                  Number(metadata.wins),
        losses:                Number(metadata.losses),
        draws:                 Number(metadata.draws),
        totalBattles:          Number(metadata.totalBattles),
        isClone:               parentTokenId !== 0n,
        parentTokenId:         parentTokenId.toString(),
        cloneCount:            Number(cloneCount),
        mintedAt:              Number(metadata.mintedAt),
        lastEvolvedAt:         Number(metadata.lastEvolvedAt),
        lastBattleAt:          Number(metadata.lastBattleAt),
        lastTrainingAt:        Number(metadata.lastTrainingAt),
      },
      // Trait field names match AIArenaINFT.sol's AgentTraits struct exactly.
      traits: {
        aggression:    Number(traits.aggression),
        patience:      Number(traits.patience),
        adaptability:  Number(traits.adaptability),
        riskTolerance: Number(traits.riskTolerance),
        precision:     Number(traits.precision),
        endurance:     Number(traits.endurance),
        creativity:    Number(traits.creativity),
        teamwork:      Number(traits.teamwork),
      },
    };
  });

  // ── POST /inft/mint — mint a new agent INFT ────────────────────────────────

  app.post<{
    Body: {
      to: string;
      agentId: string;
      clan?: string;
      archetype?: string;
      traits: Record<string, number>;
      encryptedMetadataHash: string;
      genesisRootHash?: string;
      tokenUri?: string;
    };
  }>('/inft/mint', async (req, reply) => {
    const { to, agentId, clan = 'zerog', archetype = 'berserker', traits, encryptedMetadataHash, genesisRootHash = '', tokenUri = '' } = req.body;

    const signer   = getAdminSigner();
    const contract = getContract(signer);

    const traitsStruct = {
      aggression:    traits.aggression   ?? 50,
      patience:      traits.patience     ?? 50,
      adaptability:  traits.adaptability ?? 50,
      riskTolerance: traits.resilience   ?? 50,
      precision:     traits.precision    ?? 50,
      endurance:     traits.loyalty      ?? 50,
      creativity:    traits.creativity   ?? 50,
      teamwork:      traits.teamwork     ?? 50,
    };

    let hashBytes: string;
    if (ethers.isHexString(encryptedMetadataHash, 32)) {
      hashBytes = encryptedMetadataHash;
    } else {
      hashBytes = ethers.keccak256(ethers.toUtf8Bytes(encryptedMetadataHash));
    }

    const tx = await contract.mintAgent(
      to, agentId, clan, archetype, traitsStruct, hashBytes, '0x00', genesisRootHash, tokenUri,
    );

    const receipt = await tx.wait();
    const mintEvent = receipt.logs
      .map((l: ethers.Log) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .find((e: ethers.LogDescription | null) => e?.name === 'AgentMinted');

    return {
      txHash:  receipt.hash,
      tokenId: mintEvent?.args?.tokenId?.toString() ?? null,
      owner:   to,
    };
  });

  // ── POST /inft/:tokenId/authorize — grant inference usage rights ──────────

  app.post<{
    Params: { tokenId: string };
    Body: { executor: string; permissions: string };
  }>('/inft/:tokenId/authorize', async (req, reply) => {
    const { executor, permissions } = req.body;
    const tokenId  = BigInt(req.params.tokenId);
    const signer   = getAdminSigner();
    const contract = getContract(signer);

    const permBytes = ethers.toUtf8Bytes(permissions);
    const tx        = await contract.authorizeUsage(tokenId, executor, permBytes);
    const receipt   = await tx.wait();

    return { txHash: receipt.hash, tokenId: req.params.tokenId, executor };
  });

  // ── DELETE /inft/:tokenId/authorize/:executor — revoke usage ─────────────

  app.delete<{
    Params: { tokenId: string; executor: string };
  }>('/inft/:tokenId/authorize/:executor', async (req, reply) => {
    const tokenId  = BigInt(req.params.tokenId);
    const signer   = getAdminSigner();
    const contract = getContract(signer);

    const tx      = await contract.revokeUsage(tokenId, req.params.executor);
    const receipt = await tx.wait();

    return { txHash: receipt.hash, tokenId: req.params.tokenId, revoked: req.params.executor };
  });

  // ── GET /inft/:tokenId/usage/:executor — check usage validity ────────────

  app.get<{
    Params: { tokenId: string; executor: string };
  }>('/inft/:tokenId/usage/:executor', async (req, reply) => {
    const contract = getContract();
    const valid = await contract.hasValidUsage(BigInt(req.params.tokenId), req.params.executor);
    return { tokenId: req.params.tokenId, executor: req.params.executor, valid };
  });

  // ── POST /inft/:tokenId/update-memory — anchor new memory root hash ───────

  app.post<{
    Params: { tokenId: string };
    Body: { memoryRootHash: string };
  }>('/inft/:tokenId/update-memory', async (req, reply) => {
    const tokenId  = BigInt(req.params.tokenId);
    const signer   = getAdminSigner();
    const contract = getContract(signer);

    const rootHashBytes = ethers.zeroPadValue(
      ethers.hexlify(ethers.toUtf8Bytes(req.body.memoryRootHash)).slice(0, 66),
      32,
    );

    const tx      = await contract.updateMemoryRoot(tokenId, rootHashBytes);
    const receipt = await tx.wait();

    return { txHash: receipt.hash, tokenId: req.params.tokenId, memoryRootHash: req.body.memoryRootHash };
  });

  // ── POST /inft/:tokenId/update-model — anchor new LoRA model root hash ────
  // Matches AIArenaINFT.updateModelVersion(tokenId, modelRootHash, newEncryptedMetadataHash).
  // If the caller doesn't supply a fresh encryptedMetadataHash (most callers only have a
  // new model root), we derive one deterministically from the model root hash rather than
  // silently reusing the previous value — the contract requires a bytes32 either way.

  app.post<{
    Params: { tokenId: string };
    Body: { modelRootHash: string; encryptedMetadataHash?: string };
  }>('/inft/:tokenId/update-model', async (req, reply) => {
    const tokenId  = BigInt(req.params.tokenId);
    const signer   = getAdminSigner();
    const contract = getContract(signer);

    const encryptedMetadataHashBytes = req.body.encryptedMetadataHash && ethers.isHexString(req.body.encryptedMetadataHash, 32)
      ? req.body.encryptedMetadataHash
      : ethers.keccak256(ethers.toUtf8Bytes(req.body.modelRootHash));

    const tx      = await contract.updateModelVersion(tokenId, req.body.modelRootHash, encryptedMetadataHashBytes);
    const receipt = await tx.wait();

    return { txHash: receipt.hash, tokenId: req.params.tokenId, modelRootHash: req.body.modelRootHash };
  });

  // ── POST /inft/:tokenId/evolve — evolve to next stage ────────────────────
  // Matches AIArenaINFT.evolveAgent(tokenId, newTraits, newTokenUri) — the contract
  // auto-increments evolutionStage itself; there is no newStage parameter to pass.
  // Trait field names match AgentTraits exactly: aggression, patience, adaptability,
  // riskTolerance, precision, endurance, creativity, teamwork.

  app.post<{
    Params: { tokenId: string };
    Body: { newTraits: Record<string, number>; newTokenUri?: string };
  }>('/inft/:tokenId/evolve', async (req, reply) => {
    const { newTraits, newTokenUri = '' } = req.body;
    const tokenId  = BigInt(req.params.tokenId);
    const signer   = getAdminSigner();
    const contract = getContract(signer);

    const traitsStruct = {
      aggression:    Math.round(newTraits.aggression    ?? 50),
      patience:      Math.round(newTraits.patience      ?? 50),
      adaptability:  Math.round(newTraits.adaptability  ?? 50),
      riskTolerance: Math.round(newTraits.riskTolerance ?? newTraits.resilience ?? 50),
      precision:     Math.round(newTraits.precision     ?? 50),
      endurance:     Math.round(newTraits.endurance     ?? newTraits.loyalty    ?? 50),
      creativity:    Math.round(newTraits.creativity    ?? 50),
      teamwork:      Math.round(newTraits.teamwork      ?? newTraits.deception  ?? 50),
    };

    const tx      = await contract.evolveAgent(tokenId, traitsStruct, newTokenUri);
    const receipt = await tx.wait();

    const evolvedEvent = receipt.logs
      .map((l: ethers.Log) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .find((e: ethers.LogDescription | null) => e?.name === 'AgentEvolved');

    return {
      txHash: receipt.hash,
      tokenId: req.params.tokenId,
      newStage: evolvedEvent ? Number(evolvedEvent.args.toStage) : null,
    };
  });

  // ── POST /inft/:tokenId/battle-result — record battle outcome on-chain ────
  // Matches AIArenaINFT.recordBattleResult(tokenId, won, draw) — the third
  // parameter is a draw flag, not an ELO delta. ELO itself is computed and
  // stored off-chain (see leaderboard-service); this call only updates the
  // on-chain wins/losses/draws counters.

  app.post<{
    Params: { tokenId: string };
    Body: { won: boolean; draw?: boolean };
  }>('/inft/:tokenId/battle-result', async (req, reply) => {
    const { won, draw = false } = req.body;
    const tokenId  = BigInt(req.params.tokenId);
    const signer   = getAdminSigner();
    const contract = getContract(signer);

    const tx      = await contract.recordBattleResult(tokenId, won, draw);
    const receipt = await tx.wait();

    return { txHash: receipt.hash, tokenId: req.params.tokenId, won, draw };
  });

  // ── POST /inft/agent-mint — internal service-to-service INFT mint ────────
  // Called by agent-service after an agent is created.
  // Auth: X-Service-Key header (INTERNAL_SERVICE_SECRET env var) — NOT a user JWT.

  app.post<{
    Body: {
      agentId: string;
      clan?: string;
      archetype?: string;
      traits: Record<string, number>;
      metadataRootHash: string | null;
    };
  }>('/inft/agent-mint', async (req, reply) => {
    const { agentId, clan = 'ZEROG', archetype = 'BERSERKER', traits, metadataRootHash } = req.body;

    const signer    = getAdminSigner();
    const contract  = getContract(signer);
    const toAddress = await signer.getAddress();

    // Map our DB trait names → contract AgentTraits struct field names
    // Contract: aggression, patience, adaptability, riskTolerance, precision, endurance, creativity, teamwork
    const traitsStruct = {
      aggression:   Math.round(traits.aggression   ?? 50),
      patience:     Math.round(traits.patience     ?? 50),
      adaptability: Math.round(traits.adaptability ?? 50),
      riskTolerance:Math.round(traits.resilience   ?? 50), // resilience → riskTolerance
      precision:    Math.round(traits.precision    ?? 50),
      endurance:    Math.round(traits.loyalty      ?? 50), // loyalty → endurance
      creativity:   Math.round(traits.creativity   ?? 50),
      teamwork:     Math.round(traits.deception    ?? 50), // deception → teamwork (closest available)
    };

    // encryptedMetadataHash must be bytes32 — convert from 0G Storage root hash hex string
    let encryptedMetadataHashBytes: string;
    if (metadataRootHash && ethers.isHexString(metadataRootHash, 32)) {
      encryptedMetadataHashBytes = metadataRootHash; // already 32-byte hex
    } else if (metadataRootHash) {
      // hash the string to get bytes32
      encryptedMetadataHashBytes = ethers.keccak256(ethers.toUtf8Bytes(metadataRootHash));
    } else {
      encryptedMetadataHashBytes = ethers.keccak256(ethers.toUtf8Bytes(agentId));
    }

    // Dummy sealed key — real ECIES key set on ownership transfer
    const sealedKey      = '0x00';
    const genesisRootHash = metadataRootHash ?? '';
    const tokenUri        = `https://aiarena-gateway.onrender.com/v1/agents/${agentId}/metadata`;

    const tx = await contract.mintAgent(
      toAddress,
      agentId,
      clan.toLowerCase(),
      archetype.toLowerCase(),
      traitsStruct,
      encryptedMetadataHashBytes,
      sealedKey,
      genesisRootHash,
      tokenUri,
    );

    const receipt = await tx.wait();

    const mintEvent = receipt.logs
      .map((l: ethers.Log) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .find((e: ethers.LogDescription | null) => e?.name === 'AgentMinted');

    const tokenId = mintEvent?.args?.tokenId?.toString() ?? null;

    app.log.info(`[inft-service] Minted INFT token ${tokenId} for agent ${agentId} — tx ${receipt.hash}`);

    return {
      txHash:  receipt.hash,
      tokenId,
      owner:   toAddress,
      agentId,
    };
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`${SERVICE_NAME} running on port ${PORT} (0G ${process.env.ZEROG_NETWORK ?? 'testnet'})`);
}

bootstrap().catch(err => { console.error(err); process.exit(1); });
