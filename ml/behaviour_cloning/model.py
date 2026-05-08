"""
Neural network model for behaviour cloning.
Implements a transformer-based policy network with optional PEFT LoRA adaptation.
"""
from __future__ import annotations

import math
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F

from dataset import NUM_ACTIONS, STATE_DIM


class MultiHeadSelfAttention(nn.Module):
    def __init__(self, d_model: int, n_heads: int, dropout: float = 0.1):
        super().__init__()
        assert d_model % n_heads == 0
        self.d_model = d_model
        self.n_heads = n_heads
        self.d_k = d_model // n_heads
        self.qkv = nn.Linear(d_model, 3 * d_model)
        self.out = nn.Linear(d_model, d_model)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        qkv = self.qkv(x).reshape(B, T, 3, self.n_heads, self.d_k).permute(2, 0, 3, 1, 4)
        q, k, v = qkv[0], qkv[1], qkv[2]
        scores = (q @ k.transpose(-2, -1)) / math.sqrt(self.d_k)
        attn = self.dropout(F.softmax(scores, dim=-1))
        out = (attn @ v).transpose(1, 2).reshape(B, T, C)
        return self.out(out)


class TransformerBlock(nn.Module):
    def __init__(self, d_model: int, n_heads: int, d_ff: int, dropout: float = 0.1):
        super().__init__()
        self.attn = MultiHeadSelfAttention(d_model, n_heads, dropout)
        self.ff = nn.Sequential(
            nn.Linear(d_model, d_ff),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(d_ff, d_model),
        )
        self.norm1 = nn.LayerNorm(d_model)
        self.norm2 = nn.LayerNorm(d_model)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.dropout(self.attn(self.norm1(x)))
        x = x + self.dropout(self.ff(self.norm2(x)))
        return x


class BCPolicyNetwork(nn.Module):
    """
    Behaviour cloning policy network.
    Input: flattened observation vector of shape (batch, STATE_DIM)
    Output: action logits of shape (batch, NUM_ACTIONS)
    """

    def __init__(
        self,
        state_dim: int = STATE_DIM,
        num_actions: int = NUM_ACTIONS,
        d_model: int = 128,
        n_layers: int = 4,
        n_heads: int = 4,
        d_ff: int = 512,
        dropout: float = 0.1,
    ):
        super().__init__()
        self.state_dim = state_dim
        self.num_actions = num_actions
        self.d_model = d_model

        # Project scalar features into token embedding space
        self.input_proj = nn.Linear(1, d_model)
        self.pos_embedding = nn.Embedding(state_dim, d_model)

        self.blocks = nn.ModuleList([
            TransformerBlock(d_model, n_heads, d_ff, dropout)
            for _ in range(n_layers)
        ])

        self.norm = nn.LayerNorm(d_model)
        self.head = nn.Sequential(
            nn.Linear(d_model, d_model // 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(d_model // 2, num_actions),
        )

        self._init_weights()

    def _init_weights(self):
        for module in self.modules():
            if isinstance(module, nn.Linear):
                nn.init.xavier_uniform_(module.weight)
                if module.bias is not None:
                    nn.init.zeros_(module.bias)
            elif isinstance(module, nn.Embedding):
                nn.init.normal_(module.weight, std=0.02)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: (batch, state_dim) float32"""
        B, D = x.shape
        # Treat each feature as a token
        tokens = x.unsqueeze(-1)  # (B, D, 1)
        tokens = self.input_proj(tokens)  # (B, D, d_model)
        pos = torch.arange(D, device=x.device)
        tokens = tokens + self.pos_embedding(pos).unsqueeze(0)

        for block in self.blocks:
            tokens = block(tokens)

        tokens = self.norm(tokens)
        # Pool over token dimension
        pooled = tokens.mean(dim=1)  # (B, d_model)
        return self.head(pooled)  # (B, num_actions)

    def predict(self, x: torch.Tensor, temperature: float = 1.0) -> torch.Tensor:
        """Returns action indices (greedy or sampled)."""
        with torch.no_grad():
            logits = self.forward(x)
            if temperature == 0:
                return logits.argmax(dim=-1)
            probs = F.softmax(logits / temperature, dim=-1)
            return torch.multinomial(probs, num_samples=1).squeeze(-1)

    @classmethod
    def load(cls, path: str, device: Optional[str] = None) -> "BCPolicyNetwork":
        device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        checkpoint = torch.load(path, map_location=device)
        model = cls(**checkpoint.get("config", {}))
        model.load_state_dict(checkpoint["state_dict"])
        model.to(device)
        model.eval()
        return model

    def save(self, path: str):
        config = dict(
            state_dim=self.state_dim,
            num_actions=self.num_actions,
            d_model=self.d_model,
        )
        torch.save({"config": config, "state_dict": self.state_dict()}, path)
        print(f"[BCPolicyNetwork] Saved to {path}")
