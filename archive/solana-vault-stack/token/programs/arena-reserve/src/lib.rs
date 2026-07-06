use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer},
};

declare_id!("5BzJy7xd1MuUfg5aRGohUgZTwCP4VgQ7YnrLmavaN2BG");

// ── Constants ─────────────────────────────────────────────────────────────────

/// $ARENA token decimals (same as USDC for easy 1:1 mental model at launch)
const ARENA_DECIMALS: u8 = 6;

/// Basis-point denominator
const BPS_DENOMINATOR: u64 = 10_000;

/// Default redemption fee: 50 bps = 0.5%
const DEFAULT_REDEMPTION_FEE_BPS: u16 = 50;

/// Default ops treasury cut of fees: 20%
const DEFAULT_TREASURY_CUT_BPS: u16 = 2_000;

/// Max single-day redemptions as a fraction of supply (2000 bps = 20%)
const DAILY_REDEMPTION_CAP_BPS: u16 = 2_000;

// ── Program ───────────────────────────────────────────────────────────────────

#[program]
pub mod arena_reserve {
    use super::*;

    // ── Admin ─────────────────────────────────────────────────────────────────

    /// One-time setup step 1: create the reserve state PDA.
    /// Call initialize_vaults afterwards to create USDC + USDT vaults.
    pub fn initialize_reserve(
        ctx: Context<InitializeReserve>,
        bump: u8,
    ) -> Result<()> {
        let reserve = &mut ctx.accounts.reserve;
        reserve.authority           = ctx.accounts.authority.key();
        reserve.arena_mint          = ctx.accounts.arena_mint.key();
        reserve.usdc_mint           = ctx.accounts.usdc_mint.key();
        reserve.usdt_mint           = ctx.accounts.usdt_mint.key();
        // vault pubkeys will be filled in by initialize_vaults
        reserve.usdc_vault          = Pubkey::default();
        reserve.usdt_vault          = Pubkey::default();
        reserve.treasury            = ctx.accounts.treasury.key();
        reserve.total_reserve_usdc  = 0;
        reserve.total_reserve_usdt  = 0;
        reserve.total_shares        = 0;
        reserve.redemption_fee_bps  = DEFAULT_REDEMPTION_FEE_BPS;
        reserve.treasury_cut_bps    = DEFAULT_TREASURY_CUT_BPS;
        reserve.daily_redeemed      = 0;
        reserve.last_reset_ts       = Clock::get()?.unix_timestamp;
        reserve.is_paused           = false;
        reserve.bump                = bump;
        Ok(())
    }

    /// One-time setup step 2: create USDC and USDT vault PDAs owned by reserve.
    pub fn initialize_usdc_vault(ctx: Context<InitUsdcVault>) -> Result<()> {
        ctx.accounts.reserve.usdc_vault = ctx.accounts.usdc_vault.key();
        Ok(())
    }

    pub fn initialize_usdt_vault(ctx: Context<InitUsdtVault>) -> Result<()> {
        ctx.accounts.reserve.usdt_vault = ctx.accounts.usdt_vault.key();
        Ok(())
    }

    /// Update reserve parameters (authority only, ideally a multisig).
    pub fn update_params(
        ctx: Context<AdminOnly>,
        redemption_fee_bps: u16,
        treasury_cut_bps: u16,
    ) -> Result<()> {
        require!(redemption_fee_bps <= 500, ReserveError::FeeTooHigh);    // max 5%
        require!(treasury_cut_bps   <= 5_000, ReserveError::FeeTooHigh); // max 50%
        let reserve = &mut ctx.accounts.reserve;
        reserve.redemption_fee_bps = redemption_fee_bps;
        reserve.treasury_cut_bps   = treasury_cut_bps;
        Ok(())
    }

    pub fn pause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.reserve.is_paused = true;
        Ok(())
    }

    pub fn unpause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.reserve.is_paused = false;
        Ok(())
    }

    // ── Core: Deposit USDC → mint $ARENA ─────────────────────────────────────

    pub fn deposit_usdc(ctx: Context<DepositUsdc>, amount_usdc: u64) -> Result<()> {
        require!(!ctx.accounts.reserve.is_paused, ReserveError::Paused);
        require!(amount_usdc > 0, ReserveError::ZeroAmount);

        // Copy primitive fields before any borrows extend across CPI calls
        let bump = ctx.accounts.reserve.bump;
        let shares_to_mint = calculate_shares(
            amount_usdc,
            ctx.accounts.reserve.total_reserve_usdc.saturating_add(ctx.accounts.reserve.total_reserve_usdt),
            ctx.accounts.reserve.total_shares,
        );

        // Transfer USDC from user → reserve vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.user_usdc_account.to_account_info(),
                    to:        ctx.accounts.usdc_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_usdc,
        )?;

        // Mint $ARENA to user — reserve PDA is mint authority
        // `bump` is a copied u8 so `seeds` does NOT borrow ctx.accounts.reserve
        let seeds = &[b"reserve".as_ref(), &[bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.arena_mint.to_account_info(),
                    to:        ctx.accounts.user_arena_account.to_account_info(),
                    authority: ctx.accounts.reserve.to_account_info(),
                },
                &[&seeds[..]],
            ),
            shares_to_mint,
        )?;

        let reserve = &mut ctx.accounts.reserve;
        reserve.total_reserve_usdc = reserve.total_reserve_usdc.checked_add(amount_usdc)
            .ok_or(ReserveError::Overflow)?;
        reserve.total_shares = reserve.total_shares.checked_add(shares_to_mint)
            .ok_or(ReserveError::Overflow)?;

        let ratio = backing_ratio_bps(reserve);
        emit!(DepositEvent {
            user:          ctx.accounts.user.key(),
            asset:         AssetType::Usdc,
            asset_amount:  amount_usdc,
            arena_minted:  shares_to_mint,
            backing_ratio: ratio,
        });

        Ok(())
    }

    // ── Core: Deposit USDT → mint $ARENA ─────────────────────────────────────

    pub fn deposit_usdt(ctx: Context<DepositUsdt>, amount_usdt: u64) -> Result<()> {
        require!(!ctx.accounts.reserve.is_paused, ReserveError::Paused);
        require!(amount_usdt > 0, ReserveError::ZeroAmount);

        let bump = ctx.accounts.reserve.bump;
        let shares_to_mint = calculate_shares(
            amount_usdt,
            ctx.accounts.reserve.total_reserve_usdc.saturating_add(ctx.accounts.reserve.total_reserve_usdt),
            ctx.accounts.reserve.total_shares,
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.user_usdt_account.to_account_info(),
                    to:        ctx.accounts.usdt_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_usdt,
        )?;

        let seeds = &[b"reserve".as_ref(), &[bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.arena_mint.to_account_info(),
                    to:        ctx.accounts.user_arena_account.to_account_info(),
                    authority: ctx.accounts.reserve.to_account_info(),
                },
                &[&seeds[..]],
            ),
            shares_to_mint,
        )?;

        let reserve = &mut ctx.accounts.reserve;
        reserve.total_reserve_usdt = reserve.total_reserve_usdt.checked_add(amount_usdt)
            .ok_or(ReserveError::Overflow)?;
        reserve.total_shares = reserve.total_shares.checked_add(shares_to_mint)
            .ok_or(ReserveError::Overflow)?;

        let ratio = backing_ratio_bps(reserve);
        emit!(DepositEvent {
            user:          ctx.accounts.user.key(),
            asset:         AssetType::Usdt,
            asset_amount:  amount_usdt,
            arena_minted:  shares_to_mint,
            backing_ratio: ratio,
        });

        Ok(())
    }

    // ── Core: Burn $ARENA → receive USDC ─────────────────────────────────────

    pub fn redeem(ctx: Context<Redeem>, arena_amount: u64) -> Result<()> {
        require!(!ctx.accounts.reserve.is_paused, ReserveError::Paused);
        require!(arena_amount > 0, ReserveError::ZeroAmount);
        require!(arena_amount <= ctx.accounts.reserve.total_shares, ReserveError::InsufficientShares);

        // Copy primitive fields so seeds/CPI calls don't conflict with mutable borrow
        let bump = ctx.accounts.reserve.bump;

        // Reset daily counter if new day
        {
            let reserve = &mut ctx.accounts.reserve;
            let now = Clock::get()?.unix_timestamp;
            if now - reserve.last_reset_ts >= 86_400 {
                reserve.daily_redeemed = 0;
                reserve.last_reset_ts  = now;
            }
        }

        // Read state for calculations (immutable borrow, dropped before mutable reborrow)
        let (gross_usdc, fee, net_usdc, treasury_cut, reserve_cut) = {
            let reserve = &ctx.accounts.reserve;
            // Enforce daily cap
            let cap = (reserve.total_shares as u128)
                .checked_mul(DAILY_REDEMPTION_CAP_BPS as u128)
                .unwrap_or(0)
                / BPS_DENOMINATOR as u128;
            require!(
                (reserve.daily_redeemed as u128).saturating_add(arena_amount as u128) <= cap,
                ReserveError::DailyCapExceeded
            );

            let total_reserve = reserve.total_reserve_usdc.saturating_add(reserve.total_reserve_usdt);
            let gross_usdc = ((arena_amount as u128)
                .checked_mul(total_reserve as u128)
                .unwrap_or(0)
                / reserve.total_shares as u128) as u64;

            let fee          = gross_usdc * reserve.redemption_fee_bps as u64 / BPS_DENOMINATOR;
            let net_usdc     = gross_usdc - fee;
            let treasury_cut = fee * reserve.treasury_cut_bps as u64 / BPS_DENOMINATOR;
            let reserve_cut  = fee - treasury_cut;
            (gross_usdc, fee, net_usdc, treasury_cut, reserve_cut)
        };
        let _ = (gross_usdc, reserve_cut); // suppress unused warnings

        // Burn $ARENA
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint:      ctx.accounts.arena_mint.to_account_info(),
                    from:      ctx.accounts.user_arena_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            arena_amount,
        )?;

        // `bump` is a copied u8 — seeds does NOT borrow ctx.accounts.reserve
        let seeds = &[b"reserve".as_ref(), &[bump]];

        // Transfer net USDC to user
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.usdc_vault.to_account_info(),
                    to:        ctx.accounts.user_usdc_account.to_account_info(),
                    authority: ctx.accounts.reserve.to_account_info(),
                },
                &[&seeds[..]],
            ),
            net_usdc,
        )?;

        // Transfer treasury cut
        if treasury_cut > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from:      ctx.accounts.usdc_vault.to_account_info(),
                        to:        ctx.accounts.treasury_usdc_account.to_account_info(),
                        authority: ctx.accounts.reserve.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                treasury_cut,
            )?;
        }

        // Update state — mutable borrow starts here, after all CPIs are done
        let total_usdc_out = net_usdc + treasury_cut; // reserve_cut stays in vault
        let reserve = &mut ctx.accounts.reserve;
        reserve.total_reserve_usdc = reserve.total_reserve_usdc.saturating_sub(total_usdc_out);
        reserve.total_shares       = reserve.total_shares.saturating_sub(arena_amount);
        reserve.daily_redeemed     = reserve.daily_redeemed.saturating_add(arena_amount);

        emit!(RedeemEvent {
            user:         ctx.accounts.user.key(),
            arena_burned: arena_amount,
            usdc_out:     net_usdc,
            fee_charged:  fee,
        });

        Ok(())
    }

    // ── Bridge: Mint for cross-chain deposit ──────────────────────────────────

    /// Called by the bridge receiver program (or authorized relayer) after verifying
    /// a Wormhole VAA for a Base/0G deposit.
    pub fn receive_bridge_deposit(
        ctx: Context<BridgeDeposit>,
        amount_usdc: u64,
        recipient:   Pubkey,
        vaa_hash:    [u8; 32],
    ) -> Result<()> {
        require!(!ctx.accounts.reserve.is_paused, ReserveError::Paused);
        require!(amount_usdc > 0, ReserveError::ZeroAmount);
        require!(!ctx.accounts.vaa_record.processed, ReserveError::VaaAlreadyProcessed);

        // Copy primitive fields before any borrows extend across CPI calls
        let bump = ctx.accounts.reserve.bump;
        let shares_to_mint = calculate_shares(
            amount_usdc,
            ctx.accounts.reserve.total_reserve_usdc.saturating_add(ctx.accounts.reserve.total_reserve_usdt),
            ctx.accounts.reserve.total_shares,
        );

        // `bump` is a copied u8 — seeds does NOT borrow ctx.accounts.reserve
        let seeds = &[b"reserve".as_ref(), &[bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.arena_mint.to_account_info(),
                    to:        ctx.accounts.recipient_arena_account.to_account_info(),
                    authority: ctx.accounts.reserve.to_account_info(),
                },
                &[&seeds[..]],
            ),
            shares_to_mint,
        )?;

        // Mark VAA as processed
        ctx.accounts.vaa_record.processed = true;
        ctx.accounts.vaa_record.vaa_hash  = vaa_hash;

        // Mutable borrow starts here, after CPI is done
        // Note: the actual USDC is on the source chain (Base/0G).
        // We track it as "bridge reserves" — accounted in total but held cross-chain.
        // A separate reconciliation process bridges USDC to Solana periodically.
        let reserve = &mut ctx.accounts.reserve;
        reserve.total_reserve_usdc = reserve.total_reserve_usdc.checked_add(amount_usdc)
            .ok_or(ReserveError::Overflow)?;
        reserve.total_shares = reserve.total_shares.checked_add(shares_to_mint)
            .ok_or(ReserveError::Overflow)?;

        emit!(BridgeDepositEvent {
            recipient,
            usdc_amount:  amount_usdc,
            arena_minted: shares_to_mint,
            vaa_hash,
        });

        Ok(())
    }

    // ── Protocol Revenue: Add fees to reserve (increases backing ratio) ───────

    /// Called by the battle/tournament programs to route protocol fees into the reserve.
    /// This is what makes the backing ratio grow over time.
    pub fn add_protocol_revenue(ctx: Context<AddRevenue>, arena_amount: u64) -> Result<()> {
        require!(arena_amount > 0, ReserveError::ZeroAmount);

        // Transfer $ARENA from revenue source → burn (deflationary) OR keep in reserve.
        // We BURN the $ARENA fee and ADD equivalent USDC to the vault.
        // Net effect: total_reserve stays same, total_shares decreases → ratio increases.
        // Alternative: don't burn, just add USDC to vault.
        // Decision: ADD USDC to vault (revenue source sends USDC, not $ARENA).

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.revenue_usdc_account.to_account_info(),
                    to:        ctx.accounts.usdc_vault.to_account_info(),
                    authority: ctx.accounts.revenue_authority.to_account_info(),
                },
            ),
            arena_amount, // amount in USDC (same decimals)
        )?;

        let reserve = &mut ctx.accounts.reserve;
        reserve.total_reserve_usdc = reserve.total_reserve_usdc.checked_add(arena_amount)
            .ok_or(ReserveError::Overflow)?;
        // total_shares UNCHANGED → backing_ratio increases

        emit!(RevenueAddedEvent {
            usdc_added:   arena_amount,
            backing_ratio: backing_ratio_bps(reserve),
        });

        Ok(())
    }
}

// ── Math Helpers ──────────────────────────────────────────────────────────────

/// ERC-4626-style share calculation.
/// If total_shares == 0 (first deposit): shares = amount (1:1)
/// Otherwise: shares = amount * total_shares / total_reserve
fn calculate_shares(amount: u64, total_reserve: u64, total_shares: u64) -> u64 {
    if total_shares == 0 || total_reserve == 0 {
        return amount; // First deposit: 1:1
    }
    ((amount as u128)
        .saturating_mul(total_shares as u128)
        / total_reserve as u128) as u64
}

/// Returns backing ratio in basis points (10000 = 1.0000 USDC per $ARENA)
fn backing_ratio_bps(reserve: &ReserveState) -> u64 {
    if reserve.total_shares == 0 { return 10_000; }
    let total = reserve.total_reserve_usdc.saturating_add(reserve.total_reserve_usdt);
    ((total as u128)
        .saturating_mul(10_000)
        / reserve.total_shares as u128) as u64
}

// ── State ─────────────────────────────────────────────────────────────────────

#[account]
#[derive(Default)]
pub struct ReserveState {
    pub authority:          Pubkey,  // 32 — multisig
    pub arena_mint:         Pubkey,  // 32
    pub usdc_mint:          Pubkey,  // 32
    pub usdt_mint:          Pubkey,  // 32
    pub usdc_vault:         Pubkey,  // 32
    pub usdt_vault:         Pubkey,  // 32
    pub treasury:           Pubkey,  // 32 — ops treasury wallet
    pub total_reserve_usdc: u64,     // 8 — USDC in vault (6 decimals)
    pub total_reserve_usdt: u64,     // 8 — USDT in vault (6 decimals)
    pub total_shares:       u64,     // 8 — $ARENA supply (6 decimals)
    pub redemption_fee_bps: u16,     // 2 — default 50
    pub treasury_cut_bps:   u16,     // 2 — default 2000
    pub daily_redeemed:     u64,     // 8 — resets every 24h
    pub last_reset_ts:      i64,     // 8 — unix timestamp of last daily reset
    pub is_paused:          bool,    // 1
    pub bump:               u8,      // 1
}

#[account]
#[derive(Default)]
pub struct VaaRecord {
    pub vaa_hash:  [u8; 32], // 32 — Wormhole VAA hash
    pub processed: bool,     // 1
}

// ── Contexts ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(bump: u8)]
pub struct InitializeReserve<'info> {
    #[account(
        init,
        payer  = authority,
        space  = 8 + 32*7 + 8*5 + 2*2 + 1 + 1 + 64,
        seeds  = [b"reserve"],
        bump,
    )]
    pub reserve: Box<Account<'info, ReserveState>>,

    /// CHECK: only the pubkey is stored
    pub arena_mint: UncheckedAccount<'info>,
    /// CHECK: only the pubkey is stored
    pub usdc_mint:  UncheckedAccount<'info>,
    /// CHECK: only the pubkey is stored
    pub usdt_mint:  UncheckedAccount<'info>,

    /// CHECK: treasury is just a wallet address, no data needed
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Step-2a: create the USDC vault PDA and link it to the reserve.
#[derive(Accounts)]
pub struct InitUsdcVault<'info> {
    #[account(mut, has_one = authority, seeds = [b"reserve"], bump = reserve.bump)]
    pub reserve: Box<Account<'info, ReserveState>>,

    /// CHECK: usdc_mint stored in reserve
    pub usdc_mint: UncheckedAccount<'info>,

    #[account(
        init, payer = authority,
        token::mint = usdc_mint, token::authority = reserve,
        seeds = [b"usdc_vault"], bump,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent:           Sysvar<'info, Rent>,
}

/// Step-2b: create the USDT vault PDA and link it to the reserve.
#[derive(Accounts)]
pub struct InitUsdtVault<'info> {
    #[account(mut, has_one = authority, seeds = [b"reserve"], bump = reserve.bump)]
    pub reserve: Box<Account<'info, ReserveState>>,

    /// CHECK: usdt_mint stored in reserve
    pub usdt_mint: UncheckedAccount<'info>,

    #[account(
        init, payer = authority,
        token::mint = usdt_mint, token::authority = reserve,
        seeds = [b"usdt_vault"], bump,
    )]
    pub usdt_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent:           Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, has_one = authority, seeds = [b"reserve"], bump = reserve.bump)]
    pub reserve:   Box<Account<'info, ReserveState>>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct DepositUsdc<'info> {
    #[account(mut, seeds = [b"reserve"], bump = reserve.bump)]
    pub reserve: Box<Account<'info, ReserveState>>,

    #[account(mut, address = reserve.arena_mint)]
    pub arena_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = reserve.usdc_vault)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = reserve.usdc_mint, token::authority = user)]
    pub user_usdc_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed, payer = user,
        associated_token::mint = arena_mint,
        associated_token::authority = user,
    )]
    pub user_arena_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program:           Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:          Program<'info, System>,
    pub rent:                    Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositUsdt<'info> {
    #[account(mut, seeds = [b"reserve"], bump = reserve.bump)]
    pub reserve: Box<Account<'info, ReserveState>>,

    #[account(mut, address = reserve.arena_mint)]
    pub arena_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = reserve.usdt_vault)]
    pub usdt_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = reserve.usdt_mint, token::authority = user)]
    pub user_usdt_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed, payer = user,
        associated_token::mint = arena_mint,
        associated_token::authority = user,
    )]
    pub user_arena_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program:           Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:          Program<'info, System>,
    pub rent:                    Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut, seeds = [b"reserve"], bump = reserve.bump)]
    pub reserve: Box<Account<'info, ReserveState>>,

    #[account(mut, address = reserve.arena_mint)]
    pub arena_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = reserve.usdc_vault)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = reserve.arena_mint, token::authority = user)]
    pub user_arena_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = reserve.usdc_mint, token::authority = user)]
    pub user_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Treasury USDC account receives the fee cut
    #[account(mut, token::mint = reserve.usdc_mint)]
    pub treasury_usdc_account: Box<Account<'info, TokenAccount>>,

    pub user:          Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(amount_usdc: u64, recipient: Pubkey, vaa_hash: [u8; 32])]
pub struct BridgeDeposit<'info> {
    #[account(mut, seeds = [b"reserve"], bump = reserve.bump)]
    pub reserve: Box<Account<'info, ReserveState>>,

    #[account(mut, address = reserve.arena_mint)]
    pub arena_mint: Box<Account<'info, Mint>>,

    /// VAA record prevents replay attacks
    #[account(
        init_if_needed, payer = relayer,
        space = 8 + 32 + 1,
        seeds = [b"vaa", vaa_hash.as_ref()],
        bump,
    )]
    pub vaa_record: Box<Account<'info, VaaRecord>>,

    #[account(
        init_if_needed, payer = relayer,
        associated_token::mint = arena_mint,
        associated_token::authority = recipient_wallet,
    )]
    pub recipient_arena_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: recipient wallet for ATA derivation
    pub recipient_wallet: UncheckedAccount<'info>,

    /// The authorized bridge relayer
    #[account(mut, constraint = relayer.key() == reserve.authority @ ReserveError::Unauthorized)]
    pub relayer: Signer<'info>,

    pub token_program:           Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:          Program<'info, System>,
    pub rent:                    Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddRevenue<'info> {
    #[account(mut, seeds = [b"reserve"], bump = reserve.bump)]
    pub reserve: Box<Account<'info, ReserveState>>,

    #[account(mut, address = reserve.usdc_vault)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = reserve.usdc_mint)]
    pub revenue_usdc_account: Box<Account<'info, TokenAccount>>,

    pub revenue_authority: Signer<'info>,
    pub token_program:     Program<'info, Token>,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum AssetType { Usdc, Usdt }

#[event]
pub struct DepositEvent {
    pub user:          Pubkey,
    pub asset:         AssetType,
    pub asset_amount:  u64,
    pub arena_minted:  u64,
    pub backing_ratio: u64, // bps: 10000 = 1.0000
}

#[event]
pub struct RedeemEvent {
    pub user:         Pubkey,
    pub arena_burned: u64,
    pub usdc_out:     u64,
    pub fee_charged:  u64,
}

#[event]
pub struct BridgeDepositEvent {
    pub recipient:    Pubkey,
    pub usdc_amount:  u64,
    pub arena_minted: u64,
    pub vaa_hash:     [u8; 32],
}

#[event]
pub struct RevenueAddedEvent {
    pub usdc_added:   u64,
    pub backing_ratio: u64,
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum ReserveError {
    #[msg("Reserve is paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Fee parameter exceeds maximum")]
    FeeTooHigh,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Insufficient shares to redeem")]
    InsufficientShares,
    #[msg("Daily redemption cap exceeded — try again tomorrow")]
    DailyCapExceeded,
    #[msg("VAA has already been processed")]
    VaaAlreadyProcessed,
    #[msg("Caller is not authorized")]
    Unauthorized,
}
