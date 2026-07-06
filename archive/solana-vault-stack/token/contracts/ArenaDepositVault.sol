// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title  ArenaDepositVault
 *
 * @notice Accepts deposits and emits DepositQueued events.
 *         The backend bridge relayer watches events and mints $ARENA on Solana.
 *
 * Deployment targets:
 *   Base mainnet  (chainId 8453)  — accepts USDC + USDT (ERC-20)
 *   0G mainnet    (chainId 16661) — accepts native 0G token
 *
 * Asset type encoding in DepositQueued:
 *   0 = USDC   (6 decimals, ERC-20)
 *   1 = USDT   (6 decimals, ERC-20)
 *   2 = NATIVE (18 decimals — 0G token on 0G chain, ETH on Base if added)
 *
 * Security:
 *   - Owner: 3-of-5 Gnosis Safe multisig in production
 *   - Pausable for emergency halt
 *   - ReentrancyGuard on all state-changing functions
 *   - Per-user daily deposit cap
 *   - Min / max per-tx limits
 */
contract ArenaDepositVault is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── State ─────────────────────────────────────────────────────────────────

    /// ERC-20 stablecoins (address(0) = disabled on this deployment)
    IERC20 public immutable usdc;
    IERC20 public immutable usdt;

    address public feeCollector;

    /// Stablecoin limits (6-decimal units)
    uint256 public minDepositStable  = 10e6;        // $10
    uint256 public maxDepositStable  = 100_000e6;   // $100k

    /// Native token limits (18-decimal units)
    uint256 public minDepositNative  = 1e17;        // 0.1 native token
    uint256 public maxDepositNative  = 1_000e18;    // 1000 native tokens

    /// Per-user daily cap in 6-decimal stablecoin units
    /// For native deposits the relayer converts to USD equivalent server-side
    uint256 public dailyCapPerUser   = 10_000e6;    // $10k/day

    uint256 public depositFeeBps     = 0;           // 0% at launch
    uint256 public depositNonce;

    mapping(address => uint256) public userDailyDeposited;
    mapping(address => uint256) public userLastDepositDay;

    // ── Events ────────────────────────────────────────────────────────────────

    /**
     * @notice Emitted for every deposit.
     *
     * @param depositId       Unique monotonic ID
     * @param depositor       msg.sender
     * @param solanaRecipient Recipient Solana wallet (base58 bytes packed into bytes32)
     * @param asset           0=USDC  1=USDT  2=NATIVE
     * @param amount          Net amount (after fee).
     *                        6 decimals for USDC/USDT, 18 decimals for native.
     * @param fee             Fee retained (0 at launch)
     * @param chain           block.chainid — disambiguates 0G vs Base
     */
    event DepositQueued(
        uint256 indexed depositId,
        address indexed depositor,
        bytes32 indexed solanaRecipient,
        uint8   asset,
        uint256 amount,
        uint256 fee,
        uint256 chain
    );

    event RedemptionProcessed(address indexed recipient, uint256 usdcAmount, bytes32 solanaProof);
    event MinMaxStableUpdated(uint256 min, uint256 max);
    event MinMaxNativeUpdated(uint256 min, uint256 max);
    event DailyCapUpdated(uint256 newCap);
    event FeeUpdated(uint256 newFeeBps);
    event NativeReceived(address indexed sender, uint256 amount);

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param _usdc         USDC contract (address(0) to disable — e.g. on 0G chain)
     * @param _usdt         USDT contract (address(0) to disable — e.g. on 0G chain)
     * @param _feeCollector Platform fee wallet
     * @param _owner        Multisig owner
     */
    constructor(
        address _usdc,
        address _usdt,
        address _feeCollector,
        address _owner
    ) Ownable(_owner) {
        require(_feeCollector != address(0), "zero feeCollector");
        usdc         = IERC20(_usdc);
        usdt         = IERC20(_usdt);
        feeCollector = _feeCollector;
    }

    // ── ERC-20 deposits (Base mainnet: USDC + USDT) ───────────────────────────

    /**
     * @notice Deposit USDC on Base mainnet → mint $ARENA on Solana.
     * @param amount          USDC amount (6 decimals)
     * @param solanaRecipient Recipient Solana wallet encoded as bytes32
     */
    function depositUSDC(
        uint256 amount,
        bytes32 solanaRecipient
    ) external whenNotPaused nonReentrant {
        require(address(usdc) != address(0), "USDC not enabled on this chain");
        _depositERC20(usdc, 0, amount, solanaRecipient);
    }

    /**
     * @notice Deposit USDT on Base mainnet → mint $ARENA on Solana.
     */
    function depositUSDT(
        uint256 amount,
        bytes32 solanaRecipient
    ) external whenNotPaused nonReentrant {
        require(address(usdt) != address(0), "USDT not enabled on this chain");
        _depositERC20(usdt, 1, amount, solanaRecipient);
    }

    function _depositERC20(
        IERC20  token,
        uint8   assetType,
        uint256 amount,
        bytes32 solanaRecipient
    ) internal {
        require(solanaRecipient != bytes32(0), "invalid solana recipient");
        require(amount >= minDepositStable, "below minimum");
        require(amount <= maxDepositStable, "above maximum");

        _checkAndUpdateDailyCap(msg.sender, amount);

        uint256 fee    = (amount * depositFeeBps) / 10_000;
        uint256 netAmt = amount - fee;

        token.safeTransferFrom(msg.sender, address(this), amount);
        if (fee > 0) token.safeTransfer(feeCollector, fee);

        emit DepositQueued(++depositNonce, msg.sender, solanaRecipient, assetType, netAmt, fee, block.chainid);
    }

    // ── Native token deposit (0G mainnet: 0G token) ───────────────────────────

    /**
     * @notice Deposit native 0G token → mint $ARENA on Solana.
     *         The backend relayer fetches the 0G/USD price to calculate $ARENA out.
     *
     * @param solanaRecipient Recipient Solana wallet encoded as bytes32
     */
    function depositNative(
        bytes32 solanaRecipient
    ) external payable whenNotPaused nonReentrant {
        require(solanaRecipient != bytes32(0), "invalid solana recipient");
        require(msg.value >= minDepositNative, "below minimum");
        require(msg.value <= maxDepositNative, "above maximum");

        uint256 fee    = (msg.value * depositFeeBps) / 10_000;
        uint256 netAmt = msg.value - fee;

        if (fee > 0) {
            (bool sent,) = feeCollector.call{value: fee}("");
            require(sent, "fee transfer failed");
        }

        emit DepositQueued(++depositNonce, msg.sender, solanaRecipient, 2, netAmt, fee, block.chainid);
        emit NativeReceived(msg.sender, msg.value);
    }

    /// @dev Fallback: reject accidental ETH/0G sends without a recipient
    receive() external payable {
        revert("use depositNative()");
    }

    // ── Redemption ────────────────────────────────────────────────────────────

    /**
     * @notice Release USDC to a user who burned $ARENA on Solana.
     *         Phase 1: owner-only. Phase 2: Wormhole VAA.
     */
    function processRedemption(
        address recipient,
        uint256 usdcAmount,
        bytes32 solanaProof
    ) external onlyOwner nonReentrant whenNotPaused {
        require(recipient  != address(0), "zero recipient");
        require(usdcAmount > 0,           "zero amount");
        require(address(usdc) != address(0), "USDC not enabled");
        require(usdc.balanceOf(address(this)) >= usdcAmount, "insufficient balance");
        usdc.safeTransfer(recipient, usdcAmount);
        emit RedemptionProcessed(recipient, usdcAmount, solanaProof);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _checkAndUpdateDailyCap(address user, uint256 amount) internal {
        uint256 today = block.timestamp / 86400;
        if (userLastDepositDay[user] < today) {
            userDailyDeposited[user] = 0;
            userLastDepositDay[user] = today;
        }
        require(userDailyDeposited[user] + amount <= dailyCapPerUser, "daily cap exceeded");
        userDailyDeposited[user] += amount;
    }

    // ── View ──────────────────────────────────────────────────────────────────

    function vaultBalance() external view returns (uint256 usdcBal, uint256 usdtBal, uint256 nativeBal) {
        usdcBal   = address(usdc) != address(0) ? usdc.balanceOf(address(this)) : 0;
        usdtBal   = address(usdt) != address(0) ? usdt.balanceOf(address(this)) : 0;
        nativeBal = address(this).balance;
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setDepositLimitsStable(uint256 _min, uint256 _max) external onlyOwner {
        require(_min < _max, "min >= max");
        minDepositStable = _min; maxDepositStable = _max;
        emit MinMaxStableUpdated(_min, _max);
    }

    function setDepositLimitsNative(uint256 _min, uint256 _max) external onlyOwner {
        require(_min < _max, "min >= max");
        minDepositNative = _min; maxDepositNative = _max;
        emit MinMaxNativeUpdated(_min, _max);
    }

    function setDailyCap(uint256 _cap) external onlyOwner {
        dailyCapPerUser = _cap;
        emit DailyCapUpdated(_cap);
    }

    function setDepositFee(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 500, "fee > 5%");
        depositFeeBps = _feeBps;
        emit FeeUpdated(_feeBps);
    }

    function setFeeCollector(address _collector) external onlyOwner {
        require(_collector != address(0), "zero");
        feeCollector = _collector;
    }

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /**
     * @notice Emergency: pull all funds to a safe address.
     */
    function emergencyWithdraw(address payable to) external onlyOwner {
        require(to != address(0), "zero");
        if (address(usdc) != address(0)) {
            uint256 b = usdc.balanceOf(address(this));
            if (b > 0) usdc.safeTransfer(to, b);
        }
        if (address(usdt) != address(0)) {
            uint256 b = usdt.balanceOf(address(this));
            if (b > 0) usdt.safeTransfer(to, b);
        }
        uint256 nb = address(this).balance;
        if (nb > 0) {
            (bool sent,) = to.call{value: nb}("");
            require(sent, "native withdraw failed");
        }
    }
}
