# training-worker

Python Ray-based GPU training worker. Subscribes to `training.queued` NATS events and executes behaviour cloning, PPO, and LoRA fine-tuning jobs.

## Requirements

- CUDA 12.3+ compatible GPU
- Python 3.11+
- NATS server

## Setup

```bash
pip install -r requirements.txt
```

## Running

```bash
python -m src.main
```

## Environment Variables

```
NATS_URL=nats://localhost:4222
ZEROG_NETWORK=mainnet
ZEROG_STORAGE_PRIVATE_KEY=0x_your_private_key
ZEROG_FINETUNE_PROVIDER=0x_provider_address
ZEROG_FINETUNE_DEFAULT_MODEL=Qwen2.5-0.5B-Instruct
```
