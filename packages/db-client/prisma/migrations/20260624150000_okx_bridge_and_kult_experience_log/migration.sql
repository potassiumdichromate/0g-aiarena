-- CreateTable
CREATE TABLE "OkxAgentRequest" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "agentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestPayload" JSONB NOT NULL,
    "errorDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "OkxAgentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KultExperienceLog" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "outcome" TEXT,
    "delta" JSONB NOT NULL DEFAULT '{}',
    "rawPayload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KultExperienceLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OkxAgentRequest_idempotencyKey_key" ON "OkxAgentRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OkxAgentRequest_status_idx" ON "OkxAgentRequest"("status");

-- CreateIndex
CREATE INDEX "OkxAgentRequest_agentId_idx" ON "OkxAgentRequest"("agentId");

-- CreateIndex
CREATE INDEX "KultExperienceLog_agentId_createdAt_idx" ON "KultExperienceLog"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "KultExperienceLog_processedAt_idx" ON "KultExperienceLog"("processedAt");

-- AddForeignKey
ALTER TABLE "OkxAgentRequest" ADD CONSTRAINT "OkxAgentRequest_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KultExperienceLog" ADD CONSTRAINT "KultExperienceLog_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

