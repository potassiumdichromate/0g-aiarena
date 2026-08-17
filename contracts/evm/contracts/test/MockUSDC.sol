// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title MockUSDC
 *
 * @notice Test-only USDC stand-in implementing the EIP-3009 surface the escrow
 *         depends on. Mirrors Circle's FiatTokenV2 behaviour for
 *         receiveWithAuthorization: 6 decimals, single-use nonces, validity
 *         window, and the msg.sender == to restriction that makes the
 *         authorization non-frontrunnable.
 *
 * @dev Deliberately NOT a simplified stub. If this were laxer than real USDC —
 *      say, allowing nonce reuse — the escrow's replay tests would pass here
 *      and fail on Base mainnet, which is the one place it matters.
 */
contract MockUSDC is ERC20, EIP712 {
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,"
        "uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @dev from => nonce => used. Single-use, exactly as FiatTokenV2.
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor() ERC20("USD Coin", "USDC") EIP712("USD Coin", "2") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // The property that makes this frontrun-proof: only the payee can
        // submit the authorization.
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!authorizationState[from][nonce], "FiatTokenV2: authorization is used or canceled");

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
            )
        );
        require(ECDSA.recover(digest, v, r, s) == from, "FiatTokenV2: invalid signature");

        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);

        _transfer(from, to, value);
    }

    /// @notice Exposed so tests can build the same digest the token expects.
    function domainSeparatorV4() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
