use anchor_lang::prelude::*;

declare_id!("31xMWgFzecP9FyXKxNEs6SKkSsB5PU4BY3whFeF6thTY");

#[program]
pub mod tournament {
    use super::*;

    pub fn create_tournament(
        ctx: Context<CreateTournament>,
        tournament_id: String,
        max_participants: u32,
        entry_fee: u64,
        prize_pool: u64,
    ) -> Result<()> {
        let tournament = &mut ctx.accounts.tournament;
        tournament.tournament_id = tournament_id;
        tournament.authority = ctx.accounts.authority.key();
        tournament.max_participants = max_participants;
        tournament.entry_fee = entry_fee;
        tournament.prize_pool = prize_pool;
        tournament.participant_count = 0;
        tournament.status = TournamentStatus::Registration;
        tournament.created_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn enter_tournament(ctx: Context<EnterTournament>, agent_id: String) -> Result<()> {
        let tournament = &mut ctx.accounts.tournament;
        require_eq!(tournament.status, TournamentStatus::Registration, TournamentError::NotInRegistration);
        require!(tournament.participant_count < tournament.max_participants, TournamentError::TournamentFull);
        tournament.participant_count += 1;
        Ok(())
    }

    pub fn start_tournament(ctx: Context<ManageTournament>) -> Result<()> {
        ctx.accounts.tournament.status = TournamentStatus::InProgress;
        Ok(())
    }

    pub fn distribute_prizes(ctx: Context<ManageTournament>, winner_ids: Vec<String>, prize_amounts: Vec<u64>) -> Result<()> {
        require_eq!(ctx.accounts.tournament.status, TournamentStatus::InProgress, TournamentError::InvalidStatus);
        ctx.accounts.tournament.status = TournamentStatus::Completed;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum TournamentStatus {
    Registration,
    InProgress,
    Completed,
    Cancelled,
}

impl Default for TournamentStatus {
    fn default() -> Self { TournamentStatus::Registration }
}

#[account]
#[derive(Default)]
pub struct Tournament {
    pub tournament_id: String,
    pub authority: Pubkey,
    pub max_participants: u32,
    pub entry_fee: u64,
    pub prize_pool: u64,
    pub participant_count: u32,
    pub status: TournamentStatus,
    pub created_at: i64,
}

#[derive(Accounts)]
#[instruction(tournament_id: String)]
pub struct CreateTournament<'info> {
    #[account(init, payer = authority, space = 8 + 64 + 32 + 4 + 8 + 8 + 4 + 1 + 8 + 64, seeds = [b"tournament", tournament_id.as_bytes()], bump)]
    pub tournament: Account<'info, Tournament>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EnterTournament<'info> {
    #[account(mut)]
    pub tournament: Account<'info, Tournament>,
    pub participant: Signer<'info>,
}

#[derive(Accounts)]
pub struct ManageTournament<'info> {
    #[account(mut, has_one = authority)]
    pub tournament: Account<'info, Tournament>,
    pub authority: Signer<'info>,
}

#[error_code]
pub enum TournamentError {
    #[msg("Tournament is not in registration phase")]
    NotInRegistration,
    #[msg("Tournament is at max capacity")]
    TournamentFull,
    #[msg("Invalid tournament status")]
    InvalidStatus,
}
