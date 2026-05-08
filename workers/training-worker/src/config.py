"""Training configuration dataclasses."""
import os
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class TrainingConfig:
    agent_id: str
    job_id: str
    model_base: str = 'meta-llama/Llama-2-7b-chat-hf'
    training_type: str = 'BEHAVIOUR_CLONING'
    max_steps: int = 1000
    batch_size: int = 4
    learning_rate: float = 2e-4
    lora_r: int = 16
    lora_alpha: int = 32
    lora_dropout: float = 0.1
    gradient_accumulation_steps: int = 4
    warmup_ratio: float = 0.1
    output_dir: str = '/tmp/training_output'
    zerog_storage_url: str = field(default_factory=lambda: os.environ.get('ZEROG_STORAGE_RPC', ''))
    use_gpu: bool = True
    fp16: bool = True


@dataclass
class EmbeddingConfig:
    model_name: str = 'BAAI/bge-m3'
    batch_size: int = 32
    max_length: int = 512
    device: str = 'cuda'
    qdrant_url: str = field(default_factory=lambda: os.environ.get('QDRANT_URL', 'http://localhost:6333'))
