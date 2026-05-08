# training-service

**Port: 8012**

Manages training job lifecycle with full **0G Storage mainnet** integration for datasets
and fine-tuned model weights.

## 0G Integration

### Dataset Upload (on job creation)
```
POST /training/jobs { agentId, trainingData: [...] }
  → serialise trainingData → JSONL format
  → 0G Storage: upload(JSONL) → datasetRootHash
  → storage_index: training/{agentId}/datasets/{timestamp}
  → TrainingJob.config.datasetRootHash = rootHash
  → NATS: TRAINING_QUEUED { jobId, datasetRootHash, baseModel }
  → training-worker downloads JSONL from 0G Storage and submits to 0G Compute CLI
```

### Model Delivery (on job completion)
```
POST /training/jobs/:id/complete { modelRootHash, metrics }
  → create AIModel { loraAdapterPath: modelRootHash, isActive: true }
  → deactivate all previous models for this agent
  → storage_index: agents/{agentId}/models/v{n}
  → NATS: TRAINING_COMPLETED { modelRootHash }
  → inft-service: updateModelRoot(tokenId, modelRootHash) on 0G Chain
```

## 0G Fine-Tuning Constraints

Only these base models are supported by 0G Compute fine-tuning:

| Model | Cost | Notes |
|-------|------|-------|
| `Qwen2.5-0.5B-Instruct` | 0.5 0G/M tokens | Lightweight, fast, recommended |
| `Qwen3-32B` | 4.0 0G/M tokens | High quality, larger |

Fine-tuning uses the **0G Compute CLI** — not a REST API:
```bash
0g-compute-cli fine-tuning create-task \
  --provider <ADDR> \
  --model Qwen2.5-0.5B-Instruct \
  --dataset-path dataset.jsonl \
  --config-path training_config.json
```

**Important:** The delivered model must be **acknowledged within 48 hours** or a 30% fee penalty applies.

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/training/jobs` | JWT | Create job — uploads dataset to 0G Storage |
| `GET` | `/training/jobs` | JWT | List jobs (filter: `agentId`, `status`) |
| `GET` | `/training/jobs/:id` | JWT | Job details including `datasetRootHash` and `modelRootHash` |
| `DELETE` | `/training/jobs/:id` | JWT | Cancel queued job |
| `POST` | `/training/jobs/:id/complete` | Service | Mark complete, store `modelRootHash` |
| `GET` | `/training/eligibility/:agentId` | JWT | Check eligibility (min 5 battles, no running jobs) |

## Request Body (create job)

```json
{
  "agentId": "uuid",
  "type": "LORA_FINETUNE",
  "baseModel": "Qwen2.5-0.5B-Instruct",
  "priority": 5,
  "trainingData": [
    { "prompt": "Battle state: {...}", "completion": "{ actionType: 'attack', ... }" }
  ]
}
```

## Response (create job)

```json
{
  "id": "job-uuid",
  "agentId": "...",
  "type": "LORA_FINETUNE",
  "status": "QUEUED",
  "datasetRootHash": "0xabc123...",
  "config": {
    "baseModel": "Qwen2.5-0.5B-Instruct",
    "datasetRootHash": "0xabc123...",
    "useZerogCompute": true
  }
}
```

## storage_index paths

```
training/{agentId}/datasets/{timestamp}  ← training JSONL dataset
agents/{agentId}/models/v{n}             ← fine-tuned LoRA weights
```

## NATS Events

| Subject | Payload | Direction |
|---------|---------|-----------|
| `training.queued` | `{ jobId, agentId, datasetRootHash, baseModel }` | Published |
| `training.completed` | `{ jobId, agentId, modelRootHash, modelVersion }` | Published |

## Environment Variables

```bash
ZEROG_NETWORK=mainnet
ZEROG_STORAGE_PRIVATE_KEY=0x...
ZEROG_FINETUNE_PROVIDER=0x...
ZEROG_FINETUNE_DEFAULT_MODEL=Qwen2.5-0.5B-Instruct
DATABASE_URL=...
NATS_URL=...
PORT=8012
```
