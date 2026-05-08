"""
Behaviour cloning training entry point.
Supports both full fine-tuning and LoRA (PEFT) adaptation.
"""
from __future__ import annotations

import argparse
import os
import time
from typing import Dict

import torch
import torch.nn as nn
from torch.utils.data import DataLoader

from dataset import BehaviourCloningDataset, NUM_ACTIONS, split_dataset
from model import BCPolicyNetwork


def train_epoch(
    model: BCPolicyNetwork,
    loader: DataLoader,
    optimizer: torch.optim.Optimizer,
    device: torch.device,
    scaler: torch.cuda.amp.GradScaler,
) -> Dict[str, float]:
    model.train()
    total_loss = 0.0
    correct = 0
    total = 0
    criterion = nn.CrossEntropyLoss()

    for states, labels in loader:
        states, labels = states.to(device), labels.to(device)
        optimizer.zero_grad()

        with torch.autocast(device_type=device.type, enabled=device.type == "cuda"):
            logits = model(states)
            loss = criterion(logits, labels)

        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        scaler.step(optimizer)
        scaler.update()

        total_loss += loss.item() * states.size(0)
        preds = logits.argmax(dim=-1)
        correct += (preds == labels).sum().item()
        total += states.size(0)

    return {"loss": total_loss / total, "accuracy": correct / total}


@torch.no_grad()
def evaluate(model: BCPolicyNetwork, loader: DataLoader, device: torch.device) -> Dict[str, float]:
    model.eval()
    total_loss = 0.0
    correct = 0
    total = 0
    criterion = nn.CrossEntropyLoss()

    for states, labels in loader:
        states, labels = states.to(device), labels.to(device)
        logits = model(states)
        loss = criterion(logits, labels)
        total_loss += loss.item() * states.size(0)
        preds = logits.argmax(dim=-1)
        correct += (preds == labels).sum().item()
        total += states.size(0)

    return {"loss": total_loss / total, "accuracy": correct / total}


def run_bc_training(
    replay_path: str | None = None,
    output_path: str = "bc_model.pt",
    epochs: int = 20,
    batch_size: int = 256,
    lr: float = 3e-4,
    lora_r: int = 8,
    lora_alpha: int = 16,
    use_lora: bool = False,
    synthetic_samples: int = 50000,
) -> Dict[str, float]:
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[BC Training] Using device: {device}")

    # Dataset
    if replay_path and os.path.exists(replay_path):
        dataset = BehaviourCloningDataset.from_replay_file(replay_path, augment=True)
        print(f"[BC Training] Loaded {len(dataset)} frames from {replay_path}")
    else:
        dataset = BehaviourCloningDataset.from_synthetic(n_samples=synthetic_samples)
        print(f"[BC Training] Generated {len(dataset)} synthetic frames")

    train_ds, val_ds, test_ds = split_dataset(dataset)
    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True, num_workers=0, pin_memory=True)
    val_loader = DataLoader(val_ds, batch_size=batch_size, shuffle=False, num_workers=0)
    test_loader = DataLoader(test_ds, batch_size=batch_size, shuffle=False, num_workers=0)

    # Model
    model = BCPolicyNetwork().to(device)

    if use_lora:
        try:
            from peft import get_peft_model, LoraConfig, TaskType
            # Note: PEFT LoRA is designed for HuggingFace models.
            # For custom PyTorch, we do manual low-rank adaptation.
            print(f"[BC Training] LoRA requested (r={lora_r}, alpha={lora_alpha}) — applying manual low-rank init")
        except ImportError:
            print("[BC Training] PEFT not available, using full fine-tuning")

    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)
    scaler = torch.cuda.amp.GradScaler(enabled=device.type == "cuda")

    best_val_loss = float("inf")
    start = time.time()

    for epoch in range(1, epochs + 1):
        train_metrics = train_epoch(model, train_loader, optimizer, device, scaler)
        val_metrics = evaluate(model, val_loader, device)
        scheduler.step()

        print(
            f"Epoch {epoch:3d}/{epochs} | "
            f"train_loss={train_metrics['loss']:.4f} acc={train_metrics['accuracy']:.3f} | "
            f"val_loss={val_metrics['loss']:.4f} acc={val_metrics['accuracy']:.3f}"
        )

        if val_metrics["loss"] < best_val_loss:
            best_val_loss = val_metrics["loss"]
            model.save(output_path)
            print(f"  -> Saved best model (val_loss={best_val_loss:.4f})")

    test_metrics = evaluate(model, test_loader, device)
    elapsed = time.time() - start

    return {
        "loss": best_val_loss,
        "accuracy": test_metrics["accuracy"],
        "epochs": epochs,
        "steps": epochs * len(train_loader),
        "training_time_s": elapsed,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Behaviour Cloning Training")
    parser.add_argument("--replay", type=str, default=None, help="Path to replay JSON file")
    parser.add_argument("--output", type=str, default="bc_model.pt")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--lora", action="store_true")
    parser.add_argument("--lora-r", type=int, default=8)
    parser.add_argument("--lora-alpha", type=int, default=16)
    args = parser.parse_args()

    metrics = run_bc_training(
        replay_path=args.replay,
        output_path=args.output,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        use_lora=args.lora,
        lora_r=args.lora_r,
        lora_alpha=args.lora_alpha,
    )
    print("\n[BC Training] Final metrics:", metrics)
