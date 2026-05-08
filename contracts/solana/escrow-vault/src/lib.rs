use anchor_lang::prelude::*;

declare_id!("EscV11111111111111111111111111111111111111");

#[program]
pub mod escrow_vault {
    use super::*;

    /// Create a battle escrow PDA.
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        battle_id: String,
        agent_ids: Vec<String>,
        amounts: Vec<u64>,
        bump: u8,
    ) -> Result<()> {
        require!(agent_ids.len() == amounts.len(), EscrowError::InvalidParams);
        require!(agent_ids.len() >= 2, EscrowError::InvalidParams);

        let escrow = &mut ctx.accounts.escrow;
        escrow.battle_id = battle_id;
        escrow.agent_ids = agent_ids;
        escrow.amounts = amounts;
        escrow.authority = ctx.accounts.authority.key();
        escrow.state = EscrowState::Open;
        escrow.winner = None;
        escrow.bump = bump;
        escrow.created_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Fund the escrow from an agent wallet.
    pub fn fund_escrow(ctx: Context<FundEscrow>, agent_id: String, amount: u64) -> Result<()> {
        require_eq!(ctx.accounts.escrow.state, EscrowState::Open, EscrowError::InvalidState);
        // In production: transfer SPL tokens from agent ATA to escrow vault ATA
        ctx.accounts.escrow.state = EscrowState::Funded;
        Ok(())
    }

    /// Lock the escrow when battle starts.
    pub fn lock_escrow(ctx: Context<LockEscrow>) -> Result<()> {
        require_eq!(ctx.accounts.escrow.state, EscrowState::Funded, EscrowError::InvalidState);
        ctx.accounts.escrow.state = EscrowState::Locked;
        Ok(())
    }

    /// Settle the escrow and pay the winner.
    pub fn settle_escrow(ctx: Context<SettleEscrow>, winner_id: String) -> Result<()> {
        require_eq!(ctx.accounts.escrow.state, EscrowState::Locked, EscrowError::InvalidState);
        require!(
            ctx.accounts.escrow.agent_ids.contains(&winner_id),
            EscrowError::InvalidWinner
        );

        ctx.accounts.escrow.state = EscrowState::Settled;
        ctx.accounts.escrow.winner = Some(winner_id);
        ctx.accounts.escrow.settled_at = Some(Clock::get()?.unix_timestamp);

        // In production: transfer total pool to winner's wallet ATA
        Ok(())
    }

    /// Cancel the escrow and refund all participants.
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        require!(
            ctx.accounts.escrow.state == EscrowState::Open
                || ctx.accounts.escrow.state == EscrowState::Funded,
            EscrowError::InvalidState
        );

        ctx.accounts.escrow.state = EscrowState::Cancelled;
        // In production: refund each agent's wallet
        Ok(())
    }
}

// ===== TYPES =====

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum EscrowState {
    Open,
    Funded,
    Locked,
    Settled,
    Cancelled,
    Disputed,
}

impl Default for EscrowState {
    fn default() -> Self {
        EscrowState::Open
    }
}

// ===== ACCOUNTS =====

#[account]
#[derive(Default)]
pub struct BattleEscrow {
    pub battle_id: String,           // 64 bytes
    pub agent_ids: Vec<String>,      // 2 * 64 bytes
    pub amounts: Vec<u64>,           // 2 * 8 bytes
    pub authority: Pubkey,           // 32 bytes
    pub state: EscrowState,          // 1 byte
    pub winner: Option<String>,      // 65 bytes
    pub bump: u8,                    // 1 byte
    pub created_at: i64,             // 8 bytes
    pub settled_at: Option<i64>,     // 9 bytes
}

// ===== CONTEXTS =====

#[derive(Accounts)]
#[instruction(battle_id: String, agent_ids: Vec<String>, amounts: Vec<u64>, bump: u8)]
pub struct CreateEscrow<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 64 + 2 * 64 + 2 * 8 + 32 + 1 + 65 + 1 + 8 + 9 + 64,
        seeds = [b"escrow", battle_id.as_bytes()],
        bump,
    )]
    pub escrow: Account<'info, BattleEscrow>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundEscrow<'info> {
    #[account(mut)]
    pub escrow: Account<'info, BattleEscrow>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct LockEscrow<'info> {
    #[account(mut, has_one = authority)]
    pub escrow: Account<'info, BattleEscrow>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettleEscrow<'info> {
    #[account(mut, has_one = authority)]
    pub escrow: Account<'info, BattleEscrow>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    #[account(mut, has_one = authority)]
    pub escrow: Account<'info, BattleEscrow>,
    pub authority: Signer<'info>,
}

// ===== ERRORS =====

#[error_code]
pub enum EscrowError {
    #[msg("Invalid escrow state for this operation")]
    InvalidState,
    #[msg("Winner must be one of the escrow participants")]
    InvalidWinner,
    #[msg("Invalid parameters provided")]
    InvalidParams,
    #[msg("Escrow timeout has not elapsed")]
    TimeoutNotElapsed,
}
