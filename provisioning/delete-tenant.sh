#!/bin/bash
# delete-tenant.sh — Remove a tenant and its OpenClaw Gateway
# Usage: ./delete-tenant.sh <tenant_id>

set -euo pipefail

TENANT_ID="${1:?Usage: $0 <tenant_id>}"

BASE_DIR="$HOME/tasuku-tenants"
TENANT_DIR="$BASE_DIR/$TENANT_ID"
SERVICE_NAME="openclaw-${TENANT_ID}"

if [ ! -d "$TENANT_DIR" ]; then
  echo "❌ Tenant not found: $TENANT_DIR"
  exit 1
fi

echo "🗑️  Deleting tenant: $TENANT_ID"

# Stop and disable service
systemctl --user stop "${SERVICE_NAME}" 2>/dev/null || true
systemctl --user disable "${SERVICE_NAME}" 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/${SERVICE_NAME}.service"
systemctl --user daemon-reload

# Remove tenant directory
rm -rf "$TENANT_DIR"

echo "✅ Tenant deleted: $TENANT_ID"
