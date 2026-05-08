"""Checkpoint manager for saving/loading model checkpoints to 0G Storage."""
import json
import logging
import os
from typing import Any, Dict

logger = logging.getLogger(__name__)


class CheckpointManager:
    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        self.storage_url = os.environ.get('ZEROG_STORAGE_RPC', '')
        self.local_dir = f'/tmp/checkpoints/{agent_id}'

    async def save(self, job_id: str, metrics: Dict[str, Any]) -> str:
        """Save checkpoint to 0G Storage, return path."""
        os.makedirs(self.local_dir, exist_ok=True)

        checkpoint_path = f'checkpoints/{self.agent_id}/{job_id}'
        metadata_path = os.path.join(self.local_dir, f'{job_id}.json')

        with open(metadata_path, 'w') as f:
            json.dump({
                'agent_id': self.agent_id,
                'job_id': job_id,
                'metrics': metrics,
                'path': checkpoint_path,
            }, f)

        if self.storage_url:
            try:
                await self._upload_to_zerog(checkpoint_path, metadata_path)
            except Exception as e:
                logger.warning(f"Failed to upload to 0G Storage: {e}. Using local path.")

        logger.info(f"Checkpoint saved: {checkpoint_path}")
        return checkpoint_path

    async def load(self, checkpoint_path: str) -> Dict[str, Any]:
        """Load checkpoint from 0G Storage."""
        local_path = os.path.join('/tmp/checkpoints', checkpoint_path)

        if not os.path.exists(local_path):
            if self.storage_url:
                await self._download_from_zerog(checkpoint_path, local_path)

        with open(local_path, 'r') as f:
            return json.load(f)

    async def _upload_to_zerog(self, storage_path: str, local_path: str) -> None:
        import aiohttp
        storage_key = os.environ.get('ZEROG_STORAGE_KEY', '')
        async with aiohttp.ClientSession() as session:
            with open(local_path, 'rb') as f:
                data = aiohttp.FormData()
                data.add_field('file', f, filename=os.path.basename(local_path))
                data.add_field('path', storage_path)
                async with session.post(
                    f'{self.storage_url}/api/v1/upload',
                    data=data,
                    headers={'Authorization': f'Bearer {storage_key}'},
                ) as resp:
                    resp.raise_for_status()

    async def _download_from_zerog(self, storage_path: str, local_path: str) -> None:
        import aiohttp
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        storage_key = os.environ.get('ZEROG_STORAGE_KEY', '')
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f'{self.storage_url}/api/v1/download',
                params={'path': storage_path},
                headers={'Authorization': f'Bearer {storage_key}'},
            ) as resp:
                resp.raise_for_status()
                with open(local_path, 'wb') as f:
                    f.write(await resp.read())
