#!/bin/sh
set -e

NATS_USER="${NATS_USER:-arena}"
NATS_PASSWORD="${NATS_PASSWORD:-changeme}"

mkdir -p /data/jetstream

cat > /etc/nats.conf << EOF
# AI Arena NATS Server

port: 4222

# JetStream — persistent messaging for battle events
jetstream {
  store_dir: /data/jetstream
  max_mem: 128MB
  max_file: 1GB
}

# Simple username/password auth
authorization {
  user: "$NATS_USER"
  password: "$NATS_PASSWORD"
}

# Logging
logtime: true
EOF

echo "[NATS] Starting with user=$NATS_USER on port 4222 with JetStream enabled"
exec nats-server -c /etc/nats.conf
