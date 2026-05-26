import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://aiarena_user:U7FOzN8CD22yvRMLzBpkYK1ZcNlDcya7@dpg-d80n6mfaqgkc73a96p7g-a.oregon-postgres.render.com/aiarena?sslmode=require',
    },
  },
});

async function wipe() {
  console.log('Connecting...');
  await prisma.$executeRawUnsafe(`
    TRUNCATE
      "LedgerEntry",
      "AgentWallet",
      "StakingRecord",
      "LeaderboardEntry",
      "AgentMemory",
      "TrainingJob",
      "ZeroGFineTuneJob",
      "AIModel",
      "Battle",
      "EscrowRecord",
      "Agent"
    RESTART IDENTITY CASCADE
  `);
  console.log('Done — all agent data wiped. Users kept.');
  await prisma.$disconnect();
}

wipe().catch(e => { console.error(e.message); process.exit(1); });
