#!/usr/bin/env bash
# ============================================================
# deploy-devnet.sh — Deploy agent_wallet Anchor program to devnet
#
# Prerequisites:
#   1. Rust + cargo installed:  https://rustup.rs
#   2. Solana CLI installed:    https://docs.solana.com/cli/install-solana-cli-tools
#   3. Anchor CLI installed:    cargo install --git https://github.com/coral-xyz/anchor avm --locked
#                               avm install 0.30.1 && avm use 0.30.1
#   4. A Solana keypair at ~/.config/solana/id.json
#      (or set SOLANA_WALLET_PATH env var below)
#
# Run:
#   chmod +x deploy-devnet.sh
#   ./deploy-devnet.sh
# ============================================================

set -e

WALLET_PATH="${SOLANA_WALLET_PATH:-$HOME/.config/solana/id.json}"
CLUSTER="devnet"
PROGRAM_NAME="agent_wallet"
PROGRAM_ID="39W71ucMvVTxGMegur7XhfPUJU9m8Bqmh4qvRgykHMzk"

echo ""
echo "============================================"
echo "  AI Arena — Agent Wallet Devnet Deploy"
echo "============================================"
echo "  Cluster  : $CLUSTER"
echo "  Program  : $PROGRAM_ID"
echo "  Wallet   : $WALLET_PATH"
echo ""

# ── Step 1: Configure Solana CLI for devnet ──────────────────
echo ">>> Setting Solana CLI to devnet..."
solana config set --url https://api.devnet.solana.com

# ── Step 2: Check wallet balance ─────────────────────────────
echo ">>> Checking wallet balance..."
BALANCE=$(solana balance "$WALLET_PATH" --url devnet 2>/dev/null || echo "0 SOL")
echo "    Balance: $BALANCE"

# If balance is less than 2 SOL, airdrop
if [[ "$BALANCE" == "0 SOL" || "$BALANCE" == "0.0"* ]]; then
  echo ">>> Balance low — requesting devnet airdrop..."
  solana airdrop 2 "$WALLET_PATH" --url devnet
  sleep 5
  echo "    New balance: $(solana balance $WALLET_PATH --url devnet)"
fi

# ── Step 3: Build the program ─────────────────────────────────
echo ""
echo ">>> Building Anchor programs..."
cd "$(dirname "$0")"
anchor build

# ── Step 4: Deploy ────────────────────────────────────────────
echo ""
echo ">>> Deploying $PROGRAM_NAME to devnet..."
anchor deploy \
  --provider.cluster devnet \
  --provider.wallet "$WALLET_PATH" \
  --program-name "$PROGRAM_NAME"

# ── Step 5: Verify ────────────────────────────────────────────
echo ""
echo ">>> Verifying deployment..."
solana program show "$PROGRAM_ID" --url devnet

echo ""
echo "============================================"
echo "  Deploy complete!"
echo "  Program ID : $PROGRAM_ID"
echo "  Explorer   : https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
echo ""
echo "  Now set this env var on Render (financial-service):"
echo "    AGENT_WALLET_PROGRAM_ID=$PROGRAM_ID"
echo "    SOLANA_RPC_URL=https://api.devnet.solana.com"
echo "    SOLANA_PRIVATE_KEY=<base58 private key of your deployer wallet>"
echo "============================================"
echo ""
