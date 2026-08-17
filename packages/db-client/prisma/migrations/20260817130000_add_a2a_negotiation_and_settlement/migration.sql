-- CreateEnum
CREATE TYPE "A2ANegotiationState" AS ENUM ('OPEN', 'AGREED', 'DECLINED', 'EXPIRED');

-- AlterTable
ALTER TABLE "A2AJob" ADD COLUMN     "agreedPriceBaseUnits" TEXT,
ADD COLUMN     "agreementHash" TEXT,
ADD COLUMN     "deliverTxHash" TEXT,
ADD COLUMN     "deliverableHash" TEXT,
ADD COLUMN     "deliverableRootHash" TEXT,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "executingTxHash" TEXT,
ADD COLUMN     "feedbackHash" TEXT,
ADD COLUMN     "feedbackJson" TEXT,
ADD COLUMN     "fundTxHash" TEXT,
ADD COLUMN     "fundedAt" TIMESTAMP(3),
ADD COLUMN     "providerAgentId" TEXT,
ADD COLUMN     "providerErc8004Id" TEXT,
ADD COLUMN     "providerWallet" TEXT,
ADD COLUMN     "reputationTxHash" TEXT,
ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "trainingJobId" TEXT,
ADD COLUMN     "verdictAccepted" BOOLEAN,
ADD COLUMN     "verdictReason" TEXT,
ADD COLUMN     "verdictReportHash" TEXT,
ADD COLUMN     "verdictTxHash" TEXT,
ADD COLUMN     "verificationSnapshotId" TEXT,
ADD COLUMN     "verifiedValue" INTEGER,
ADD COLUMN     "winningNegotiationId" TEXT;

-- CreateTable
CREATE TABLE "A2ANegotiation" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "providerAgentId" TEXT NOT NULL,
    "providerErc8004Id" TEXT NOT NULL,
    "providerWallet" TEXT NOT NULL,
    "state" "A2ANegotiationState" NOT NULL DEFAULT 'OPEN',
    "agreedPriceBaseUnits" TEXT,
    "transcriptHash" TEXT,
    "agreementHash" TEXT,
    "agreementExpiry" INTEGER,
    "creatorSignature" TEXT,
    "providerSignature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "A2ANegotiation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "A2ANegotiationMessage" (
    "id" TEXT NOT NULL,
    "negotiationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "priceBaseUnits" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "prevHash" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "signerAddress" TEXT NOT NULL,
    "agentErc8004Id" TEXT NOT NULL,
    "expiresAt" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "A2ANegotiationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "A2ANegotiation_jobId_state_idx" ON "A2ANegotiation"("jobId", "state");

-- CreateIndex
CREATE INDEX "A2ANegotiation_providerAgentId_idx" ON "A2ANegotiation"("providerAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "A2ANegotiation_jobId_providerAgentId_key" ON "A2ANegotiation"("jobId", "providerAgentId");

-- CreateIndex
CREATE INDEX "A2ANegotiationMessage_negotiationId_idx" ON "A2ANegotiationMessage"("negotiationId");

-- CreateIndex
CREATE UNIQUE INDEX "A2ANegotiationMessage_negotiationId_seq_key" ON "A2ANegotiationMessage"("negotiationId", "seq");

-- AddForeignKey
ALTER TABLE "A2ANegotiationMessage" ADD CONSTRAINT "A2ANegotiationMessage_negotiationId_fkey" FOREIGN KEY ("negotiationId") REFERENCES "A2ANegotiation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

