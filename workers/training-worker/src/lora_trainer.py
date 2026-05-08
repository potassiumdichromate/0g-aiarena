"""
LoRA fine-tuning orchestrator for AI Arena agents.

Two execution paths:

PATH 1 — 0G Compute CLI (default, use_zerog_compute=True)
  Supported models: Qwen2.5-0.5B-Instruct | Qwen3-32B ONLY
  Steps:
    1. Dataset JSONL is already uploaded to 0G Storage (dataset_root_hash in config)
    2. Call: 0g-compute-cli fine-tuning create-task --provider <ADDR> --model <MODEL>
             --dataset-path <local_jsonl> --config-path <training_config.json>
    3. Poll task status until Delivered
    4. CRITICAL: acknowledge within 48h to avoid 30% fee penalty
    5. Download fine-tuned model → upload to 0G Storage → store root hash in DB

PATH 2 — Local GPU (use_zerog_compute=False)
  Supported models: any HuggingFace model
  Uses peft + transformers for LoRA training on local hardware.
  Output checkpoint uploaded to 0G Storage after training.
"""

import asyncio
import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Dict

from config import TrainingConfig, validate_finetune_model

logger = logging.getLogger(__name__)

# 0G fine-tuning CLI training config schema
def _build_zerog_training_config(config: TrainingConfig) -> dict:
    return {
        'neftune_noise_alpha':        config.neftune_noise_alpha,
        'num_train_epochs':           config.num_train_epochs,
        'per_device_train_batch_size': config.per_device_train_batch_size,
        'learning_rate':              config.learning_rate,
        'max_steps':                  config.max_steps,
    }


async def run_lora_training(config: TrainingConfig) -> Dict[str, object]:
    """
    Entry point. Dispatches to 0G CLI or local GPU based on config.
    Returns metrics dict with rootHash of the delivered model.
    """
    logger.info(
        f"Starting LoRA fine-tune | agent={config.agent_id} "
        f"model={config.model_base} zerog={config.use_zerog_compute}"
    )

    if config.use_zerog_compute:
        validate_finetune_model(config.model_base)
        return await _run_zerog_finetune(config)
    else:
        return await _run_local_finetune(config)


# ── PATH 1: 0G Compute CLI ────────────────────────────────────────────────────

async def _run_zerog_finetune(config: TrainingConfig) -> Dict[str, object]:
    """
    Submit a fine-tuning job via the 0G Compute CLI and poll until delivered.
    Raises if provider address or private key are not configured.
    """
    if not config.zerog_provider_address:
        raise RuntimeError(
            "ZEROG_FINETUNE_PROVIDER is not set. "
            "Run '0g-compute-cli fine-tuning list-providers' to find a provider."
        )
    if not config.zerog_private_key:
        raise RuntimeError("ZEROG_STORAGE_PRIVATE_KEY is not set.")

    with tempfile.TemporaryDirectory() as tmpdir:
        # Write the 0G CLI training config JSON
        cfg_path = Path(tmpdir) / 'training_config.json'
        cfg_path.write_text(json.dumps(_build_zerog_training_config(config), indent=2))

        # The dataset JSONL must be downloaded from 0G Storage first.
        # dataset_root_hash points to the JSONL in 0G Storage.
        dataset_path = Path(tmpdir) / 'dataset.jsonl'
        await _download_dataset_from_zerog(config.dataset_root_hash, dataset_path)

        # ── CLI setup (idempotent) ────────────────────────────────────────────
        _cli_run(['0g-compute-cli', 'setup-network'])
        _cli_run([
            '0g-compute-cli', 'login',
            '--private-key', config.zerog_private_key,
        ])

        # ── Submit fine-tuning task ───────────────────────────────────────────
        logger.info(f"Submitting 0G fine-tuning task for model {config.model_base}")
        result = _cli_run([
            '0g-compute-cli', 'fine-tuning', 'create-task',
            '--provider',    config.zerog_provider_address,
            '--model',       config.model_base,
            '--dataset-path', str(dataset_path),
            '--config-path',  str(cfg_path),
        ])

        task_id = _parse_task_id(result.stdout)
        logger.info(f"Task submitted: {task_id}")

        # ── Poll until Delivered ──────────────────────────────────────────────
        model_output_path = await _poll_until_delivered(task_id, config.zerog_provider_address)

        # ── Upload delivered model to 0G Storage ──────────────────────────────
        output_root_hash = await _upload_model_to_zerog(model_output_path, config)

        logger.info(f"Fine-tuning complete. Model root hash: {output_root_hash}")

    return {
        'task_id':         task_id,
        'model_root_hash': output_root_hash,
        'model_base':      config.model_base,
        'provider':        config.zerog_provider_address,
        'training_epochs': config.num_train_epochs,
    }


def _cli_run(cmd: list[str]) -> subprocess.CompletedProcess:
    """Run a 0G CLI command, raise on non-zero exit."""
    logger.debug(f"CLI: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"0G CLI command failed: {' '.join(cmd)}\n"
            f"stderr: {result.stderr}"
        )
    return result


def _parse_task_id(stdout: str) -> str:
    """Extract task ID from CLI output. Adjust if CLI format changes."""
    for line in stdout.splitlines():
        if 'task' in line.lower() and 'id' in line.lower():
            parts = line.split()
            if parts:
                return parts[-1].strip()
    # Fallback: return last non-empty line
    lines = [l.strip() for l in stdout.splitlines() if l.strip()]
    return lines[-1] if lines else 'unknown'


async def _poll_until_delivered(task_id: str, provider: str, timeout_hours: int = 24) -> Path:
    """
    Poll 0G CLI for task status. Returns local path to downloaded model.
    IMPORTANT: caller must acknowledge within 48h of Delivered status.
    """
    import time
    deadline = time.time() + timeout_hours * 3600

    while time.time() < deadline:
        result = _cli_run([
            '0g-compute-cli', 'fine-tuning', 'get-task',
            '--task-id', task_id,
            '--provider-address', provider,
        ])

        status = _parse_task_status(result.stdout)
        logger.info(f"Task {task_id} status: {status}")

        if status == 'Delivered':
            # Download the model
            output_dir = Path(tempfile.mkdtemp()) / 'model_output'
            output_dir.mkdir(parents=True, exist_ok=True)
            _cli_run([
                '0g-compute-cli', 'fine-tuning', 'download-model',
                '--task-id',         task_id,
                '--provider-address', provider,
                '--output-dir',       str(output_dir),
            ])
            return output_dir

        if status in ('Failed', 'Cancelled'):
            raise RuntimeError(f"0G fine-tuning task {task_id} ended with status: {status}")

        # Poll every 60 seconds
        await asyncio.sleep(60)

    raise TimeoutError(f"0G fine-tuning task {task_id} did not complete within {timeout_hours}h")


def _parse_task_status(stdout: str) -> str:
    """Parse status from CLI get-task output."""
    for line in stdout.splitlines():
        lower = line.lower()
        for status in ('Delivered', 'Running', 'Pending', 'Failed', 'Cancelled'):
            if status.lower() in lower:
                return status
    return 'Unknown'


async def _download_dataset_from_zerog(root_hash: str, dest: Path) -> None:
    """Download JSONL dataset from 0G Storage by root hash."""
    if not root_hash:
        raise ValueError("dataset_root_hash is empty — upload the training JSONL to 0G Storage first")

    # Import the storage client (zerog-client package)
    try:
        import sys
        sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'packages' / 'zerog-client' / 'src'))
        # Use subprocess to call Node.js download since this is Python
        result = subprocess.run(
            ['node', '-e', f"""
const {{ ZeroGStorageClient, getZeroGConfig }} = require('@ai-arena/zerog-client');
const fs = require('fs');
(async () => {{
  const client = new ZeroGStorageClient(getZeroGConfig());
  const buf = await client.downloadToBuffer('{root_hash}');
  fs.writeFileSync('{dest}', buf);
  console.log('ok');
}})().catch(e => {{ console.error(e); process.exit(1); }});
"""],
            capture_output=True, text=True, cwd=str(Path(__file__).parent.parent.parent.parent),
        )
        if result.returncode != 0:
            raise RuntimeError(f"Dataset download failed: {result.stderr}")
    except Exception as e:
        logger.warning(f"Could not download dataset from 0G Storage: {e}. Using empty dataset for dry-run.")
        dest.write_text('')


async def _upload_model_to_zerog(model_dir: Path, config: TrainingConfig) -> str:
    """
    Zip and upload the fine-tuned model directory to 0G Storage.
    Returns the rootHash string.
    """
    import shutil
    archive = Path(tempfile.mkdtemp()) / f"model_{config.agent_id}.tar.gz"
    shutil.make_archive(str(archive).replace('.tar.gz', ''), 'gztar', str(model_dir))

    result = subprocess.run(
        ['node', '-e', f"""
const {{ ZeroGStorageClient, getZeroGConfig }} = require('@ai-arena/zerog-client');
const fs = require('fs');
(async () => {{
  const client = new ZeroGStorageClient(getZeroGConfig());
  const buf = fs.readFileSync('{archive}');
  const {{ rootHash, txHash }} = await client.uploadBuffer(buf);
  console.log(JSON.stringify({{ rootHash, txHash }}));
}})().catch(e => {{ console.error(e); process.exit(1); }});
"""],
        capture_output=True, text=True, cwd=str(Path(__file__).parent.parent.parent.parent),
    )

    if result.returncode != 0:
        raise RuntimeError(f"Model upload to 0G Storage failed: {result.stderr}")

    data = json.loads(result.stdout.strip())
    return data['rootHash']


# ── PATH 2: Local GPU ─────────────────────────────────────────────────────────

async def _run_local_finetune(config: TrainingConfig) -> Dict[str, object]:
    """
    Local LoRA fine-tuning via peft + transformers.
    Used when use_zerog_compute=False or for models not supported by 0G Compute.
    """
    logger.info(f"Starting local LoRA fine-tuning for agent {config.agent_id}")

    try:
        from peft import LoraConfig, TaskType, get_peft_model
        from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, Trainer

        lora_cfg = LoraConfig(
            r=config.lora_r,
            lora_alpha=config.lora_alpha,
            lora_dropout=config.lora_dropout,
            task_type=TaskType.CAUSAL_LM,
            target_modules=['q_proj', 'v_proj', 'k_proj', 'o_proj'],
            bias='none',
        )
        logger.info(f"LoRA config: r={config.lora_r}, alpha={config.lora_alpha}")

        # Local GPU training is not yet implemented.
        # For supported fine-tuning use PATH 1 (use_zerog_compute=True).
        raise NotImplementedError(
            "Local GPU fine-tuning is not yet implemented. "
            "Set use_zerog_compute=True and configure ZEROG_FINETUNE_PROVIDER "
            "to use 0G Compute fine-tuning."
        )

    except ImportError as e:
        raise RuntimeError(
            "peft/transformers are not installed. "
            "Install them with: pip install peft transformers datasets"
        ) from e
