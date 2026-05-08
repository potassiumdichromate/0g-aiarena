use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("EscV11111111111111111111111111111111111111");

#[program]
pub mod escrow_vault {
    use super::*;

    /// Create a battle escrow PDA and its associated token vault account.
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
        escrow.battle_id    = battle_id;
        escrow.agent_ids    = agent_ids;
        escrow.amounts      = amounts;
        escrow.authority    = ctx.accounts.authority.key();
        escrow.token_mint   = ctx.accounts.token_mint.key();
        escrow.vault        = ctx.accounts.escrow_vault.key();
        escrow.state        = EscrowState::Open;
        escrow.funded_count = 0;
        escrow.winner       = None;
        escrow.bump         = bump;
        escrow.created_at   = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Fund the escrow: transfer SPL tokens from the agent's ATA to the escrow vault.
    /// Each participant calls this once. When all agents have funded, state → Funded.
    pub fn fund_escrow(
        ctx: Context<FundEscrow>,
        agent_index: u8,   // index into escrow.agent_ids / escrow.amounts
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require_eq!(escrow.state, EscrowState::Open, EscrowError::InvalidState);
        require!(
            (agent_index as usize) < escrow.amounts.len(),
            EscrowError::InvalidParams
        );

        let amount = escrow.amounts[agent_index as usize];

        // CPI: transfer SPL tokens from agent ATA → escrow vault ATA
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.agent_token_account.to_account_info(),
                    to:        ctx.accounts.escrow_vault.to_account_info(),
                    authority: ctx.accounts.agent_authority.to_account_info(),
                },
            ),
            amount,
        )?;

        escrow.funded_count += 1;

        // All participants funded → advance state
        if escrow.funded_count as usize >= escrow.agent_ids.len() {
            escrow.state = EscrowState::Funded;
        }

        Ok(())
    }

    /// Lock the escrow when the battle starts. No tokens move.
    pub fn lock_escrow(ctx: Context<LockEscrow>) -> Result<()> {
        require_eq!(ctx.accounts.escrow.state, EscrowState::Funded, EscrowError::InvalidState);
        ctx.accounts.escrow.state = EscrowState::Locked;
        Ok(())
    }

    /// Settle: transfer the entire vault balance to the winner's token account.
    /// Authority must be the escrow authority (backend settlement service).
    pub fn settle_escrow(ctx: Context<SettleEscrow>, winner_id: String) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require_eq!(escrow.state, EscrowState::Locked, EscrowError::InvalidState);
        require!(escrow.agent_ids.contains(&winner_id), EscrowError::InvalidWinner);

        // Total pool = sum of all amounts
        let total: u64 = escrow.amounts.iter().sum();

        // Seeds for PDA signer
        let battle_id = escrow.battle_id.clone();
        let bump      = escrow.bump;
        let seeds     = &[b"escrow".as_ref(), battle_id.as_bytes(), &[bump]];
        let signer    = &[&seeds[..]];

        // CPI: transfer full vault balance → winner ATA, signed by escrow PDA
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.escrow_vault.to_account_info(),
                    to:        ctx.accounts.winner_token_account.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer,
            ),
            total,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.state      = EscrowState::Settled;
        escrow.winner     = Some(winner_id);
        escrow.settled_at = Some(Clock::get()?.unix_timestamp);

        Ok(())
    }

    /// Refund one participant. Call once per agent to fully cancel a battle.
    /// Only valid in Open or Funded states.
    pub fn refund_participant(
        ctx: Context<RefundParticipant>,
        agent_index: u8,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            escrow.state == EscrowState::Open || escrow.state == EscrowState::Funded,
            EscrowError::InvalidState
        );
        require!(
            (agent_index as usize) < escrow.amounts.len(),
            EscrowError::InvalidParams
        );

        let amount    = escrow.amounts[agent_index as usize];
        let battle_id = escrow.battle_id.clone();
        let bump      = escrow.bump;
        let seeds     = &[b"escrow".as_ref(), battle_id.as_bytes(), &[bump]];
        let signer    = &[&seeds[..]];

        // CPI: refund agent's amount from vault → their ATA
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.escrow_vault.to_account_info(),
                    to:        ctx.accounts.agent_token_account.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        Ok(())
    }

    /// Mark escrow cancelled. Call refund_participant for each agent to move tokens.
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        require!(
            ctx.accounts.escrow.state == EscrowState::Open
                || ctx.accounts.escrow.state == EscrowState::Funded,
            EscrowError::InvalidState
        );
        ctx.accounts.escrow.state = EscrowState::Cancelled;
        Ok(())
    }
}

// ── Types ─────────────────────────────────────────────────────────────────────

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
    fn default() -> Self { EscrowState::Open }
}

// ── State account ─────────────────────────────────────────────────────────────

#[account]
#[derive(Default)]
pub struct BattleEscrow {
    pub battle_id:    String,         // 64
    pub agent_ids:    Vec<String>,    // 2 * 64
    pub amounts:      Vec<u64>,       // 2 * 8
    pub authority:    Pubkey,         // 32 — backend settlement service
    pub token_mint:   Pubkey,         // 32 — ARENA SPL token mint
    pub vault:        Pubkey,         // 32 — escrow vault ATA address
    pub state:        EscrowState,    // 1
    pub funded_count: u8,             // 1 — incremented per fund_escrow call
    pub winner:       Option<String>, // 65
    pub bump:         u8,             // 1
    pub created_at:   i64,            // 8
    pub settled_at:   Option<i64>,    // 9
}

// ── Contexts ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(battle_id: String, agent_ids: Vec<String>, amounts: Vec<u64>, bump: u8)]
pub struct CreateEscrow<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 64 + 2*64 + 2*8 + 32 + 32 + 32 + 1 + 1 + 65 + 1 + 8 + 9 + 64,
        seeds = [b"escrow", battle_id.as_bytes()],
        bump,
    )]
    pub escrow: Account<'info, BattleEscrow>,

    /// The PDA-owned token vault that holds staked ARENA tokens during the battle.
    #[account(
        init,
        payer = authority,
        token::mint      = token_mint,
        token::authority = escrow,
        seeds = [b"vault", battle_id.as_bytes()],
        bump,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    pub token_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent:           Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundEscrow<'info> {
    #[account(mut, seeds = [b"escrow", escrow.battle_id.as_bytes()], bump = escrow.bump)]
    pub escrow: Account<'info, BattleEscrow>,

    /// Escrow vault ATA (destination)
    #[account(mut, address = escrow.vault)]
    pub escrow_vault: Account<'info, TokenAccount>,

    /// Agent's ATA for ARENA token (source)
    #[account(mut, token::mint = escrow.token_mint, token::authority = agent_authority)]
    pub agent_token_account: Account<'info, TokenAccount>,

    pub agent_authority: Signer<'info>,
    pub token_program:   Program<'info, Token>,
}

#[derive(Accounts)]
pub struct LockEscrow<'info> {
    #[account(mut, has_one = authority, seeds = [b"escrow", escrow.battle_id.as_bytes()], bump = escrow.bump)]
    pub escrow: Account<'info, BattleEscrow>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettleEscrow<'info> {
    #[account(mut, has_one = authority, seeds = [b"escrow", escrow.battle_id.as_bytes()], bump = escrow.bump)]
    pub escrow: Account<'info, BattleEscrow>,

    /// Escrow vault ATA (source — PDA-owned, signs via seeds)
    #[account(mut, address = escrow.vault)]
    pub escrow_vault: Account<'info, TokenAccount>,

    /// Winner's ATA for ARENA token (destination)
    #[account(mut, token::mint = escrow.token_mint)]
    pub winner_token_account: Account<'info, TokenAccount>,

    pub authority:     Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundParticipant<'info> {
    #[account(mut, has_one = authority, seeds = [b"escrow", escrow.battle_id.as_bytes()], bump = escrow.bump)]
    pub escrow: Account<'info, BattleEscrow>,

    #[account(mut, address = escrow.vault)]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut, token::mint = escrow.token_mint)]
    pub agent_token_account: Account<'info, TokenAccount>,

    pub authority:     Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    #[account(mut, has_one = authority, seeds = [b"escrow", escrow.battle_id.as_bytes()], bump = escrow.bump)]
    pub escrow: Account<'info, BattleEscrow>,
    pub authority: Signer<'info>,
}

// ── Errors ────────────────────────────────────────────────────────────────────

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
