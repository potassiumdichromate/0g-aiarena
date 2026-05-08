# Behaviour Cloning (BC) Module

Trains AI agent models to clone human gameplay behaviour from telemetry datasets using supervised learning + LoRA fine-tuning.

## What It Does

1. Loads processed telemetry sessions from 0G Storage (Parquet format)
2. Builds state-action pairs from the session data
3. Fine-tunes a base LLM (Phi-3-Mini or Mistral-7B) using LoRA adapters
4. Evaluates the trained model against held-out validation sessions
5. Saves the adapter checkpoint back to 0G Storage

## Files

| File | Purpose |
|------|---------|
| `train.py` | Main training loop with AMP, cosine LR schedule, best-checkpoint saving |
| `dataset.py` | PyTorch Dataset for telemetry parquet files, with synthetic augmentation |
| `model.py` | BCPolicyNetwork: transformer-based policy with multi-head self-attention |
| `evaluate.py` | Per-class precision/recall/F1, confusion matrix, and behaviour fidelity score |

## Usage

```bash
# Install dependencies
pip install -r requirements.txt

# Train a new agent model
python train.py \
  --agent-id <agent_uuid> \
  --game-id robowars \
  --base-model phi-3-mini-4k \
  --epochs 10 \
  --output-path /agents/<id>/weights/lora_v1

# Evaluate a checkpoint
python evaluate.py \
  --checkpoint /agents/<id>/weights/lora_v1 \
  --val-data /agents/<id>/telemetry/processed/
```

## Output

- `adapter_config.json` — LoRA configuration
- `adapter_model.safetensors` — trained LoRA weights
- `training_metrics.json` — loss curves, accuracy, fidelity score
