// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title  ArenaToken
 *
 * @notice The $ARENA in-game currency for the 0G Chain beta economy.
 *         Fixed supply, minted once at deployment directly to the
 *         ArenaTreasury address. There is no mint function of any kind —
 *         not owner-gated, not role-gated — so the supply cap is enforced
 *         by the absence of the capability, not by a permission check.
 *
 * @dev    Standard OpenZeppelin ERC20 (transfer/transferFrom/balanceOf/
 *         totalSupply/approve/allowance) plus EIP-2612 `permit()`. Permit
 *         lets a player authorize a spender (ArenaEscrow/ArenaTournament) via
 *         an off-chain signature instead of an on-chain approve() tx — the
 *         backend relayer submits the permit() call and pays its gas, so
 *         staking never requires the player to hold 0G for gas at all.
 */
contract ArenaToken is ERC20, ERC20Permit {
    /// @notice Fixed beta-economy supply: 1,000,000 ARENA (18 decimals).
    uint256 public constant INITIAL_SUPPLY = 1_000_000 * 10 ** 18;

    /**
     * @param treasury Recipient of the entire initial supply. Must be the
     *                 deployed ArenaTreasury contract address.
     */
    constructor(address treasury) ERC20("Arena Token", "ARENA") ERC20Permit("Arena Token") {
        require(treasury != address(0), "zero treasury");
        _mint(treasury, INITIAL_SUPPLY);
    }
}
