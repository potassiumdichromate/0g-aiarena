// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ArenaTreasury.sol";

/**
 * @title  ArenaTournament
 *
 * @notice Multi-participant entry-fee pool with placement-based prize
 *         distribution, mirroring ArenaEscrow's stake-pool-settle pattern
 *         for 1v1 wagers but for N participants. The prize pool is funded
 *         entirely by entrants' own entry fees (pulled via `transferFrom`,
 *         same sponsored-relayer pattern as ArenaEscrow) — the treasury
 *         only ever *receives* the commission cut here, it never funds the
 *         base prize pool. A separate, treasury-funded "tournament bonus"
 *         (e.g. a platform-seeded top-up) is handled by
 *         RewardDistributor.grantTournamentReward, not by this contract.
 */
contract ArenaTournament is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    enum TournamentState { NONE, OPEN, STARTED, SETTLED, CANCELLED }

    struct TournamentInfo {
        uint256 entryFee;
        uint256 maxParticipants;
        TournamentState state;
        address[] participants;
        /// @dev Commission rate locked in at createTournament() time, so an
        /// admin changing `commissionBps` mid-tournament can never alter the
        /// terms entrants already paid into.
        uint256 commissionBpsAtCreation;
    }

    IERC20 public immutable arenaToken;
    ArenaTreasury public immutable treasury;

    /// @notice Commission taken from the entry-fee pool at settlement, in basis points.
    uint256 public commissionBps = 1000; // 10%
    uint256 public constant MAX_COMMISSION_BPS = 2000;

    mapping(uint256 => TournamentInfo) public tournaments;
    mapping(uint256 => mapping(address => bool)) public isEntrant;

    event TournamentCreated(uint256 indexed tournamentId, uint256 entryFee, uint256 maxParticipants);
    event TournamentEntered(uint256 indexed tournamentId, address indexed player, uint256 participantCount);
    event TournamentStarted(uint256 indexed tournamentId, uint256 participantCount);
    event TournamentRewardGranted(address indexed player, uint256 indexed tournamentId, uint256 rank, uint256 amount);
    event CommissionCollected(uint256 indexed tournamentId, uint256 amount);
    event TournamentCancelled(uint256 indexed tournamentId);
    event CommissionBpsUpdated(uint256 newBps);

    constructor(address admin, address arenaTokenAddress, address treasuryAddress) {
        require(admin != address(0), "zero admin");
        require(arenaTokenAddress != address(0), "zero token");
        require(treasuryAddress != address(0), "zero treasury");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        arenaToken = IERC20(arenaTokenAddress);
        treasury = ArenaTreasury(treasuryAddress);
    }

    function createTournament(uint256 tournamentId, uint256 entryFee, uint256 maxParticipants) external onlyRole(RELAYER_ROLE) whenNotPaused {
        require(tournaments[tournamentId].state == TournamentState.NONE, "tournament exists");
        require(entryFee > 0, "zero entry fee");
        require(maxParticipants >= 2, "need >= 2 participants");

        TournamentInfo storage t = tournaments[tournamentId];
        t.entryFee = entryFee;
        t.maxParticipants = maxParticipants;
        t.state = TournamentState.OPEN;
        t.commissionBpsAtCreation = commissionBps;

        emit TournamentCreated(tournamentId, entryFee, maxParticipants);
    }

    function enterTournament(uint256 tournamentId, address player) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        TournamentInfo storage t = tournaments[tournamentId];
        require(t.state == TournamentState.OPEN, "not open");
        require(!isEntrant[tournamentId][player], "already entered");
        require(t.participants.length < t.maxParticipants, "tournament full");

        isEntrant[tournamentId][player] = true;
        t.participants.push(player);
        arenaToken.safeTransferFrom(player, address(this), t.entryFee);

        emit TournamentEntered(tournamentId, player, t.participants.length);
    }

    function startTournament(uint256 tournamentId) external onlyRole(RELAYER_ROLE) whenNotPaused {
        TournamentInfo storage t = tournaments[tournamentId];
        require(t.state == TournamentState.OPEN, "not open");
        require(t.participants.length >= 2, "not enough participants");
        t.state = TournamentState.STARTED;
        emit TournamentStarted(tournamentId, t.participants.length);
    }

    /**
     * @notice Settle the tournament: `winners[i]` receives `prizeBps[i]` of
     *         the entry-fee pool (after commission), in placement order
     *         (winners[0] = 1st place, etc). `sum(prizeBps) + commission`
     *         (at the rate locked in when this tournament was created) must
     *         equal exactly 10,000 (100%) — this is intentionally an exact
     *         match, not `<=`, so no token dust can ever be stranded in this
     *         contract with no recovery path. Each winner address may only
     *         appear once.
     */
    function settleTournament(
        uint256 tournamentId,
        address[] calldata winners,
        uint256[] calldata prizeBps
    ) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        TournamentInfo storage t = tournaments[tournamentId];
        require(t.state == TournamentState.STARTED, "not started");
        require(winners.length == prizeBps.length && winners.length > 0, "length mismatch");

        t.state = TournamentState.SETTLED;

        uint256 pool = t.entryFee * t.participants.length;
        uint256 commission = (pool * t.commissionBpsAtCreation) / 10_000;

        uint256 totalPrizeBps = 0;
        for (uint256 i = 0; i < prizeBps.length; i++) {
            totalPrizeBps += prizeBps[i];
            for (uint256 j = 0; j < i; j++) {
                require(winners[i] != winners[j], "duplicate winner");
            }
        }
        require(totalPrizeBps + t.commissionBpsAtCreation == 10_000, "prize allocation must total exactly 100%");

        for (uint256 i = 0; i < winners.length; i++) {
            require(isEntrant[tournamentId][winners[i]], "winner not entrant");
            uint256 amount = (pool * prizeBps[i]) / 10_000;
            if (amount > 0) {
                arenaToken.safeTransfer(winners[i], amount);
                emit TournamentRewardGranted(winners[i], tournamentId, i + 1, amount);
            }
        }

        if (commission > 0) {
            arenaToken.safeTransfer(address(treasury), commission);
            treasury.notifyCommission(commission);
            emit CommissionCollected(tournamentId, commission);
        }
    }

    /// @notice Refunds all entrants for a tournament that never started.
    function cancelTournament(uint256 tournamentId) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        TournamentInfo storage t = tournaments[tournamentId];
        require(t.state == TournamentState.OPEN, "not cancellable");
        t.state = TournamentState.CANCELLED;

        for (uint256 i = 0; i < t.participants.length; i++) {
            arenaToken.safeTransfer(t.participants[i], t.entryFee);
        }

        emit TournamentCancelled(tournamentId);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getParticipants(uint256 tournamentId) external view returns (address[] memory) {
        return tournaments[tournamentId].participants;
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
