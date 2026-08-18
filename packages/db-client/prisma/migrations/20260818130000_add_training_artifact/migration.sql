-- CreateTable
CREATE TABLE "TrainingArtifact" (
    "id" TEXT NOT NULL,
    "trainingJobId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrainingArtifact_trainingJobId_key" ON "TrainingArtifact"("trainingJobId");

-- CreateIndex
CREATE INDEX "TrainingArtifact_digest_idx" ON "TrainingArtifact"("digest");
