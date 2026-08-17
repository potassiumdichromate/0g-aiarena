-- CreateEnum
CREATE TYPE "AgentIdentityStatus" AS ENUM ('PENDING', 'REGISTERING', 'REGISTERED', 'WALLET_LINKED', 'FAILED');

-- CreateTable
CREATE TABLE "AgentBaseIdentity" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "eoaAddress" TEXT NOT NULL,
    "eoaKeyEnc" TEXT NOT NULL,
    "ownerWallet" TEXT NOT NULL,
    "erc8004AgentId" TEXT,
    "status" "AgentIdentityStatus" NOT NULL DEFAULT 'PENDING',
    "agentURI" TEXT,
    "cardRootHash" TEXT,
    "registerTxHash" TEXT,
    "setWalletTxHash" TEXT,
    "lastError" TEXT,
    "registeredAt" TIMESTAMP(3),
    "registerLockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentBaseIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentBaseIdentity_agentId_key" ON "AgentBaseIdentity"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentBaseIdentity_eoaAddress_key" ON "AgentBaseIdentity"("eoaAddress");

-- CreateIndex
CREATE UNIQUE INDEX "AgentBaseIdentity_erc8004AgentId_key" ON "AgentBaseIdentity"("erc8004AgentId");

-- CreateIndex
CREATE INDEX "AgentBaseIdentity_ownerWallet_idx" ON "AgentBaseIdentity"("ownerWallet");

-- CreateIndex
CREATE INDEX "AgentBaseIdentity_status_idx" ON "AgentBaseIdentity"("status");
