/**
 * TrainingQueueService — queues training jobs with 0G Storage integration.
 *
 * 0G Storage usage:
 *   - createJob()         → upload training dataset JSONL to 0G Storage → dataset_root_hash
 *   - completeJob()       → store model_root_hash (from worker) → update INFT on-chain
 *   - getTrainingDataset()→ download dataset by rootHash for the worker
 *
 * Job flow:
 *   1. Caller provides raw training data (state-action pairs as JSONL)
 *   2. We upload the JSONL to 0G Storage → get dataset_root_hash
 *   3. We create a DB TrainingJob record with dataset_root_hash in config
 *   4. Publish TRAINING_QUEUED event (training-worker picks it up via NATS)
 *   5. Worker reads dataset_root_hash, downloads from 0G, runs fine-tuning
 *   6. Worker calls completeJob() with the output model_root_hash
 *   7. We update the agent's active model and call inft-service to anchor on-chain
 */

import { prisma, TrainingRepository } from '@ai-arena/db-client';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';
import { ZeroGStorageClient, getZeroGConfig } from '@ai-arena/zerog-client';

const trainingRepo = new TrainingRepository(prisma);
const storage      = new ZeroGStorageClient(getZeroGConfig());

export interface TrainingJobParams {
  agentId:       string;
  type?:         'BEHAVIOUR_CLONING' | 'REINFORCEMENT_LEARNING' | 'LORA_FINETUNE';
  priority?:     number;
  trainingData?: Array<Record<string, unknown>>; // state-action pairs
  baseModel?:    'Qwen2.5-0.5B-Instruct' | 'Qwen3-32B';
  config?:       Record<string, unknown>;
}

export class TrainingQueueService {

  async createJob(params: TrainingJobParams) {
    let datasetRootHash: string | null = null;
    let datasetTxHash:   string | null = null;

    // ── Upload training dataset to 0G Storage ────────────────────────────────
    if (params.trainingData && params.trainingData.length > 0) {
      try {
        // Serialize as JSONL (one record per line — required format for 0G fine-tuning CLI)
        const jsonl = params.trainingData
          .map(record => JSON.stringify(record))
          .join('\n');

        const buf    = Buffer.from(jsonl, 'utf8');
        const result = await storage.uploadBuffer(buf);

        datasetRootHash = result.rootHash;
        datasetTxHash   = [result.txHash].flat()[0] ?? null;

        // Index so we can retrieve it by agent + job context
        await prisma.storageIndex.create({
          data: {
            logicalPath: `training/${params.agentId}/datasets/${Date.now()}`,
            rootHash:    datasetRootHash,
            txHash:      datasetTxHash,
            mimeType:    'application/jsonl',
            sizeBytes:   buf.byteLength,
            uploadedBy:  'training-service',
            tags:        ['training-dataset', params.agentId],
          },
        });

        console.info(
          `[TrainingQueue] Dataset uploaded to 0G Storage: ${datasetRootHash} ` +
          `(${params.trainingData.length} records, ${buf.byteLength} bytes)`
        );
      } catch (err) {
        console.error('[TrainingQueue] Failed to upload dataset to 0G Storage:', err);
        // Continue without dataset — worker will handle missing hash
      }
    }

    // ── Create DB record ──────────────────────────────────────────────────────
    const job = await trainingRepo.create({
      agent:    { connect: { id: params.agentId } },
      type:     (params.type as any) ?? 'BEHAVIOUR_CLONING',
      priority: params.priority ?? 5,
      config:   {
        ...params.config,
        baseModel:       params.baseModel ?? 'Qwen2.5-0.5B-Instruct',
        datasetRootHash, // 0G Storage root hash — passed to worker
        datasetTxHash,
        useZerogCompute: true,
      },
    });

    // ── Publish event → training-worker picks up via NATS ────────────────────
    const bus = await getEventBus();
    await bus.publish(SUBJECTS.TRAINING_QUEUED, {
      jobId:           job.id,
      agentId:         params.agentId,
      type:            job.type,
      priority:        job.priority,
      datasetRootHash,
      baseModel:       params.baseModel ?? 'Qwen2.5-0.5B-Instruct',
      occurredAt:      new Date(),
    });

    return { ...job, datasetRootHash };
  }

  /**
   * Called by training-worker after fine-tuning completes.
   * Stores the output model rootHash and triggers INFT on-chain update.
   */
  async completeJob(jobId: string, result: {
    modelRootHash:  string;     // 0G Storage root hash of fine-tuned LoRA weights
    metrics:        Record<string, unknown>;
    providerAddress?: string;
    zerogTaskId?:   string;
  }) {
    const job = await trainingRepo.findById(jobId);
    if (!job) throw new Error(`Training job ${jobId} not found`);

    // Update job record
    await prisma.trainingJob.update({
      where: { id: jobId },
      data: {
        status:      'COMPLETED',
        completedAt: new Date(),
        metrics:     result.metrics as any,
        modelId:     result.modelRootHash,
      },
    });

    // Create AIModel record
    const existingModels = await prisma.aIModel.findMany({
      where: { agentId: job.agentId },
      orderBy: { version: 'desc' },
      take: 1,
    });
    const nextVersion = (existingModels[0]?.version ?? 0) + 1;

    const model = await prisma.aIModel.create({
      data: {
        agentId:            job.agentId,
        version:            nextVersion,
        baseModel:          (job.config as any)?.baseModel ?? 'Qwen2.5-0.5B-Instruct',
        loraAdapterPath:    result.modelRootHash,   // rootHash stored here
        trainingJobId:      jobId,
        performanceMetrics: result.metrics as any,
        isActive:           true,
      },
    });

    // Deactivate old models
    await prisma.aIModel.updateMany({
      where: { agentId: job.agentId, id: { not: model.id } },
      data:  { isActive: false },
    });

    // Index in storage_index
    await prisma.storageIndex.upsert({
      where:  { logicalPath: `agents/${job.agentId}/models/v${nextVersion}` },
      update: { rootHash: result.modelRootHash },
      create: {
        logicalPath: `agents/${job.agentId}/models/v${nextVersion}`,
        rootHash:    result.modelRootHash,
        mimeType:    'application/octet-stream',
        uploadedBy:  'training-worker',
        tags:        ['model', 'lora', job.agentId],
      },
    });

    // Publish event → inft-service will call updateModelRoot() on-chain
    const bus = await getEventBus();
    await bus.publish(SUBJECTS.TRAINING_COMPLETED, {
      jobId,
      agentId:       job.agentId,
      modelRootHash: result.modelRootHash,
      modelVersion:  nextVersion,
      occurredAt:    new Date(),
    });

    return { job, model, modelRootHash: result.modelRootHash };
  }

  async getJob(jobId: string) {
    return trainingRepo.findById(jobId);
  }

  async listJobs(agentId?: string, status?: string) {
    const where: Record<string, unknown> = {};
    if (agentId) where.agentId = agentId;
    if (status)  where.status  = status;

    const jobs = await prisma.trainingJob.findMany({
      where:   where as any,
      orderBy: { createdAt: 'desc' },
      take:    50,
    });
    return { jobs };
  }

  async cancelJob(jobId: string) {
    return trainingRepo.cancel(jobId);
  }

  /**
   * Download the training dataset from 0G Storage by rootHash.
   * Used by the training-worker when it picks up a job.
   */
  async getTrainingDataset(datasetRootHash: string): Promise<Array<Record<string, unknown>>> {
    const buf  = await storage.downloadToBuffer(datasetRootHash);
    const jsonl = buf.toString('utf8');
    return jsonl
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }

  async checkEligibility(agentId: string) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error('Agent not found');

    const runningJobs  = await prisma.trainingJob.count({ where: { agentId, status: 'RUNNING' } });
    const totalBattles = agent.wins + agent.losses + agent.draws;

    return {
      eligible: runningJobs === 0 && totalBattles >= 5,
      reasons: {
        hasRunningJobs:       runningJobs > 0,
        insufficientBattles:  totalBattles < 5,
        totalBattles,
        runningJobs,
      },
    };
  }
}
