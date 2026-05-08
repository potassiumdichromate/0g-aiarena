"""Training configuration dataclasses.

0G Compute fine-tuning constraints (verified 2025-05-08 via pc.0g.ai):
  Supported base models ONLY (not arbitrary models):
    - Qwen2.5-0.5B-Instruct  (0.5 0G/M tokens, lightweight, fast)
    - Qwen3-32B               (4.0 0G/M tokens, high quality)

  Fine-tuning uses the 0G Compute CLI — NOT a REST API:
    pnpm install @0gfoundation/0g-compute-ts-sdk -g
    0g-compute-cli fine-tuning create-task --provider <ADDR> --model <MODEL> ...

  Inference (during battle) uses the Router API (OpenAI-compatible):
    Base URL: https://router-api.0g.ai/v1
    Available chat models:
      - zai-org/GLM-5.1-FP8
      - zai-org/GLM-5-FP8
      - deepseek/deepseek-chat-v3-0324
      - qwen/qwen3-vl-30b-a3b-instruct
      - qwen3.6-plus
"""
import os
from dataclasses import dataclass, field
from typing import Literal, Optional

# Only these two models are supported for 0G-hosted fine-tuning
ZEROG_SUPPORTED_FINETUNE_MODELS = (
    'Qwen2.5-0.5B-Instruct',
    'Qwen3-32B',
)

ZeroGFineTuneModel = Literal['Qwen2.5-0.5B-Instruct', 'Qwen3-32B']


@dataclass
class TrainingConfig:
    agent_id:   str
    job_id:     str

    # 0G fine-tuning only supports these two models.
    # For local GPU training, any HuggingFace model works.
    model_base: ZeroGFineTuneModel = 'Qwen2.5-0.5B-Instruct'

    training_type: str = 'LORA_FINETUNE'   # BEHAVIOUR_CLONING | LORA_FINETUNE
    use_zerog_compute: bool = True          # False = local GPU fallback

    # Training hyperparameters (passed to 0G CLI or local trainer)
    num_train_epochs: int = 3
    per_device_train_batch_size: int = 2
    learning_rate: float = 0.0002
    max_steps: int = -1                     # -1 = run all epochs
    neftune_noise_alpha: int = 5            # 0G CLI config field

    # LoRA hyperparameters (local training only — 0G CLI manages its own)
    lora_r: int = 16
    lora_alpha: int = 32
    lora_dropout: float = 0.1

    output_dir: str = '/tmp/training_output'

    # 0G Storage — root hashes (NOT file paths)
    dataset_root_hash: str = ''     # 0G Storage root hash of training JSONL
    output_root_hash:  str = ''     # Set after 0G delivers the fine-tuned model

    # 0G Compute fine-tuning CLI config
    zerog_provider_address: str = field(
        default_factory=lambda: os.environ.get('ZEROG_FINETUNE_PROVIDER', '')
    )
    zerog_evm_rpc: str = field(
        default_factory=lambda: (
            'https://evmrpc.0g.ai'
            if os.environ.get('ZEROG_NETWORK') == 'mainnet'
            else 'https://evmrpc-testnet.0g.ai'
        )
    )
    zerog_private_key: str = field(
        default_factory=lambda: os.environ.get('ZEROG_STORAGE_PRIVATE_KEY', '')
    )

    # Local GPU fallback config (used when use_zerog_compute=False)
    use_gpu: bool = True
    fp16: bool = True
    gradient_accumulation_steps: int = 4
    warmup_ratio: float = 0.1


@dataclass
class EmbeddingConfig:
    model_name: str = 'BAAI/bge-m3'
    batch_size: int = 32
    max_length: int = 512
    device: str = 'cuda'
    qdrant_url: str = field(
        default_factory=lambda: os.environ.get('QDRANT_URL', 'http://localhost:6333')
    )


def validate_finetune_model(model: str) -> ZeroGFineTuneModel:
    """Raise if the model isn't supported by 0G Compute fine-tuning."""
    if model not in ZEROG_SUPPORTED_FINETUNE_MODELS:
        raise ValueError(
            f"Model '{model}' is not supported for 0G Compute fine-tuning. "
            f"Supported: {ZEROG_SUPPORTED_FINETUNE_MODELS}. "
            "For other models, use local GPU training (use_zerog_compute=False)."
        )
    return model  # type: ignore[return-value]
