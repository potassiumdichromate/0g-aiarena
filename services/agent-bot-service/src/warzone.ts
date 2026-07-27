/**
 * Warzone save uploader — gives each cycle's bot its own game-save data on
 * 0G Storage via the WarzoneWarrior backend's binary save/load API.
 *
 * Auth there is real SIWE-style (nonce -> sign -> login), not a shared
 * secret, so we just generate a fresh throwaway ECDSA wallet locally and
 * sign with it -- no coordination with that backend needed.
 *
 * Wire format (WZSV), mirrors src/controllers/zgController.js in the
 * warzone backend:
 *   [4 bytes] Magic "WZSV"  [1 byte] Version 0x01  [N bytes] JSON payload
 */

import { ethers } from 'ethers';

const WARZONE_URL = (process.env.WARZONE_BACKEND_URL ?? 'https://zerog-warzonewarriors.onrender.com').replace(/\/$/, '');

const MAGIC = Buffer.from([0x57, 0x5a, 0x53, 0x56]); // "WZSV"
const VERSION = 0x01;

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function buildRandomSavePayload() {
  return {
    PlayerProfile: {
      level: randInt(1, 15),
      exp: randInt(0, 500),
      totalTimePlayed: randInt(0, 36_000),
    },
    PlayerResources: {
      coin: randInt(200, 5000),
      gem: randInt(0, 50),
      stamina: randInt(0, 100),
      medal: randInt(0, 100),
      tournamentTicket: randInt(0, 5),
    },
    PlayerRambos: { '0': { id: 0, level: randInt(1, 5) } },
    PlayerRamboSkills: {
      '0': Object.fromEntries(Array.from({ length: 18 }, (_, i) => [i, 0])),
    },
    PlayerGuns: { '0': { id: 0, level: randInt(1, 5), ammo: 0, isNew: false } },
    PlayerGrenades: { '500': { id: 500, level: 1, quantity: randInt(0, 20), isNew: false } },
    PlayerMeleeWeapons: { '600': { id: 600, level: 1, isNew: false } },
    PlayerCampaignStageProgress: {},
    PlayerCampaignRewardProgress: {},
    PlayerBoosters: { Hp: 0, Grenade: 0, Damage: 0, CoinMagnet: 0, Speed: 0, Critical: 0 },
    PlayerSelectingBooster: [] as unknown[],
    PlayerDailyQuestData: [
      { type: 0, progress: 0, isClaimed: false },
      { type: 1, progress: 0, isClaimed: false },
      { type: 9, progress: 0, isClaimed: false },
      { type: 11, progress: 0, isClaimed: false },
      { type: 10, progress: 0, isClaimed: false },
    ],
    PlayerAchievementData: {},
    PlayerTutorialData: { Character: false, Booster: false, ActionInGame: false },
  };
}

function serializeSave(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(5);
  MAGIC.copy(header);
  header[4] = VERSION;
  return Buffer.concat([header, json]);
}

async function fetchNonce(address: string): Promise<{ nonce: string; message: string }> {
  const res = await fetch(`${WARZONE_URL}/auth/nonce?wallet=${address}`);
  if (!res.ok) {
    throw new Error(`warzone nonce failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<{ nonce: string; message: string }>;
}

async function warzoneLogin(wallet: ethers.HDNodeWallet): Promise<string> {
  const { nonce, message } = await fetchNonce(wallet.address);
  const signature = await wallet.signMessage(message);

  const res = await fetch(`${WARZONE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: wallet.address, signature, nonce }),
  });
  if (!res.ok) {
    throw new Error(`warzone login failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

export async function uploadRandomWarzoneSave(): Promise<{ walletAddress: string; rootHash: string }> {
  const wallet = ethers.Wallet.createRandom();
  const token = await warzoneLogin(wallet);
  const buffer = serializeSave(buildRandomSavePayload());

  const res = await fetch(`${WARZONE_URL}/player/save/binary`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${token}`,
    },
    body: buffer,
  });
  if (!res.ok) {
    throw new Error(`warzone save/binary failed: ${res.status} ${await res.text()}`);
  }
  const result = (await res.json()) as { rootHash: string };
  return { walletAddress: wallet.address, rootHash: result.rootHash };
}
