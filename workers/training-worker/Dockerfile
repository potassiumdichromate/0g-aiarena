# Training worker — CPU only.
#
# Was `nvidia/cuda:12.3.0-runtime-ubuntu22.04` with the full torch/transformers/
# peft/trl/ray stack (~4GB image, GPU host required). Trait training runs a
# 32-feature, 7-action environment; the CPU wheels handle it in minutes and the
# image drops to a few hundred MB, which is what makes this deployable on an
# ordinary dyno instead of a GPU box.
#
# Build from the REPO ROOT — the worker imports ml/trait_training, which in turn
# imports ml/reinforcement_learning and ml/behaviour_cloning:
#
#   docker build -f workers/training-worker/Dockerfile -t kult-training-worker .

FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq5 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch wheels: ~200MB rather than the ~2.5GB CUDA build.
RUN pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      torch==2.5.1 \
 && pip install --no-cache-dir \
      numpy==1.26.4 \
      gymnasium==0.29.1 \
      "psycopg[binary]==3.2.3" \
      nats-py==2.6.0

COPY ml/reinforcement_learning/ ./ml/reinforcement_learning/
COPY ml/behaviour_cloning/ ./ml/behaviour_cloning/
COPY ml/trait_training/ ./ml/trait_training/
COPY workers/training-worker/src/ ./src/

# `ml` is on the path so `import trait_training...` resolves; trait_training's
# own __init__ then adds its two sibling ml packages, which use flat imports.
ENV PYTHONPATH=/app/src:/app/ml
ENV PYTHONUNBUFFERED=1
# Threading is NOT pinned here. Evaluation pins itself to one thread via
# trait_training.evaluate.deterministic_inference(), which is where determinism
# actually matters; throttling training too made it ~8x slower on a 16-core host.

CMD ["python", "src/main.py"]
