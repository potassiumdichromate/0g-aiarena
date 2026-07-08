// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title  ArenaTreasury
 *
 * @notice Holds the entire $ARENA fixed supply and is the sole source of
 *         every reward paid out in the beta economy. Never mints — only
 *         moves tokens it already holds.
 *
 * Two kinds of contracts are granted SPENDER_ROLE:
 *   - RewardDistributor: calls `distribute()` to pay out Agent Mint,
 *     Training, Daily Login, Referral, Quest, Tournament and Seasonal
 *     rewards from the treasury balance.
 *   - ArenaEscrow / ArenaTournament: after settling a match/tournament and
 *     transferring the commission cut to this contract directly via
 *     `arenaToken.transfer(treasury, commission)`, they call
 *     `notifyCommission()` so the treasury's on-chain accounting (and the
 *     `CommissionCollected` / `TreasuryUpdated` events analytics dashboards
 *     index) stays in sync with the real token balance.
 *
 * @dev    Deployment order breaks the ArenaToken <-> ArenaTreasury circular
 *         dependency: deploy ArenaTreasury first, then ArenaToken(treasury
 *         address), then call `setArenaToken()` once. See
 *         scripts/deploy-arena-economy.ts.
 *
 *         DEFAULT_ADMIN_ROLE should be held by a multisig in production
 *         (see docs/ARENA_TOKEN_0G.md) — it is the only role that can grant
 *         or revoke SPENDER_ROLE or set the token address, so compromising
 *         a single spender contract cannot be used to add new spenders.
 */
contract ArenaTreasury is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant SPENDER_ROLE = keccak256("SPENDER_ROLE");

    IERC20 public arenaToken;
    bool public arenaTokenSet;

    /// @notice Cumulative amount ever paid out via `distribute()` (reward payouts only).
    uint256 public totalRewardsPaid;

    /// @notice Cumulative commission received from escrow/tournament settlements.
    uint256 public totalCommissions;

    event ArenaTokenSet(address indexed token);
    event TreasuryUpdated(uint256 balance, uint256 totalRewardsPaid, uint256 totalCommissions);
    event RewardDistributed(address indexed spender, address indexed to, uint256 amount, string category);
    event CommissionCollected(address indexed spender, uint256 amount);

    constructor(address admin) {
        require(admin != address(0), "zero admin");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /**
     * @notice One-time wiring of the ArenaToken address, called immediately
     *         after ArenaToken is deployed (which mints the fixed supply to
     *         this contract's address). Cannot be changed afterwards.
     */
    function setArenaToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(!arenaTokenSet, "already set");
        require(token != address(0), "zero token");
        arenaToken = IERC20(token);
        arenaTokenSet = true;
        emit ArenaTokenSet(token);
    }

    /**
     * @notice Pay `amount` ARENA from the treasury to `to`. Only callable by
     *         a granted spender (the RewardDistributor contract).
     */
    function distribute(address to, uint256 amount, string calldata category) external onlyRole(SPENDER_ROLE) {
        require(to != address(0), "zero recipient");
        require(amount > 0, "zero amount");
        totalRewardsPaid += amount;
        arenaToken.safeTransfer(to, amount);
        emit RewardDistributed(msg.sender, to, amount, category);
        emit TreasuryUpdated(balance(), totalRewardsPaid, totalCommissions);
    }

    /**
     * @notice Record a commission that a spender (ArenaEscrow/ArenaTournament)
     *         has already transferred into this contract's own ARENA balance
     *         earlier in the same transaction. This function moves no
     *         tokens — it only updates accounting and emits analytics events.
     */
    function notifyCommission(uint256 amount) external onlyRole(SPENDER_ROLE) {
        require(amount > 0, "zero amount");
        totalCommissions += amount;
        emit CommissionCollected(msg.sender, amount);
        emit TreasuryUpdated(balance(), totalRewardsPaid, totalCommissions);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @notice Current ARENA balance held by the treasury.
    function balance() public view returns (uint256) {
        return address(arenaToken) == address(0) ? 0 : arenaToken.balanceOf(address(this));
    }

    /// @notice Alias for `balance()` — the "remaining supply" available to distribute.
    function remaining() external view returns (uint256) {
        return balance();
    }

    function distributed() external view returns (uint256) {
        return totalRewardsPaid;
    }
}
