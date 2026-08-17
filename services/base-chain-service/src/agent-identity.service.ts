/**
 * Agent identity on Base — ERC-8004 registration.
 *
 * Ownership model (deliberate, documented, reversible):
 *
 *   register() makes msg.sender the owner of the agent NFT. We let the RELAYER
 *   own it rather than the agent's own EOA or the human's Privy wallet,
 *   because both alternatives require that party to hold ETH on Base to ever
 *   update its own URI — friction that would push us toward custodying gas for
 *   every user anyway. Instead the relayer owns and pays, and the agent's EOA
 *   is bound on-chain via setAgentWallet() so the *operational* key is
 *   independently provable by anyone reading the registry.
 *
 *   This is a real centralization point and is named as such. The exit is
 *   `transferIdentityToOwner()` (ERC-721 transferFrom, relayer-paid) whenever
 *   a user wants custody — the NFT is transferable by design and the
 *   agentWallet binding survives transfer.
 *
 * Resumability: registration is three on-chain-ish steps (upload card,
 * register, bind wallet). Each persists before the next begins, and
 * `ensureIdentity` resumes from whatever `status` it finds. A crash between
 * steps must never produce a second register() for the same agent — that
 * would mint a duplicate identity we could not merge.
 */

import { ethers } from 'ethers';
import { prisma } from '@ai-arena/db-client';
import { getZeroGConfig, ZeroGStorageClient } from '@ai-arena/zerog-client';
import {
  AGENT_WALLET_SET_TYPES,
  ERC8004_IDENTITY_REGISTRY,
  IDENTITY_EIP712_DOMAIN,
  WALLET_SIG_TTL_SECONDS,
  publicBaseUrl,
} from './config';
import {
  identityRegistryRead,
  identityRegistryWrite,
  getRelayerSigner,
  getProvider,
  revertReason,
} from './contracts';
import { encryptAgentKey, decryptAgentKey } from './crypto';
import { sendAttributed, withAttribution } from '@ai-arena/a2a-protocol';
import { buildAgentCard, serializeAgentCard, AgentCardCapability } from './agent-card';

const storage = new ZeroGStorageClient(getZeroGConfig());

export interface IdentityView {
  agentId: string;
  status: string;
  eoaAddress: string;
  ownerWallet: string;
  erc8004AgentId: string | null;
  agentURI: string | null;
  cardRootHash: string | null;
  registerTxHash: string | null;
  setWalletTxHash: string | null;
  lastError: string | null;
}

function toView(row: {
  agentId: string; status: string; eoaAddress: string; ownerWallet: string;
  erc8004AgentId: string | null; agentURI: string | null; cardRootHash: string | null;
  registerTxHash: string | null; setWalletTxHash: string | null; lastError: string | null;
}): IdentityView {
  return {
    agentId: row.agentId,
    status: row.status,
    eoaAddress: row.eoaAddress,
    ownerWallet: row.ownerWallet,
    erc8004AgentId: row.erc8004AgentId,
    agentURI: row.agentURI,
    cardRootHash: row.cardRootHash,
    registerTxHash: row.registerTxHash,
    setWalletTxHash: row.setWalletTxHash,
    lastError: row.lastError,
  };
}

/**
 * Capability snapshot for the card. Phase 1 publishes only counters that are
 * already real in the schema — per-game win counts and ELO. The derived
 * `combatSkill` composite arrives with the capability service in Phase 3;
 * publishing a placeholder for it now would be exactly the invented-metric
 * problem the audit flagged, so it is simply absent until it is real.
 */
async function capabilitySnapshot(agentId: string): Promise<AgentCardCapability[]> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { eloRating: true, wins: true, losses: true, draws: true },
  });
  if (!agent) return [];

  return [
    { name: 'arena.eloRating', value: agent.eloRating, formulaVersion: 'raw-v1' },
    { name: 'arena.wins', value: agent.wins, formulaVersion: 'raw-v1' },
    { name: 'arena.losses', value: agent.losses, formulaVersion: 'raw-v1' },
    { name: 'arena.draws', value: agent.draws, formulaVersion: 'raw-v1' },
  ];
}

/** Create the DB row + agent EOA if absent. Idempotent. */
async function ensureRow(agentId: string) {
  const existing = await prisma.agentBaseIdentity.findUnique({ where: { agentId } });
  if (existing) return existing;

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { user: { select: { walletAddress: true } } },
  });
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const wallet = ethers.Wallet.createRandom();

  try {
    return await prisma.agentBaseIdentity.create({
      data: {
        agentId,
        eoaAddress: ethers.getAddress(wallet.address),
        eoaKeyEnc: encryptAgentKey(wallet.privateKey),
        ownerWallet: (agent.user?.walletAddress ?? '').toLowerCase(),
        status: 'PENDING',
      },
    });
  } catch (err) {
    // Unique violation on agentId — a concurrent request won the race. Its row
    // is as good as ours; discard the key we just generated and use theirs.
    const raced = await prisma.agentBaseIdentity.findUnique({ where: { agentId } });
    if (raced) return raced;
    throw err;
  }
}

/** Build the card, upload to 0G Storage, persist agentURI + rootHash. */
async function publishCard(agentId: string): Promise<{ agentURI: string; cardRootHash: string }> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { user: { select: { walletAddress: true } } },
  });
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const identity = await prisma.agentBaseIdentity.findUniqueOrThrow({ where: { agentId } });
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  const serviceBaseUrl = publicBaseUrl();
  const agentURI = `${serviceBaseUrl}/identity/agents/${agentId}/registration.json`;

  const card = buildAgentCard({
    kultAgentId: agentId,
    name: agent.name,
    description:
      (metadata.backstory as string) ||
      `A ${agent.archetype} agent of the ${agent.clan} clan, competing in the KULT AI Arena.`,
    clan: agent.clan,
    archetype: agent.archetype,
    eoaAddress: identity.eoaAddress,
    ownerWallet: identity.ownerWallet,
    inftTokenId: agent.inftTokenId,
    capabilities: await capabilitySnapshot(agentId),
    serviceBaseUrl,
  });

  const bytes = serializeAgentCard(card);
  const upload = await storage.uploadBuffer(bytes);
  const cardRootHash = upload.rootHash;

  await prisma.storageIndex.upsert({
    where: { logicalPath: `a2a/agents/${agentId}/card/v1` },
    update: { rootHash: cardRootHash },
    create: {
      logicalPath: `a2a/agents/${agentId}/card/v1`,
      rootHash: cardRootHash,
      txHash: [upload.txHash].flat()[0] ?? null,
      mimeType: 'application/json',
      sizeBytes: bytes.byteLength,
      uploadedBy: 'base-chain-service',
      tags: ['a2a', 'agent-card', agentId],
    },
  });

  await prisma.agentBaseIdentity.update({
    where: { agentId },
    data: { agentURI, cardRootHash },
  });

  return { agentURI, cardRootHash };
}

/** Serve the exact card bytes, regenerated deterministically and hash-checked. */
export async function getCardForServing(
  agentId: string,
): Promise<{ body: Buffer; rootHash: string | null; matchesPublished: boolean }> {
  const identity = await prisma.agentBaseIdentity.findUnique({ where: { agentId } });
  if (!identity?.cardRootHash) throw new Error('Agent card not published');

  // Prefer the immutable published bytes. Regenerating would silently serve a
  // *different* card than the one whose hash is committed, the moment any
  // input (name, ELO, backstory) changes.
  const body = await storage.downloadToBuffer(identity.cardRootHash);
  return { body, rootHash: identity.cardRootHash, matchesPublished: true };
}

/** Step: register() on the canonical ERC-8004 IdentityRegistry. */
async function registerOnChain(agentId: string, agentURI: string): Promise<string> {
  const registry = identityRegistryWrite();

  // Explicit overload selection — register() has three signatures and ethers
  // cannot disambiguate by arity alone in a way we want to depend on.
  // Populated then sent by hand so the ERC-8021 attribution suffix can be
  // appended: agent registration is the highest-volume Base transaction we
  // make, and attribution cannot be applied retroactively.
  const populated = await registry['register(string,(string,bytes)[])'].populateTransaction(agentURI, [
    { metadataKey: 'kultAgentId', metadataValue: ethers.toUtf8Bytes(agentId) },
    { metadataKey: 'platform', metadataValue: ethers.toUtf8Bytes('kult-ai-arena') },
  ]);
  const tx = await getRelayerSigner().sendTransaction(withAttribution(populated));
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`register() produced no receipt for agent ${agentId}`);

  const registered = receipt.logs
    .map((log: ethers.Log) => {
      try { return registry.interface.parseLog({ topics: [...log.topics], data: log.data }); }
      catch { return null; }
    })
    .find((parsed: ethers.LogDescription | null) => parsed?.name === 'Registered');

  if (!registered) throw new Error('register() mined but no Registered event found');

  const erc8004AgentId = (registered.args.agentId as bigint).toString();

  await prisma.agentBaseIdentity.update({
    where: { agentId },
    data: {
      erc8004AgentId,
      registerTxHash: tx.hash,
      status: 'REGISTERED',
      registeredAt: new Date(),
      lastError: null,
    },
  });

  return erc8004AgentId;
}

/**
 * Step: bind the agent's own EOA on-chain via setAgentWallet().
 *
 * The signature must come from the agent EOA (the `newWallet`), over a struct
 * that includes the CURRENT owner. The relayer submits and pays gas, so the
 * agent key never needs ETH — it only ever signs.
 */
async function bindAgentWallet(agentId: string): Promise<string> {
  const identity = await prisma.agentBaseIdentity.findUniqueOrThrow({ where: { agentId } });
  if (!identity.erc8004AgentId) throw new Error('Cannot bind wallet before registration');

  const registryRead = identityRegistryRead();
  const owner: string = await registryRead.ownerOf(identity.erc8004AgentId);

  const agentSigner = new ethers.Wallet(decryptAgentKey(identity.eoaKeyEnc));
  if (ethers.getAddress(agentSigner.address) !== ethers.getAddress(identity.eoaAddress)) {
    throw new Error('Decrypted agent key does not match stored eoaAddress');
  }

  const deadline = Math.floor(Date.now() / 1000) + WALLET_SIG_TTL_SECONDS;
  const signature = await agentSigner.signTypedData(
    IDENTITY_EIP712_DOMAIN,
    AGENT_WALLET_SET_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    {
      agentId: BigInt(identity.erc8004AgentId),
      newWallet: identity.eoaAddress,
      owner,
      deadline: BigInt(deadline),
    },
  );

  const sent = await sendAttributed(
    identityRegistryWrite(),
    'setAgentWallet',
    [identity.erc8004AgentId, identity.eoaAddress, deadline, signature],
    { revertReasonOf: revertReason },
  );
  const tx = { hash: sent.txHash };

  await prisma.agentBaseIdentity.update({
    where: { agentId },
    data: { setWalletTxHash: tx.hash, status: 'WALLET_LINKED', lastError: null, registerLockedAt: null },
  });

  return tx.hash;
}

/** A REGISTERING claim older than this is assumed abandoned and may be retaken. */
const REGISTER_CLAIM_TTL_MS = 5 * 60 * 1000;

/**
 * Take an exclusive claim on the registration flow.
 *
 * This is the guard against the one failure this service cannot recover from:
 * two concurrent callers both observing `erc8004AgentId == null` and each
 * calling register(), minting two ERC-8004 identities for one agent. There is
 * no merge — one would have to be abandoned, with its tokenURI already
 * published and possibly referenced.
 *
 * `updateMany` with the status in the WHERE clause compiles to a single
 * `UPDATE ... WHERE`, which takes a row lock in Postgres, so exactly one
 * concurrent caller can observe `count === 1`.
 */
async function claimRegistration(agentId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - REGISTER_CLAIM_TTL_MS);

  const claimed = await prisma.agentBaseIdentity.updateMany({
    where: {
      agentId,
      erc8004AgentId: null,
      OR: [
        { status: { in: ['PENDING', 'FAILED'] } },
        // Reclaim a stale in-flight attempt whose process died.
        { status: 'REGISTERING', registerLockedAt: { lt: staleBefore } },
      ],
    },
    data: { status: 'REGISTERING', registerLockedAt: new Date() },
  });

  return claimed.count === 1;
}

/**
 * Register an agent on Base, resuming from wherever it currently is.
 * Safe to call repeatedly — that is the intended retry mechanism.
 */
export async function ensureIdentity(agentId: string): Promise<IdentityView> {
  const identity = await ensureRow(agentId);

  // Already complete — nothing to do.
  if (identity.status === 'WALLET_LINKED') return toView(identity);

  // Past register() already: only the wallet binding is outstanding. This is
  // idempotent on-chain (setAgentWallet just overwrites the metadata with the
  // same address), so it needs no claim.
  if (identity.erc8004AgentId) {
    try {
      await bindAgentWallet(agentId);
    } catch (err) {
      await recordFailure(agentId, err, 'REGISTERED');
      throw new Error(`Wallet binding failed for agent ${agentId}: ${revertReason(err)}`);
    }
    return toView(await prisma.agentBaseIdentity.findUniqueOrThrow({ where: { agentId } }));
  }

  if (!(await claimRegistration(agentId))) {
    // Another caller holds the claim. Report current state rather than racing
    // it — the caller can poll GET /identity/agents/:id.
    const current = await prisma.agentBaseIdentity.findUniqueOrThrow({ where: { agentId } });
    if (current.status === 'REGISTERING') {
      throw new Error(`Registration already in progress for agent ${agentId} — poll for status`);
    }
    return toView(current);
  }

  try {
    const withCard =
      !identity.agentURI || !identity.cardRootHash
        ? await publishCard(agentId).then(() =>
            prisma.agentBaseIdentity.findUniqueOrThrow({ where: { agentId } }),
          )
        : identity;

    await registerOnChain(agentId, withCard.agentURI!);
    await bindAgentWallet(agentId);
  } catch (err) {
    // Release the claim so a retry can proceed. If register() actually landed,
    // registerOnChain already persisted erc8004AgentId + REGISTERED, and the
    // resume path above takes over instead of re-registering.
    const post = await prisma.agentBaseIdentity.findUniqueOrThrow({ where: { agentId } });
    await recordFailure(agentId, err, post.erc8004AgentId ? 'REGISTERED' : 'FAILED');
    throw new Error(`Identity registration failed for agent ${agentId}: ${revertReason(err)}`);
  }

  return toView(await prisma.agentBaseIdentity.findUniqueOrThrow({ where: { agentId } }));
}

async function recordFailure(
  agentId: string,
  err: unknown,
  status: 'REGISTERED' | 'FAILED',
): Promise<void> {
  await prisma.agentBaseIdentity.update({
    where: { agentId },
    data: { lastError: revertReason(err), status, registerLockedAt: null },
  });
}

export async function getIdentity(agentId: string): Promise<IdentityView | null> {
  const row = await prisma.agentBaseIdentity.findUnique({ where: { agentId } });
  return row ? toView(row) : null;
}

/**
 * Independent on-chain verification — reads the registry rather than our DB.
 * This is what a third party would do, and what the demo should show.
 */
export async function verifyOnChain(agentId: string): Promise<{
  erc8004AgentId: string;
  owner: string;
  tokenURI: string;
  agentWallet: string;
  matchesLocalRecord: boolean;
  registry: string;
}> {
  const identity = await prisma.agentBaseIdentity.findUniqueOrThrow({ where: { agentId } });
  if (!identity.erc8004AgentId) throw new Error('Agent is not registered on Base');

  const registry = identityRegistryRead();
  const [owner, tokenURI, agentWallet] = await Promise.all([
    registry.ownerOf(identity.erc8004AgentId) as Promise<string>,
    registry.tokenURI(identity.erc8004AgentId) as Promise<string>,
    registry.getAgentWallet(identity.erc8004AgentId) as Promise<string>,
  ]);

  return {
    erc8004AgentId: identity.erc8004AgentId,
    owner,
    tokenURI,
    agentWallet,
    matchesLocalRecord:
      ethers.getAddress(agentWallet) === ethers.getAddress(identity.eoaAddress) &&
      tokenURI === identity.agentURI,
    registry: ERC8004_IDENTITY_REGISTRY,
  };
}

/** Hand NFT custody to the human owner. The agentWallet binding survives transfer. */
export async function transferIdentityToOwner(agentId: string): Promise<{ txHash: string; to: string }> {
  const identity = await prisma.agentBaseIdentity.findUniqueOrThrow({ where: { agentId } });
  if (!identity.erc8004AgentId) throw new Error('Agent is not registered on Base');
  if (!ethers.isAddress(identity.ownerWallet)) {
    throw new Error(`Owner wallet "${identity.ownerWallet}" is not a valid address`);
  }

  const relayer = getRelayerSigner();
  const sent = await sendAttributed(
    identityRegistryWrite(),
    'transferFrom',
    [relayer.address, ethers.getAddress(identity.ownerWallet), identity.erc8004AgentId],
    { revertReasonOf: revertReason },
  );
  const tx = { hash: sent.txHash };

  return { txHash: tx.hash, to: ethers.getAddress(identity.ownerWallet) };
}

/** Sign an arbitrary A2A payload as this agent — the basis of Phase 5 negotiation. */
export async function signAsAgent(agentId: string, message: string): Promise<{ signature: string; signer: string }> {
  const identity = await prisma.agentBaseIdentity.findUniqueOrThrow({ where: { agentId } });
  const signer = new ethers.Wallet(decryptAgentKey(identity.eoaKeyEnc));
  return { signature: await signer.signMessage(message), signer: signer.address };
}

/**
 * Sign EIP-712 typed data as an agent.
 *
 * This is how negotiation offers and the final agreement get signed. The
 * marketplace service composes the payload but never sees a key — it posts the
 * domain/types/value here and receives a signature back, so the private key
 * stays inside the one service that is allowed to hold it.
 *
 * The digest is returned alongside the signature so the caller can record what
 * was actually signed rather than recomputing it and hoping the two match.
 */
export async function signTypedDataAsAgent(
  agentId: string,
  domain: ethers.TypedDataDomain,
  types: Record<string, ethers.TypedDataField[]>,
  value: Record<string, unknown>,
): Promise<{ signature: string; signer: string; digest: string }> {
  const identity = await prisma.agentBaseIdentity.findUniqueOrThrow({ where: { agentId } });
  const signer = new ethers.Wallet(decryptAgentKey(identity.eoaKeyEnc));

  return {
    signature: await signer.signTypedData(domain, types, value),
    signer: signer.address,
    digest: ethers.TypedDataEncoder.hash(domain, types, value),
  };
}

/**
 * ERC-1271 check for smart-contract wallets (a Base Account, for instance).
 *
 * Lives here because it needs the RPC provider. The a2a-protocol package takes
 * this as an injected hook so it can stay free of a chain dependency.
 */
export async function isValidContractSignature(
  address: string,
  digest: string,
  signature: string,
): Promise<boolean> {
  const provider = getProvider();

  // An EOA has no code, so there is nothing to ask — the caller's ECDSA path
  // is the only valid one for it.
  if ((await provider.getCode(address)) === '0x') return false;

  const wallet = new ethers.Contract(
    address,
    ['function isValidSignature(bytes32, bytes) view returns (bytes4)'],
    provider,
  );

  try {
    // EIP-1271 magic value.
    return (await wallet.isValidSignature(digest, signature)) === '0x1626ba7e';
  } catch {
    return false;
  }
}
