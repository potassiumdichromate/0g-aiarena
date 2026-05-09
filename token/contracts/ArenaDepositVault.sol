// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title  ArenaDepositVault
 * @notice Deployed on Base (and 0G chain) to accept USDC/USDT deposits.
 *         Emits a DepositQueued event that the backend bridge relayer listens to,
 *         then mints $ARENA on Solana via the arena-reserve program.
 *
 * @dev    Phase 1 (MVP): Backend relayer observes events and calls Solana.
 *         Phase 2: Wormhole Core Bridge integration for trustless relay.
 *
 * Security:
 *   - Owner is a 3-of-5 Gnosis Safe multisig
 *   - Pausable for emergency halt
 *   - ReentrancyGuard on all state-changing functions
 *   - Min/max deposit limits to prevent dust and whale attacks
 *   - Daily deposit cap per address
 */
contract ArenaDepositVault is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── State ─────────────────────────────────────────────────────────────────

    IERC20 public immutable usdc;
    IERC20 public immutable usdt;

    /// The platform's fee collector address on this chain
    address public feeCollector;

    /// Minimum deposit: $10 USDC (6 decimals)
    uint256 public minDeposit  = 10e6;
    /// Maximum deposit: $100,000 USDC per transaction
    uint256 public maxDeposit  = 100_000e6;
    /// Daily cap per user: $10,000 USDC
    uint256 public dailyCapPerUser = 10_000e6;

    /// Deposit fee in basis points (0 at launch — free to buy)
    uint256 public depositFeeBps = 0;

    /// nonce for deposit IDs (monotonically increasing)
    uint256 public depositNonce;

    /// Tracks daily deposit totals per user
    mapping(address => uint256) public userDailyDeposited;
    mapping(address => uint256) public userLastDepositDay;

    // ── Events ────────────────────────────────────────────────────────────────

    /**
     * @notice Emitted when a user deposits USDC/USDT.
     *         The bridge relayer watches for this event and mints $ARENA on Solana.
     * @param depositId     Unique monotonic ID for this deposit
     * @param depositor     msg.sender (EVM address)
     * @param solanaRecipient  The Solana address (base58 as bytes32) to mint $ARENA to
     * @param asset         0 = USDC, 1 = USDT
     * @param amount        Net amount after fee (USDC/USDT, 6 decimals)
     * @param fee           Fee charged (0 at launch)
     * @param chain         Source chain ID (for 0G vs Base disambiguation)
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

    event RedemptionProcessed(
        address indexed recipient,
        uint256 usdcAmount,
        bytes32 solanaProof
    );

    event MinMaxUpdated(uint256 minDeposit, uint256 maxDeposit);
    event DailyCapUpdated(uint256 newCap);
    event FeeUpdated(uint256 newFeeBps);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address _usdc,
        address _usdt,
        address _feeCollector,
        address _owner
    ) Ownable(_owner) {
        require(_usdc        != address(0), "zero usdc");
        require(_usdt        != address(0), "zero usdt");
        require(_feeCollector != address(0), "zero feeCollector");

        usdc         = IERC20(_usdc);
        usdt         = IERC20(_usdt);
        feeCollector = _feeCollector;
    }

    // ── Core: Deposit ─────────────────────────────────────────────────────────

    /**
     * @notice Deposit USDC and queue a Solana $ARENA mint.
     * @param amount         USDC amount (6 decimals, including fee if any)
     * @param solanaRecipient The Solana wallet address to receive $ARENA (as bytes32)
     */
    function depositUSDC(
        uint256 amount,
        bytes32 solanaRecipient
    ) external whenNotPaused nonReentrant {
        _deposit(usdc, 0, amount, solanaRecipient);
    }

    /**
     * @notice Deposit USDT and queue a Solana $ARENA mint.
     */
    function depositUSDT(
        uint256 amount,
        bytes32 solanaRecipient
    ) external whenNotPaused nonReentrant {
        _deposit(usdt, 1, amount, solanaRecipient);
    }

    function _deposit(
        IERC20  token,
        uint8   assetType,
        uint256 amount,
        bytes32 solanaRecipient
    ) internal {
        require(solanaRecipient != bytes32(0), "invalid solana recipient");
        require(amount >= minDeposit,          "below minimum deposit");
        require(amount <= maxDeposit,          "above maximum deposit");

        // Daily cap enforcement
        uint256 today = block.timestamp / 86400;
        if (userLastDepositDay[msg.sender] < today) {
            userDailyDeposited[msg.sender] = 0;
            userLastDepositDay[msg.sender] = today;
        }
        require(
            userDailyDeposited[msg.sender] + amount <= dailyCapPerUser,
            "daily cap exceeded"
        );
        userDailyDeposited[msg.sender] += amount;

        // Calculate fee
        uint256 fee    = (amount * depositFeeBps) / 10_000;
        uint256 netAmt = amount - fee;

        // Pull tokens from user
        token.safeTransferFrom(msg.sender, address(this), amount);

        // Send fee to collector (if any)
        if (fee > 0) {
            token.safeTransfer(feeCollector, fee);
        }

        uint256 id = ++depositNonce;

        emit DepositQueued(
            id,
            msg.sender,
            solanaRecipient,
            assetType,
            netAmt,
            fee,
            block.chainid
        );
    }

    // ── Redemption (Phase 2 — cross-chain redeem) ─────────────────────────────

    /**
     * @notice Release USDC to a user who burned $ARENA on Solana.
     * @dev Called by the authorized relayer with a proof from the Solana program.
     *      Phase 1: Owner calls this after verifying the Solana redemption tx.
     *      Phase 2: Replace with Wormhole VAA verification.
     * @param recipient   EVM address to receive USDC
     * @param usdcAmount  Amount to release (6 decimals)
     * @param solanaProof Hash of the Solana redemption transaction
     */
    function processRedemption(
        address recipient,
        uint256 usdcAmount,
        bytes32 solanaProof
    ) external onlyOwner nonReentrant whenNotPaused {
        require(recipient   != address(0), "zero recipient");
        require(usdcAmount  > 0,           "zero amount");
        require(
            usdc.balanceOf(address(this)) >= usdcAmount,
            "insufficient vault balance"
        );

        usdc.safeTransfer(recipient, usdcAmount);

        emit RedemptionProcessed(recipient, usdcAmount, solanaProof);
    }

    // ── View ──────────────────────────────────────────────────────────────────

    function vaultBalance() external view returns (uint256 usdcBal, uint256 usdtBal) {
        usdcBal = usdc.balanceOf(address(this));
        usdtBal = usdt.balanceOf(address(this));
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setDepositLimits(uint256 _min, uint256 _max) external onlyOwner {
        require(_min < _max, "min >= max");
        minDeposit = _min;
        maxDeposit = _max;
        emit MinMaxUpdated(_min, _max);
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
        require(_collector != address(0), "zero address");
        feeCollector = _collector;
    }

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /**
     * @notice Emergency: withdraw all tokens to a safe address.
     *         Only callable by the multisig owner.
     */
    function emergencyWithdraw(address to) external onlyOwner {
        require(to != address(0), "zero address");
        uint256 usdcBal = usdc.balanceOf(address(this));
        uint256 usdtBal = usdt.balanceOf(address(this));
        if (usdcBal > 0) usdc.safeTransfer(to, usdcBal);
        if (usdtBal > 0) usdt.safeTransfer(to, usdtBal);
    }
}
