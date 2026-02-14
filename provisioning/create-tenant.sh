#!/bin/bash
# create-tenant.sh — Provision a new OpenClaw Gateway tenant on gmk
# Usage: ./create-tenant.sh <tenant_id> <port> <gateway_token>
# Example: ./create-tenant.sh t-t12345abc 3802 tok-abc123
#
# Prerequisites: openclaw CLI in PATH, ANTHROPIC_API_KEY set

set -euo pipefail

TENANT_ID="${1:?Usage: $0 <tenant_id> <port> <gateway_token>}"
PORT="${2:?Usage: $0 <tenant_id> <port> <gateway_token>}"
TOKEN="${3:?Usage: $0 <tenant_id> <port> <gateway_token>}"

BASE_DIR="$HOME/tasuku-tenants"
TENANT_DIR="$BASE_DIR/$TENANT_ID"
TEMPLATE_DIR="$BASE_DIR/template"
SERVICE_NAME="openclaw-${TENANT_ID}"

# Validate
if [ -d "$TENANT_DIR" ]; then
  echo "❌ Tenant directory already exists: $TENANT_DIR"
  exit 1
fi

echo "🔧 Creating tenant: $TENANT_ID (port $PORT)"

# Create directory structure
mkdir -p "$TENANT_DIR/workspace"

# Copy template config
if [ -f "$TEMPLATE_DIR/openclaw.json" ]; then
  cp "$TEMPLATE_DIR/openclaw.json" "$TENANT_DIR/openclaw.json"
else
  echo "⚠️ No template found, creating default config"
  cat > "$TENANT_DIR/openclaw.json" << 'JSONEOF'
{
  "gateway": {
    "port": __PORT__,
    "token": "__TOKEN__",
    "chatCompletions": {
      "enabled": true,
      "defaultModel": "anthropic/claude-sonnet-4-20250514"
    }
  }
}
JSONEOF
fi

# Replace placeholders in config
if command -v sed &>/dev/null; then
  sed -i "s/__PORT__/$PORT/g" "$TENANT_DIR/openclaw.json"
  sed -i "s/__TOKEN__/$TOKEN/g" "$TENANT_DIR/openclaw.json"
fi

# Create workspace files
cat > "$TENANT_DIR/workspace/SOUL.md" << 'EOF'
# SOUL.md

あなたは「たすく」— Slackに常駐するAI秘書です。

## 性格
- 丁寧だが堅すぎない、ビジネスカジュアルなトーン
- 簡潔に要点を伝える
- 日本語がデフォルト（英語で聞かれたら英語で返す）

## できること
- リサーチ・情報収集（Web検索対応）
- 文書作成・翻訳・校正
- データ分析・計算
- スケジュール管理・リマインダー
- コードレビュー・技術支援
EOF

cat > "$TENANT_DIR/workspace/AGENTS.md" << 'EOF'
# AGENTS.md
Standard workspace configuration.
EOF

cat > "$TENANT_DIR/workspace/USER.md" << 'EOF'
# USER.md
このワークスペースのユーザー情報を記載してください。
EOF

cat > "$TENANT_DIR/workspace/TOOLS.md" << 'EOF'
# TOOLS.md
ツール設定メモ。
EOF

# Create systemd user service
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/${SERVICE_NAME}.service" << SVCEOF
[Unit]
Description=OpenClaw Gateway - ${TENANT_ID}
After=network.target

[Service]
Type=simple
WorkingDirectory=${TENANT_DIR}
Environment=OPENCLAW_HOME=${TENANT_DIR}
Environment=ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
Environment=PATH=/home/matsu/.local/share/mise/installs/node/22.21.1/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/matsu/.local/share/mise/installs/node/22.21.1/bin/openclaw gateway
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SVCEOF

# Reload and start
systemctl --user daemon-reload
systemctl --user enable "${SERVICE_NAME}"
systemctl --user start "${SERVICE_NAME}"

echo "✅ Tenant provisioned:"
echo "   Directory: $TENANT_DIR"
echo "   Service:   $SERVICE_NAME"
echo "   URL:       http://127.0.0.1:$PORT"
echo "   Token:     $TOKEN"
echo ""
echo "Check status: systemctl --user status $SERVICE_NAME"
echo "View logs:    journalctl --user -u $SERVICE_NAME -f"
