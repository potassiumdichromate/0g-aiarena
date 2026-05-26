use anchor_lang::prelude::*;

declare_id!("39W71ucMvVTxGMegur7XhfPUJU9m8Bqmh4qvRgykHMzk");

#[program]
pub mod agent_wallet {
    use super::*;

    /// Create a new agent wallet PDA for the given agent ID.
    pub fn create_wallet(ctx: Context<CreateWallet>, agent_id: String, bump: u8) -> Result<()> {
        let wallet = &mut ctx.accounts.wallet;
        wallet.agent_id = agent_id;
        wallet.authority = ctx.accounts.authority.key();
        wallet.balance = 0;
        wallet.is_frozen = false;
        wallet.daily_spend_used = 0;
        wallet.daily_reset_timestamp = Clock::get()?.unix_timestamp;
        wallet.bump = bump;
        Ok(())
    }

    /// Transfer ARENA tokens between two agent wallets.
    pub fn transfer(ctx: Context<Transfer>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.from_wallet.is_frozen, WalletError::WalletFrozen);
        require!(ctx.accounts.from_wallet.balance >= amount, WalletError::InsufficientFunds);

        ctx.accounts.from_wallet.balance -= amount;
        ctx.accounts.to_wallet.balance += amount;
        Ok(())
    }

    /// Freeze an agent wallet (admin action for anti-cheat).
    pub fn freeze_wallet(ctx: Context<FreezeWallet>) -> Result<()> {
        ctx.accounts.wallet.is_frozen = true;
        Ok(())
    }

    /// Unfreeze a wallet.
    pub fn unfreeze_wallet(ctx: Context<FreezeWallet>) -> Result<()> {
        ctx.accounts.wallet.is_frozen = false;
        Ok(())
    }

    /// Credit $ARENA balance to an agent wallet.
    /// Called by the platform authority after battle rewards or deposits.
    /// NOTE: For devnet demo — any signer can credit. Mainnet: add authority PDA check.
    pub fn credit(ctx: Context<Credit>, amount: u64) -> Result<()> {
        ctx.accounts.wallet.balance = ctx.accounts.wallet.balance.saturating_add(amount);
        Ok(())
    }

    /// Debit $ARENA balance from an agent wallet (platform-side escrow lock).
    pub fn debit(ctx: Context<Credit>, amount: u64) -> Result<()> {
        require!(ctx.accounts.wallet.balance >= amount, WalletError::InsufficientFunds);
        require!(!ctx.accounts.wallet.is_frozen, WalletError::WalletFrozen);
        ctx.accounts.wallet.balance = ctx.accounts.wallet.balance.saturating_sub(amount);
        Ok(())
    }

    /// Update the spending policy limits.
    pub fn update_policy(
        ctx: Context<UpdatePolicy>,
        max_single_wager: u64,
        max_daily_spend: u64,
    ) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        policy.max_single_wager = max_single_wager;
        policy.max_daily_spend = max_daily_spend;
        Ok(())
    }
}

// ===== ACCOUNTS =====

#[account]
#[derive(Default)]
pub struct AgentWallet {
    pub agent_id: String,           // 64 bytes
    pub authority: Pubkey,          // 32 bytes
    pub balance: u64,               // 8 bytes
    pub is_frozen: bool,            // 1 byte
    pub daily_spend_used: u64,      // 8 bytes
    pub daily_reset_timestamp: i64, // 8 bytes
    pub bump: u8,                   // 1 byte
}

impl AgentWallet {
    pub const MAX_SIZE: usize = 8 + 64 + 32 + 8 + 1 + 8 + 8 + 1;
}

#[account]
#[derive(Default)]
pub struct SpendingPolicy {
    pub wallet: Pubkey,
    pub max_single_wager: u64,
    pub max_daily_spend: u64,
    pub allowed_game_ids: Vec<String>,
    pub require_approval_above: u64,
    pub is_active: bool,
}

// ===== CONTEXTS =====

#[derive(Accounts)]
#[instruction(agent_id: String, bump: u8)]
pub struct CreateWallet<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + AgentWallet::MAX_SIZE,
        seeds = [b"agent-wallet", agent_id.as_bytes()],
        bump,
    )]
    pub wallet: Account<'info, AgentWallet>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Transfer<'info> {
    #[account(mut, has_one = authority)]
    pub from_wallet: Account<'info, AgentWallet>,
    #[account(mut)]
    pub to_wallet: Account<'info, AgentWallet>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct FreezeWallet<'info> {
    #[account(mut)]
    pub wallet: Account<'info, AgentWallet>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Credit<'info> {
    #[account(mut)]
    pub wallet: Account<'info, AgentWallet>,
    /// Platform authority signer (SOLANA_PRIVATE_KEY).
    /// Devnet: any signer allowed. Mainnet: add has_one constraint to a config PDA.
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    // wallet must appear before policy because policy's seeds reference wallet.key()
    pub wallet: Account<'info, AgentWallet>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + 32 + 8 + 8 + 8 + 1 + 200,
        seeds = [b"spending-policy", wallet.key().as_ref()],
        bump,
    )]
    pub policy: Account<'info, SpendingPolicy>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ===== ERRORS =====

#[error_code]
pub enum WalletError {
    #[msg("Wallet is frozen and cannot be used")]
    WalletFrozen,
    #[msg("Insufficient funds in agent wallet")]
    InsufficientFunds,
    #[msg("Wager exceeds maximum single wager limit")]
    WagerLimitExceeded,
    #[msg("Daily spend limit exceeded")]
    DailyLimitExceeded,
    #[msg("Unauthorized: not the wallet authority")]
    Unauthorized,
}
