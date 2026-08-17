// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @title  CreatorStudioSubscription
 *
 * @notice Tiered subscription billing for the 0G AI Arena Creator Studio,
 *         denominated in native 0G on 0G Chain mainnet (chainId 16661).
 *
 *           Tier 0 — Free Creator ....  0 0G  (never expires)
 *           Tier 1 — Creator Plus .... 10 0G / 30 days
 *           Tier 2 — Creator Pro ..... 25 0G / 30 days
 *
 *         Every 0G collected is forwarded to the treasury in the same
 *         transaction that collects it. This contract is not a vault: the
 *         only native balance it ever holds is unspent user credit (see
 *         "Gasless model" below), tracked to the wei in `totalCredit`.
 *
 * ─── Gasless model ──────────────────────────────────────────────────────────
 *
 *         0G is the native gas token of 0G Chain, not an ERC-20. There is no
 *         `permit`/`transferFrom` equivalent for native value: a native
 *         transfer can only originate from the account that owns the funds,
 *         and originating a transaction means paying its gas. No contract can
 *         change that — so "the relayer pays gas AND the fee leaves the user's
 *         wallet in the same step" is not expressible on this chain.
 *
 *         What IS expressible, and what this contract implements, is moving
 *         the user's gas cost to exactly one transaction and making every
 *         subsequent one signature-only:
 *
 *           A. DIRECT      `subscribe()` — user sends 0G + pays gas. One
 *                          wallet popup, immediate. Gas on 0G is negligible.
 *
 *           B. GASLESS     `depositCredit()` once (user pays gas on that top-up
 *                          alone, and may fund many months at a time), then
 *                          every subscribe/upgrade/renew is an EIP-712
 *                          signature relayed by RELAYER_ROLE via
 *                          `subscribeWithSignature()`. The user signs a
 *                          message — no transaction, no gas, ever again.
 *
 *           C. SPONSORED   The deployer calls `depositCreditFor(user)` (promo,
 *                          free trial, fiat/off-chain purchase, credit card
 *                          top-up). The user then never sends a transaction at
 *                          all: path B applies and the deployer paid both the
 *                          fee and the gas.
 *
 *         `subscribeFor()` additionally lets any address pay a subscription
 *         outright on another account's behalf (gifting, admin grants).
 *
 * ─── Tier changes ───────────────────────────────────────────────────────────
 *
 *         Upgrading or downgrading never destroys value and never requires a
 *         refund from the treasury. Time already paid for on the old tier is
 *         converted to its 0G value at the old tier's rate, then converted
 *         back into seconds at the new tier's rate and added to the new
 *         expiry. 15 days of Plus (5 0G of value) becomes 6 days of Pro.
 *         Renewing the same tier simply stacks onto the existing expiry.
 *
 * ─── Security ───────────────────────────────────────────────────────────────
 *
 *         - AccessControl separates admin / price / relayer / pauser duties.
 *           DEFAULT_ADMIN_ROLE should be a multisig in production.
 *         - Relayed requests are EIP-712 typed data bound to this contract,
 *           this chainId, a per-account nonce and a deadline; `maxCost` pins
 *           the price the user agreed to, so an admin price change between
 *           signing and relaying cannot overcharge a pending signature.
 *         - SignatureChecker accepts both EOA (ECDSA) and ERC-1271 smart
 *           account signatures.
 *         - Credit is a strict liability: `sweep()` can only ever remove
 *           balance in excess of `totalCredit`, so user funds can never be
 *           withdrawn by an admin.
 *         - State is written before any value is sent, and every value-moving
 *           entrypoint is `nonReentrant`.
 */
contract CreatorStudioSubscription is AccessControl, Pausable, ReentrancyGuard, EIP712, Nonces {
    // ─── Roles ──────────────────────────────────────────────────────────────

    /// @notice May submit `subscribeWithSignature()` / `renewFromCredit()` on users' behalf and pay their gas.
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    /// @notice May change tier pricing.
    bytes32 public constant PRICE_ADMIN_ROLE = keccak256("PRICE_ADMIN_ROLE");

    /// @notice May pause new subscriptions (withdrawals stay open while paused).
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ─── Tiers ──────────────────────────────────────────────────────────────

    enum Tier {
        Free, // 0 — Free Creator
        Plus, // 1 — Creator Plus
        Pro   // 2 — Creator Pro
    }

    uint8 private constant TIER_COUNT = 3;

    // ─── Constants ──────────────────────────────────────────────────────────

    /// @notice One billing period. "Per month" is 30 days, fixed, so on-chain math never depends on a calendar.
    uint64 public constant PERIOD = 30 days;

    /// @notice Free Creator has no expiry; this sentinel is ~year 292277026596.
    uint64 public constant NO_EXPIRY = type(uint64).max;

    /// @notice Upper bound on periods bought in a single call (2 years), so `periods * price` cannot be fat-fingered.
    uint8 public constant MAX_PERIODS = 24;

    /// @notice A relayed auto-renewal may only run once the subscription is inside this window of expiring.
    uint64 public constant RENEW_WINDOW = 3 days;

    /// @notice Sanity ceiling on any tier price, guarding against a mis-typed `setTierPrice`.
    uint256 public constant MAX_TIER_PRICE = 10_000 ether;

    /// @dev EIP-712 type hash for a relayed subscription request.
    bytes32 public constant SUBSCRIBE_REQUEST_TYPEHASH = keccak256(
        "SubscribeRequest(address account,uint8 tier,uint8 periods,bool autoRenew,uint256 maxCost,uint256 nonce,uint256 deadline)"
    );

    // ─── Types ──────────────────────────────────────────────────────────────

    /**
     * @param account   The subscriber. Funds come from this account's credit balance.
     * @param tier      Target tier (0 Free / 1 Plus / 2 Pro).
     * @param periods   Number of 30-day periods to buy. Must be 0 for Free, 1..MAX_PERIODS otherwise.
     * @param autoRenew Whether the relayer may auto-renew this tier from credit near expiry.
     * @param maxCost   Maximum total wei the signer authorizes. Reverts if the live price exceeds it.
     * @param nonce     Must equal `nonces(account)`; consumed on success.
     * @param deadline  Unix timestamp after which the signature is void.
     */
    struct SubscribeRequest {
        address account;
        uint8 tier;
        uint8 periods;
        bool autoRenew;
        uint256 maxCost;
        uint256 nonce;
        uint256 deadline;
    }

    /**
     * @param tier      Current tier.
     * @param startedAt First time this account ever subscribed.
     * @param expiresAt Expiry timestamp; NO_EXPIRY for Free.
     * @param renewals  Count of successful paid subscribe/renew operations.
     * @param autoRenew Relayer auto-renewal consent.
     */
    struct Subscription {
        Tier tier;
        uint64 startedAt;
        uint64 expiresAt;
        uint64 renewals;
        bool autoRenew;
    }

    // ─── Storage ────────────────────────────────────────────────────────────

    /// @notice Destination for every 0G collected. Set at deploy, changeable by admin.
    address payable public treasury;

    /// @notice Price in wei for one PERIOD of each tier, indexed by `Tier`.
    uint256[TIER_COUNT] private _tierPrice;

    mapping(address account => Subscription) private _subscriptions;

    /// @notice Prepaid balance an account can spend on gasless (relayed) subscriptions. Withdrawable at any time.
    mapping(address account => uint256) public credit;

    /// @notice Sum of all `credit` balances — the portion of this contract's native balance that is user-owned.
    uint256 public totalCredit;

    /// @notice Lifetime 0G forwarded to the treasury by this contract.
    uint256 public totalCollected;

    /// @notice Lifetime count of paid subscribe/renew operations.
    uint256 public totalSubscriptions;

    // ─── Events ─────────────────────────────────────────────────────────────

    /// @dev `gasless` is true when the call came from a relayer against the account's credit.
    event Subscribed(
        address indexed account,
        Tier indexed tier,
        address indexed payer,
        uint8 periods,
        uint256 cost,
        uint64 expiresAt,
        bool gasless
    );
    event AutoRenewed(address indexed account, Tier indexed tier, uint256 cost, uint64 expiresAt);
    event AutoRenewSet(address indexed account, bool enabled);
    event CreditDeposited(address indexed account, address indexed from, uint256 amount, uint256 balance);
    event CreditWithdrawn(address indexed account, address indexed to, uint256 amount, uint256 balance);
    event CreditSpent(address indexed account, uint256 amount, uint256 balance);
    event PaymentForwarded(address indexed to, uint256 amount);
    event TierPriceUpdated(Tier indexed tier, uint256 oldPrice, uint256 newPrice);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event Swept(address indexed to, uint256 amount);

    // ─── Errors ─────────────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidTier(uint8 tier);
    error InvalidPeriods(uint8 periods);
    error FreeTierTakesNoPeriods();
    error PaidTierRequiresPeriods();
    error InsufficientPayment(uint256 required, uint256 supplied);
    error InsufficientCredit(uint256 required, uint256 available);
    error PriceExceedsAuthorized(uint256 cost, uint256 maxCost);
    error SignatureExpired(uint256 deadline);
    error InvalidSignature();
    error PriceTooHigh(uint256 price);
    error FreeTierMustBeFree();
    error NothingToSweep();
    error ZeroAmount();
    error AutoRenewNotEnabled();
    error NotDueForRenewal(uint64 expiresAt);
    error SubscriptionNotActive();

    // ─── Construction ───────────────────────────────────────────────────────

    /**
     * @param admin     Holder of DEFAULT_ADMIN_ROLE, PRICE_ADMIN_ROLE and PAUSER_ROLE. Use a multisig in production.
     * @param relayer   Wallet that submits gasless requests and pays their gas (the deployer wallet).
     * @param treasury_ Destination for all collected 0G.
     * @param plusPrice Price per 30 days for Creator Plus, in wei (10 ether == 10 0G).
     * @param proPrice  Price per 30 days for Creator Pro, in wei (25 ether == 25 0G).
     */
    constructor(
        address admin,
        address relayer,
        address payable treasury_,
        uint256 plusPrice,
        uint256 proPrice
    ) EIP712("AIArena Creator Studio", "1") {
        if (admin == address(0) || relayer == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (plusPrice == 0 || plusPrice > MAX_TIER_PRICE) revert PriceTooHigh(plusPrice);
        if (proPrice == 0 || proPrice > MAX_TIER_PRICE) revert PriceTooHigh(proPrice);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PRICE_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(RELAYER_ROLE, relayer);

        treasury = treasury_;
        emit TreasuryUpdated(address(0), treasury_);

        _tierPrice[uint8(Tier.Free)] = 0;
        _tierPrice[uint8(Tier.Plus)] = plusPrice;
        _tierPrice[uint8(Tier.Pro)] = proPrice;
        emit TierPriceUpdated(Tier.Plus, 0, plusPrice);
        emit TierPriceUpdated(Tier.Pro, 0, proPrice);
    }

    // ─── Path A: direct payment (user signs a transaction, pays its gas) ─────

    /**
     * @notice Subscribe or renew, paying with the 0G attached to this call.
     * @dev    Any 0G sent above `cost` is added to the caller's credit rather
     *         than refunded — it is withdrawable via `withdrawCredit()` and is
     *         what funds later gasless renewals. Selecting Tier.Free with
     *         `periods = 0` and no value activates the free plan.
     * @param  tier    Target tier.
     * @param  periods 30-day periods to buy (0 for Free, 1..24 otherwise).
     */
    function subscribe(Tier tier, uint8 periods) external payable whenNotPaused nonReentrant {
        _subscribeWithValue(msg.sender, tier, periods, msg.value);
    }

    /**
     * @notice Pay for someone else's subscription (gifting, admin grant, sponsored onboarding).
     * @dev    Excess value is credited to `account`, not to the payer.
     * @param  account Beneficiary whose subscription is created or extended.
     * @param  tier    Target tier.
     * @param  periods 30-day periods to buy.
     */
    function subscribeFor(address account, Tier tier, uint8 periods)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        if (account == address(0)) revert ZeroAddress();
        _subscribeWithValue(account, tier, periods, msg.value);
    }

    /// @dev Shared body of the two direct-payment entrypoints.
    function _subscribeWithValue(address account, Tier tier, uint8 periods, uint256 value) private {
        uint256 cost = _quote(tier, periods);
        if (value < cost) revert InsufficientPayment(cost, value);

        unchecked {
            uint256 excess = value - cost;
            if (excess > 0) _addCredit(account, msg.sender, excess);
        }

        uint64 expiresAt = _applySubscription(account, tier, periods);
        emit Subscribed(account, tier, msg.sender, periods, cost, expiresAt, false);

        _forwardToTreasury(cost);
    }

    // ─── Path B/C: prepaid credit ───────────────────────────────────────────

    /**
     * @notice Top up your own credit balance. This is the single gas-paying
     *         transaction in the gasless flow — fund several months at once
     *         and every later renewal is signature-only.
     */
    function depositCredit() external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        _addCredit(msg.sender, msg.sender, msg.value);
    }

    /**
     * @notice Fund another account's credit. Lets the deployer sponsor a user
     *         entirely — promos, free trials, or credit bought with fiat
     *         off-chain — so that user never sends a transaction at all.
     * @param  account Account to credit.
     */
    function depositCreditFor(address account) external payable nonReentrant {
        if (account == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        _addCredit(account, msg.sender, msg.value);
    }

    /// @dev A plain 0G transfer to this contract is treated as a self top-up.
    receive() external payable {
        if (msg.value == 0) revert ZeroAmount();
        _addCredit(msg.sender, msg.sender, msg.value);
    }

    /**
     * @notice Withdraw unspent credit. Deliberately available while paused —
     *         a pause must never trap user funds.
     * @param  amount Wei to withdraw. Pass `type(uint256).max` to withdraw everything.
     */
    function withdrawCredit(uint256 amount) external nonReentrant {
        uint256 balance = credit[msg.sender];
        if (amount == type(uint256).max) amount = balance;
        if (amount == 0) revert ZeroAmount();
        if (amount > balance) revert InsufficientCredit(amount, balance);

        unchecked {
            credit[msg.sender] = balance - amount;
            totalCredit -= amount;
        }
        emit CreditWithdrawn(msg.sender, msg.sender, amount, credit[msg.sender]);

        Address.sendValue(payable(msg.sender), amount);
    }

    // ─── Path B/C: gasless, relayer-submitted ───────────────────────────────

    /**
     * @notice Execute a subscription the user authorized off-chain with an
     *         EIP-712 signature. The relayer pays the gas; the fee is drawn
     *         from `credit[req.account]`.
     * @dev    Restricted to RELAYER_ROLE. The signature alone is a complete
     *         authorization, so leaving this open would let anyone burn a
     *         user's credit at a moment of their choosing (e.g. front-running
     *         a price change); gating it keeps execution timing with the
     *         operator the user is transacting with.
     * @param  req       The signed request.
     * @param  signature EOA (ECDSA) or ERC-1271 signature over `req` by `req.account`.
     */
    function subscribeWithSignature(SubscribeRequest calldata req, bytes calldata signature)
        external
        onlyRole(RELAYER_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (block.timestamp > req.deadline) revert SignatureExpired(req.deadline);
        if (req.account == address(0)) revert ZeroAddress();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SUBSCRIBE_REQUEST_TYPEHASH,
                    req.account,
                    req.tier,
                    req.periods,
                    req.autoRenew,
                    req.maxCost,
                    req.nonce,
                    req.deadline
                )
            )
        );
        if (!SignatureChecker.isValidSignatureNow(req.account, digest, signature)) revert InvalidSignature();

        // Reverts unless req.nonce is exactly the account's current nonce.
        _useCheckedNonce(req.account, req.nonce);

        if (req.tier >= TIER_COUNT) revert InvalidTier(req.tier);
        Tier tier = Tier(req.tier);

        uint256 cost = _quote(tier, req.periods);
        if (cost > req.maxCost) revert PriceExceedsAuthorized(cost, req.maxCost);

        _spendCredit(req.account, cost);

        if (req.autoRenew != _subscriptions[req.account].autoRenew) {
            _subscriptions[req.account].autoRenew = req.autoRenew;
            emit AutoRenewSet(req.account, req.autoRenew);
        }

        uint64 expiresAt = _applySubscription(req.account, tier, req.periods);
        emit Subscribed(req.account, tier, req.account, req.periods, cost, expiresAt, true);

        _forwardToTreasury(cost);
    }

    /**
     * @notice Renew an account that opted into auto-renew, charging one period
     *         to its credit. Callable only inside RENEW_WINDOW of expiry, so a
     *         relayer cannot drain a consenting user's credit early or in bulk.
     * @dev    Consent comes from the `autoRenew` flag the user signed into a
     *         prior `SubscribeRequest` (or set directly via `setAutoRenew`).
     * @param  account Subscriber to renew.
     */
    function renewFromCredit(address account) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        Subscription storage s = _subscriptions[account];
        if (!s.autoRenew) revert AutoRenewNotEnabled();
        if (s.tier == Tier.Free) revert SubscriptionNotActive();
        if (s.startedAt == 0) revert SubscriptionNotActive();
        if (s.expiresAt > block.timestamp + RENEW_WINDOW) revert NotDueForRenewal(s.expiresAt);

        Tier tier = s.tier;
        uint256 cost = _tierPrice[uint8(tier)];
        _spendCredit(account, cost);

        uint64 expiresAt = _applySubscription(account, tier, 1);
        emit AutoRenewed(account, tier, cost, expiresAt);

        _forwardToTreasury(cost);
    }

    /**
     * @notice Turn relayer auto-renewal on or off for your own account.
     * @param  enabled New consent value.
     */
    function setAutoRenew(bool enabled) external {
        _subscriptions[msg.sender].autoRenew = enabled;
        emit AutoRenewSet(msg.sender, enabled);
    }

    // ─── Core accounting ────────────────────────────────────────────────────

    /**
     * @dev Writes the new tier and expiry.
     *
     *      - Free: tier is set and expiry is NO_EXPIRY.
     *      - Same tier, still active: the purchase stacks onto the current expiry.
     *      - Different tier: unused time on the old tier is converted to 0G at
     *        the old rate, then back to seconds at the new rate, and added on
     *        top of the purchased periods. Value-preserving in both directions,
     *        and no money has to move to do it.
     */
    function _applySubscription(address account, Tier tier, uint8 periods) private returns (uint64 expiresAt) {
        Subscription storage s = _subscriptions[account];
        uint64 nowTs = uint64(block.timestamp);

        if (s.startedAt == 0) s.startedAt = nowTs;

        if (tier == Tier.Free) {
            s.tier = Tier.Free;
            s.expiresAt = NO_EXPIRY;
            return NO_EXPIRY;
        }

        uint64 purchased = uint64(periods) * PERIOD;

        if (s.tier == tier && s.expiresAt > nowTs && s.expiresAt != NO_EXPIRY) {
            expiresAt = s.expiresAt + purchased;
        } else {
            uint64 carryOver = _carryOverSeconds(s, tier, nowTs);
            expiresAt = nowTs + purchased + carryOver;
        }

        s.tier = tier;
        s.expiresAt = expiresAt;
        unchecked {
            s.renewals += 1;
            totalSubscriptions += 1;
        }
    }

    /// @dev Unused time on the old tier, re-priced into seconds of the new tier.
    function _carryOverSeconds(Subscription storage s, Tier newTier, uint64 nowTs) private view returns (uint64) {
        if (s.tier == Tier.Free || s.expiresAt == NO_EXPIRY || s.expiresAt <= nowTs) return 0;

        uint256 oldPrice = _tierPrice[uint8(s.tier)];
        uint256 newPrice = _tierPrice[uint8(newTier)];
        if (oldPrice == 0 || newPrice == 0) return 0;

        uint256 remaining = s.expiresAt - nowTs;
        // remaining * oldPrice / newPrice, rounded down; PERIOD cancels out on both sides.
        return uint64((remaining * oldPrice) / newPrice);
    }

    /// @dev Total wei owed for `periods` of `tier`, with tier/period validation.
    function _quote(Tier tier, uint8 periods) private view returns (uint256) {
        if (uint8(tier) >= TIER_COUNT) revert InvalidTier(uint8(tier));

        if (tier == Tier.Free) {
            if (periods != 0) revert FreeTierTakesNoPeriods();
            return 0;
        }

        if (periods == 0) revert PaidTierRequiresPeriods();
        if (periods > MAX_PERIODS) revert InvalidPeriods(periods);

        return _tierPrice[uint8(tier)] * periods;
    }

    function _addCredit(address account, address from, uint256 amount) private {
        credit[account] += amount;
        totalCredit += amount;
        emit CreditDeposited(account, from, amount, credit[account]);
    }

    function _spendCredit(address account, uint256 amount) private {
        if (amount == 0) return;
        uint256 balance = credit[account];
        if (balance < amount) revert InsufficientCredit(amount, balance);
        unchecked {
            credit[account] = balance - amount;
            totalCredit -= amount;
        }
        emit CreditSpent(account, amount, credit[account]);
    }

    /// @dev Always the last step of a paid flow: state is fully settled before value leaves.
    function _forwardToTreasury(uint256 amount) private {
        if (amount == 0) return;
        totalCollected += amount;
        emit PaymentForwarded(treasury, amount);
        Address.sendValue(treasury, amount);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice Price in wei for one 30-day period of `tier`.
    function tierPrice(Tier tier) external view returns (uint256) {
        if (uint8(tier) >= TIER_COUNT) revert InvalidTier(uint8(tier));
        return _tierPrice[uint8(tier)];
    }

    /// @notice All three tier prices in wei, indexed by tier.
    function allTierPrices() external view returns (uint256[TIER_COUNT] memory) {
        return _tierPrice;
    }

    /// @notice True while `account` holds a paid tier that has not expired. Free Creator is always active.
    function isActive(address account) public view returns (bool) {
        Subscription storage s = _subscriptions[account];
        if (s.startedAt == 0) return false;
        return s.expiresAt > block.timestamp;
    }

    /// @notice The tier `account` is entitled to right now — Free once a paid tier lapses.
    function currentTier(address account) public view returns (Tier) {
        Subscription storage s = _subscriptions[account];
        if (s.expiresAt > block.timestamp) return s.tier;
        return Tier.Free;
    }

    /**
     * @notice Full subscription state for `account`, in one call for the backend.
     * @return tier         Stored tier (may be a lapsed paid tier; compare with `active`).
     * @return startedAt    First-ever subscription timestamp, 0 if never subscribed.
     * @return expiresAt    Expiry timestamp, NO_EXPIRY for Free.
     * @return renewals     Count of paid subscribe/renew operations.
     * @return autoRenew    Auto-renew consent.
     * @return active       Whether the subscription is currently valid.
     * @return creditBalance Unspent prepaid credit in wei.
     */
    function subscriptionOf(address account)
        external
        view
        returns (
            Tier tier,
            uint64 startedAt,
            uint64 expiresAt,
            uint64 renewals,
            bool autoRenew,
            bool active,
            uint256 creditBalance
        )
    {
        Subscription storage s = _subscriptions[account];
        return (s.tier, s.startedAt, s.expiresAt, s.renewals, s.autoRenew, isActive(account), credit[account]);
    }

    /**
     * @notice What a purchase would cost and how much of it credit already covers.
     * @return cost          Total wei for `periods` of `tier`.
     * @return creditBalance The account's current credit.
     * @return dueNow        Wei the account must still send (0 if credit covers it — i.e. the gasless path is available).
     */
    function quote(address account, Tier tier, uint8 periods)
        external
        view
        returns (uint256 cost, uint256 creditBalance, uint256 dueNow)
    {
        cost = _quote(tier, periods);
        creditBalance = credit[account];
        dueNow = cost > creditBalance ? cost - creditBalance : 0;
    }

    /**
     * @notice Expiry that a purchase would produce, including any tier-change
     *         carry-over. Lets the UI show the exact new renewal date before
     *         the user signs.
     */
    function previewExpiry(address account, Tier tier, uint8 periods) external view returns (uint64) {
        _quote(tier, periods); // validation only
        if (tier == Tier.Free) return NO_EXPIRY;

        Subscription storage s = _subscriptions[account];
        uint64 nowTs = uint64(block.timestamp);
        uint64 purchased = uint64(periods) * PERIOD;

        if (s.tier == tier && s.expiresAt > nowTs && s.expiresAt != NO_EXPIRY) {
            return s.expiresAt + purchased;
        }
        return nowTs + purchased + _carryOverSeconds(s, tier, nowTs);
    }

    /// @notice True when the relayer could auto-renew `account` right now.
    function isDueForRenewal(address account) external view returns (bool) {
        Subscription storage s = _subscriptions[account];
        if (!s.autoRenew || s.tier == Tier.Free || s.startedAt == 0) return false;
        if (s.expiresAt > block.timestamp + RENEW_WINDOW) return false;
        return credit[account] >= _tierPrice[uint8(s.tier)];
    }

    /// @notice EIP-712 domain separator, for backends that build the digest themselves.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice The exact digest `account` must sign for `req`. Useful for debugging a rejected signature.
    function hashSubscribeRequest(SubscribeRequest calldata req) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SUBSCRIBE_REQUEST_TYPEHASH,
                    req.account,
                    req.tier,
                    req.periods,
                    req.autoRenew,
                    req.maxCost,
                    req.nonce,
                    req.deadline
                )
            )
        );
    }

    /// @notice Native balance held for the protocol itself (never user credit) — what `sweep()` can remove.
    function sweepable() public view returns (uint256) {
        uint256 balance = address(this).balance;
        return balance > totalCredit ? balance - totalCredit : 0;
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    /**
     * @notice Point future collections at a new treasury.
     * @param  newTreasury New destination address.
     */
    function setTreasury(address payable newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /**
     * @notice Update a tier's price. Existing subscriptions keep the time they
     *         already paid for; only future purchases are affected. Pending
     *         off-chain signatures are protected by their own `maxCost`.
     * @param  tier     Tier to reprice.
     * @param  newPrice New per-period price in wei. Must be 0 for Free, and non-zero for paid tiers.
     */
    function setTierPrice(Tier tier, uint256 newPrice) external onlyRole(PRICE_ADMIN_ROLE) {
        if (uint8(tier) >= TIER_COUNT) revert InvalidTier(uint8(tier));
        if (tier == Tier.Free) {
            if (newPrice != 0) revert FreeTierMustBeFree();
        } else {
            // A zero paid-tier price would disable the tier-change carry-over maths.
            if (newPrice == 0 || newPrice > MAX_TIER_PRICE) revert PriceTooHigh(newPrice);
        }

        uint256 oldPrice = _tierPrice[uint8(tier)];
        _tierPrice[uint8(tier)] = newPrice;
        emit TierPriceUpdated(tier, oldPrice, newPrice);
    }

    /// @notice Halt new subscriptions and renewals. Credit withdrawals stay available.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume subscriptions.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /**
     * @notice Recover native 0G that is not owed to any user — e.g. value
     *         force-sent via `selfdestruct`, which bypasses `receive()` and so
     *         is never credited to anyone.
     * @dev    Bounded by `sweepable()`, so `totalCredit` is always fully
     *         backed and no admin can touch user funds.
     * @param  to Recipient of the surplus.
     */
    function sweep(address payable to) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = sweepable();
        if (amount == 0) revert NothingToSweep();

        emit Swept(to, amount);
        Address.sendValue(to, amount);
    }
}
