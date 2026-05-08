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
ZEROG_STORAGE_RPC=https://evmrpc-testnet.0g.ai
ZEROG_STORAGE_KEY=...
```
