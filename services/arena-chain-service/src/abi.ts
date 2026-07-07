/**
 * Compiled ABI arrays for the 5 arena contracts, copied verbatim from
 * contracts/evm/artifacts/contracts/arena/*.sol/*.json's `.abi` field
 * (generated via a one-off script — never hand-typed). A hand-typed ABI in
 * services/inft-service/src/main.ts previously drifted from its real
 * contract and silently broke several calls; these JSON files avoid that
 * failure mode by construction.
 *
 * If the contracts are ever recompiled with a changed interface, regenerate
 * these files from contracts/evm/artifacts/contracts/arena/<Name>.sol/<Name>.json.
 */
import ArenaTokenAbi from './abi/ArenaToken.json';
import ArenaTreasuryAbi from './abi/ArenaTreasury.json';
import RewardDistributorAbi from './abi/RewardDistributor.json';
import ArenaEscrowAbi from './abi/ArenaEscrow.json';
import ArenaTournamentAbi from './abi/ArenaTournament.json';

export {
  ArenaTokenAbi,
  ArenaTreasuryAbi,
  RewardDistributorAbi,
  ArenaEscrowAbi,
  ArenaTournamentAbi,
};
