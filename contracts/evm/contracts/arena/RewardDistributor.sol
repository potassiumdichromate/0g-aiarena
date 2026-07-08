// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./ArenaTreasury.sol";

/**
 * @title  RewardDistributor
 *
 * @notice The only contract allowed to pull ARENA out of the treasury for
 *         player-facing rewards. Every function here is gated to
 *         RELAYER_ROLE — the backend's gas-sponsoring hot wallet — so a
 *         player never signs or pays for these transactions themselves.
 *         This contract never mints; every call is a `treasury.distribute()`
 *         forwarding a transfer of tokens the treasury already holds.
 *
 * @dev    Must be granted `SPENDER_ROLE` on the deployed ArenaTreasury.
 *         Daily login rewards are rate-limited on-chain (one claim per UTC
 *         day per player) so the relayer cannot be tricked/bugged into
 *         paying the same player twice for the same day even if it retries.
 */
contract RewardDistributor is AccessControl, Pausable {
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    ArenaTreasury public immutable treasury;

    /// @notice Fixed reward for successfully minting an Agent NFT.
    uint256 public agentMintReward = 100 * 10 ** 18;

    /// @notice Fixed reward for a daily login claim.
    uint256 public dailyLoginReward = 5 * 10 ** 18;

    /// @dev player => UTC day index (block.timestamp / 1 days) of last daily-login claim.
    mapping(address => uint256) public lastDailyClaimDay;

    // ── Events (minimum event list from the ARENA 0G blueprint) ────────────────
    event AgentRewardGranted(address indexed player, uint256 indexed agentTokenId, uint256 amount);
    event RewardGranted(address indexed player, uint256 amount, string category, string reason);
    event DailyRewardClaimed(address indexed player, uint256 amount, uint256 day);
    event TournamentRewardGranted(address indexed player, uint256 indexed tournamentId, uint256 rank, uint256 amount);
    event ReferralRewardGranted(address indexed referrer, address indexed referee, uint256 amount);

    event AgentMintRewardUpdated(uint256 newAmount);
    event DailyLoginRewardUpdated(uint256 newAmount);

    constructor(address admin, address treasuryAddress) {
        require(admin != address(0), "zero admin");
        require(treasuryAddress != address(0), "zero treasury");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        treasury = ArenaTreasury(treasuryAddress);
    }

    // ── Agent Mint Flow ──────────────────────────────────────────────────────

    /**
     * @notice Called by the relayer immediately after an Agent NFT mint
     *         succeeds on-chain (see AIArenaINFT.mintAgent). Pays the fixed
     *         Agent Mint reward directly to the player's wallet.
     */
    function grantAgentMintReward(address player, uint256 agentTokenId) external onlyRole(RELAYER_ROLE) whenNotPaused {
        treasury.distribute(player, agentMintReward, "AGENT_MINT");
        emit AgentRewardGranted(player, agentTokenId, agentMintReward);
    }

    // ── Daily Login ──────────────────────────────────────────────────────────

    function grantDailyLoginReward(address player) external onlyRole(RELAYER_ROLE) whenNotPaused {
        uint256 today = block.timestamp / 1 days;
        require(lastDailyClaimDay[player] < today, "already claimed today");
        lastDailyClaimDay[player] = today;
        treasury.distribute(player, dailyLoginReward, "DAILY_LOGIN");
        emit DailyRewardClaimed(player, dailyLoginReward, today);
    }

    // ── Referral ─────────────────────────────────────────────────────────────

    function grantReferralReward(address referrer, address referee, uint256 amount) external onlyRole(RELAYER_ROLE) whenNotPaused {
        require(referrer != address(0) && referee != address(0), "zero address");
        treasury.distribute(referrer, amount, "REFERRAL");
        emit ReferralRewardGranted(referrer, referee, amount);
    }

    // ── Training / Quest / Seasonal (generic categories) ────────────────────

    function grantTrainingReward(address player, uint256 amount, string calldata reason) external onlyRole(RELAYER_ROLE) whenNotPaused {
        treasury.distribute(player, amount, "TRAINING");
        emit RewardGranted(player, amount, "TRAINING", reason);
    }

    function grantQuestReward(address player, uint256 amount, string calldata reason) external onlyRole(RELAYER_ROLE) whenNotPaused {
        treasury.distribute(player, amount, "QUEST");
        emit RewardGranted(player, amount, "QUEST", reason);
    }

    function grantSeasonalReward(address player, uint256 amount, string calldata reason) external onlyRole(RELAYER_ROLE) whenNotPaused {
        treasury.distribute(player, amount, "SEASONAL");
        emit RewardGranted(player, amount, "SEASONAL", reason);
    }

    /**
     * @notice Treasury-funded tournament bonus (e.g. a platform-seeded prize
     *         top-up), distinct from the entry-fee prize pool that
     *         ArenaTournament redistributes among entrants directly.
     */
    function grantTournamentReward(address player, uint256 tournamentId, uint256 rank, uint256 amount) external onlyRole(RELAYER_ROLE) whenNotPaused {
        treasury.distribute(player, amount, "TOURNAMENT");
        emit TournamentRewardGranted(player, tournamentId, rank, amount);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setAgentMintReward(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        agentMintReward = amount;
        emit AgentMintRewardUpdated(amount);
    }

    function setDailyLoginReward(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        dailyLoginReward = amount;
        emit DailyLoginRewardUpdated(amount);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
}
