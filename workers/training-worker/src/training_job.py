"""TrainingJob - executes a training run for an AI agent model."""
import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict

from config import TrainingConfig
from checkpoint_manager import CheckpointManager

logger = logging.getLogger(__name__)


class TrainingJob:
    def __init__(self, config: TrainingConfig):
        self.config = config
        self.checkpoint_manager = CheckpointManager(config.agent_id)

    async def execute(self) -> Dict[str, Any]:
        logger.info(f"Starting training job {self.config.job_id} for agent {self.config.agent_id}")
        start_time = time.time()

        try:
            if self.config.training_type == 'BEHAVIOUR_CLONING':
                metrics = await self._run_behaviour_cloning()
            elif self.config.training_type == 'REINFORCEMENT_LEARNING':
                metrics = await self._run_ppo()
            else:
                metrics = await self._run_lora_finetune()

            checkpoint_path = await self.checkpoint_manager.save(
                job_id=self.config.job_id,
                metrics=metrics,
            )

            elapsed = time.time() - start_time
            logger.info(f"Training completed in {elapsed:.1f}s. Metrics: {metrics}")

            return {
                'model_id': f"model-{self.config.agent_id}-{self.config.job_id}",
                'checkpoint_path': checkpoint_path,
                'metrics': metrics,
                'completed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            }

        except Exception as e:
            logger.error(f"Training job {self.config.job_id} failed: {e}")
            raise

    async def _run_behaviour_cloning(self) -> Dict[str, float]:
        from behaviour_cloning import run_bc_training
        return await run_bc_training(self.config)

    async def _run_ppo(self) -> Dict[str, float]:
        from rl_trainer import run_ppo_training
        return await run_ppo_training(self.config)

    async def _run_lora_finetune(self) -> Dict[str, float]:
        from lora_trainer import run_lora_training
        return await run_lora_training(self.config)
