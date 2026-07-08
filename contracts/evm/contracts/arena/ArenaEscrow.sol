// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ArenaTreasury.sol";

/**
 * @title  ArenaEscrow
 *
 * @notice Replaces the old off-chain wager ledger (Postgres AgentWallet /
 *         EscrowRecord) with a real on-chain escrow for 1v1 AI Arena
 *         battles. Player stakes are pulled via `transferFrom` — each
 *         player approves this contract once from their own wallet, then
 *         every subsequent stake/settle call is submitted and gas-paid by
 *         the backend relayer, so players never need native 0G tokens.
 *
 * Flow (matches the ARENA 0G blueprint):
 *   createMatch(playerA stakes)  -> MatchCreated
 *   joinMatch(playerB stakes)    -> MatchJoined   (pool = 2x stake)
 *   startMatch()                 -> MatchStarted   (backend now runs the AI battle off-chain)
 *   settleMatch(winner)          -> MatchSettled + CommissionCollected
 *
 * Example: stake 5 + stake 5 = pool 10; winner gets 9 (90%); treasury gets 1 (10%).
 *
 * @dev    The backend never manually transfers player rewards — every
 *         payout here is a contract-executed ERC20 transfer, and the
 *         backend's only privilege is *triggering* these state transitions
 *         (RELAYER_ROLE), not moving funds directly.
 */
contract ArenaEscrow is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    enum MatchState { NONE, CREATED, JOINED, STARTED, SETTLED, CANCELLED }

    struct Match {
        address playerA;
        address playerB;
        uint256 stakeAmount;
        MatchState state;
        /// @dev Commission rate locked in at createMatch() time, so an admin
        /// changing `commissionBps` mid-match can never alter the terms two
        /// players already staked under.
        uint256 commissionBpsAtCreation;
    }

    IERC20 public immutable arenaToken;
    ArenaTreasury public immutable treasury;

    /// @notice Commission taken from the pool at settlement, in basis points. 1000 = 10%.
    uint256 public commissionBps = 1000;
    uint256 public constant MAX_COMMISSION_BPS = 2000; // hard cap: 20%

    mapping(bytes32 => Match) public matches;

    event MatchCreated(bytes32 indexed matchId, address indexed playerA, uint256 stakeAmount);
    event MatchJoined(bytes32 indexed matchId, address indexed playerB, uint256 pool);
    event MatchStarted(bytes32 indexed matchId);
    event MatchSettled(bytes32 indexed matchId, address indexed winner, uint256 payout, uint256 commission);
    event MatchCancelled(bytes32 indexed matchId);
    event CommissionCollected(bytes32 indexed matchId, uint256 amount);
    event CommissionBpsUpdated(uint256 newBps);

    constructor(address admin, address arenaTokenAddress, address treasuryAddress) {
        require(admin != address(0), "zero admin");
        require(arenaTokenAddress != address(0), "zero token");
        require(treasuryAddress != address(0), "zero treasury");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        arenaToken = IERC20(arenaTokenAddress);
        treasury = ArenaTreasury(treasuryAddress);
    }

    /// @notice Player A stakes and opens a match. `matchId` is caller-chosen (e.g. keccak256 of an off-chain battle UUID) and must be unused.
    function createMatch(bytes32 matchId, address playerA, uint256 stakeAmount) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        require(matches[matchId].state == MatchState.NONE, "match exists");
        require(playerA != address(0), "zero player");
        require(stakeAmount > 0, "zero stake");

        matches[matchId] = Match({
            playerA: playerA,
            playerB: address(0),
            stakeAmount: stakeAmount,
            state: MatchState.CREATED,
            commissionBpsAtCreation: commissionBps
        });
        arenaToken.safeTransferFrom(playerA, address(this), stakeAmount);

        emit MatchCreated(matchId, playerA, stakeAmount);
    }

    /// @notice Player B joins with an equal stake, forming the pool.
    function joinMatch(bytes32 matchId, address playerB) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        Match storage m = matches[matchId];
        require(m.state == MatchState.CREATED, "not joinable");
        require(playerB != address(0) && playerB != m.playerA, "invalid player");

        m.playerB = playerB;
        m.state = MatchState.JOINED;
        arenaToken.safeTransferFrom(playerB, address(this), m.stakeAmount);

        emit MatchJoined(matchId, playerB, m.stakeAmount * 2);
    }

    /// @notice Marks the match as started — the backend now runs the AI battle off-chain.
    function startMatch(bytes32 matchId) external onlyRole(RELAYER_ROLE) whenNotPaused {
        Match storage m = matches[matchId];
        require(m.state == MatchState.JOINED, "not ready");
        m.state = MatchState.STARTED;
        emit MatchStarted(matchId);
    }

    /**
     * @notice Backend submits the verified battle result. Pays the winner
     *         (pool minus commission) and routes the commission to the
     *         treasury, all in the same transaction.
     */
    function settleMatch(bytes32 matchId, address winner) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        Match storage m = matches[matchId];
        require(m.state == MatchState.STARTED, "not started");
        require(winner == m.playerA || winner == m.playerB, "winner not in match");

        m.state = MatchState.SETTLED;

        uint256 pool = m.stakeAmount * 2;
        uint256 commission = (pool * m.commissionBpsAtCreation) / 10_000;
        uint256 payout = pool - commission;

        arenaToken.safeTransfer(winner, payout);
        if (commission > 0) {
            arenaToken.safeTransfer(address(treasury), commission);
            treasury.notifyCommission(commission);
            emit CommissionCollected(matchId, commission);
        }

        emit MatchSettled(matchId, winner, payout, commission);
    }

    /// @notice Refunds stakes for a match that never completed (e.g. opponent no-show, dispute).
    function cancelMatch(bytes32 matchId) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        Match storage m = matches[matchId];
        require(m.state == MatchState.CREATED || m.state == MatchState.JOINED || m.state == MatchState.STARTED, "not cancellable");

        MatchState priorState = m.state;
        m.state = MatchState.CANCELLED;

        arenaToken.safeTransfer(m.playerA, m.stakeAmount);
        if (priorState != MatchState.CREATED) {
            arenaToken.safeTransfer(m.playerB, m.stakeAmount);
        }

        emit MatchCancelled(matchId);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getMatch(bytes32 matchId) external view returns (Match memory) {
        return matches[matchId];
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setCommissionBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(bps <= MAX_COMMISSION_BPS, "commission too high");
        commissionBps = bps;
        emit CommissionBpsUpdated(bps);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
}
