"""
Batch embedding generation for bulk memory/episode ingestion.
Reads from a JSONL file, generates embeddings, and upserts to Qdrant.
"""
from __future__ import annotations

import argparse
import json
import os
import uuid
from typing import Dict, Iterator, List

import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.http.models import PointStruct, VectorParams, Distance

from generate import BGEEmbedder, EMBED_DIM

QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")


def iter_jsonl(path: str) -> Iterator[Dict]:
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def batch_upsert(
    client: QdrantClient,
    collection: str,
    points: List[PointStruct],
    batch_size: int = 100,
) -> None:
    for i in range(0, len(points), batch_size):
        chunk = points[i: i + batch_size]
        client.upsert(collection_name=collection, points=chunk)
        print(f"  Upserted {i + len(chunk)}/{len(points)} points")


def ensure_collection(client: QdrantClient, collection: str, dim: int = EMBED_DIM) -> None:
    existing = {c.name for c in client.get_collections().collections}
    if collection not in existing:
        client.create_collection(
            collection_name=collection,
            vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
        )
        print(f"[batch_embed] Created collection '{collection}'")


def run_batch_embed(
    input_path: str,
    collection: str,
    record_type: str = "memory",  # memory | episode | profile
    device: str = "cpu",
    qdrant_url: str = QDRANT_URL,
) -> int:
    embedder = BGEEmbedder.get_instance(device=device)
    client = QdrantClient(url=qdrant_url)
    ensure_collection(client, collection)

    records = list(iter_jsonl(input_path))
    print(f"[batch_embed] Processing {len(records)} records from {input_path}")

    points: List[PointStruct] = []
    texts: List[str] = []
    payloads: List[Dict] = []

    for rec in records:
        if record_type == "memory":
            text = embedder._memory_to_text(rec)
        elif record_type == "episode":
            text = embedder._episode_to_text(rec)
        else:
            text = embedder._profile_to_text(rec)
        texts.append(text)
        payloads.append(rec)

    print(f"[batch_embed] Generating embeddings in batches...")
    embeddings = embedder.embed(texts, batch_size=32)

    for i, (emb, payload) in enumerate(zip(embeddings, payloads)):
        point_id = payload.get("id", str(uuid.uuid4()))
        # Qdrant requires integer or UUID strings
        try:
            point_id = int(point_id)
        except (ValueError, TypeError):
            point_id = str(uuid.UUID(point_id) if len(str(point_id)) == 36 else uuid.uuid4())

        points.append(PointStruct(
            id=point_id,
            vector=emb.tolist(),
            payload=payload,
        ))

    batch_upsert(client, collection, points)
    print(f"[batch_embed] Done. Upserted {len(points)} points to '{collection}'")
    return len(points)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=str, required=True, help="Path to JSONL input file")
    parser.add_argument("--collection", type=str, required=True, help="Qdrant collection name")
    parser.add_argument("--type", choices=["memory", "episode", "profile"], default="memory")
    parser.add_argument("--device", type=str, default="cpu")
    parser.add_argument("--qdrant-url", type=str, default=QDRANT_URL)
    args = parser.parse_args()

    n = run_batch_embed(
        input_path=args.input,
        collection=args.collection,
        record_type=args.type,
        device=args.device,
        qdrant_url=args.qdrant_url,
    )
    print(f"Inserted {n} embeddings.")
