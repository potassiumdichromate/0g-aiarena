use anchor_lang::prelude::*;

declare_id!("7eAFYSQ7FyPXWBcxR5XiJFcPBdt4VHN6S3u4oZfahVWC");

#[program]
pub mod staking {
    use super::*;

    pub fn create_stake(ctx: Context<CreateStake>, amount: u64, lock_period_seconds: i64) -> Result<()> {
        require!(amount > 0, StakingError::InvalidAmount);
        let stake = &mut ctx.accounts.stake;
        stake.staker = ctx.accounts.staker.key();
        stake.agent_id = ctx.accounts.agent_wallet.key().to_string();
        stake.amount = amount;
        stake.staked_at = Clock::get()?.unix_timestamp;
        stake.unlock_at = Clock::get()?.unix_timestamp + lock_period_seconds;
        stake.is_active = true;
        Ok(())
    }

    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let stake = &mut ctx.accounts.stake;
        let now = Clock::get()?.unix_timestamp;
        require!(stake.is_active, StakingError::AlreadyUnstaked);
        require!(now >= stake.unlock_at, StakingError::LockPeriodNotElapsed);
        stake.is_active = false;
        Ok(())
    }
}

#[account]
#[derive(Default)]
pub struct AgentStake {
    pub staker: Pubkey,
    pub agent_id: String,
    pub amount: u64,
    pub staked_at: i64,
    pub unlock_at: i64,
    pub is_active: bool,
}

#[derive(Accounts)]
pub struct CreateStake<'info> {
    #[account(init, payer = staker, space = 8 + 32 + 64 + 8 + 8 + 8 + 1, seeds = [b"stake", staker.key().as_ref()], bump)]
    pub stake: Account<'info, AgentStake>,
    #[account(mut)]
    pub staker: Signer<'info>,
    pub agent_wallet: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut, has_one = staker)]
    pub stake: Account<'info, AgentStake>,
    pub staker: Signer<'info>,
}

#[error_code]
pub enum StakingError {
    #[msg("Invalid stake amount")]
    InvalidAmount,
    #[msg("Stake is already inactive")]
    AlreadyUnstaked,
    #[msg("Lock period has not elapsed yet")]
    LockPeriodNotElapsed,
}
