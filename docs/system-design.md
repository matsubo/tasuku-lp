# たすく（Tasuku）システム設計書 v1.0

## 1. サービス概要

| 項目 | 内容 |
|------|------|
| サービス名 | AI秘書「たすく」 |
| 提供形態 | Slack Bot（Socket Mode） |
| ドメイン | task.teraren.com（LP）|
| 運営 | 合同会社テラレン |
| ホスト | gmk（自宅サーバー） |
| 基盤 | OpenClaw Gateway（API wrapper、ソース改変なし） |

## 2. アーキテクチャ

### 2.1 全体構成

```
┌─────────────────────────────────────────────────────┐
│  Slack (顧客ワークスペース)                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Tenant A │  │ Tenant B │  │ Tenant C │           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘           │
└───────┼──────────────┼──────────────┼────────────────┘
        │ Socket Mode  │             │
        ▼              ▼             ▼
┌─────────────────────────────────────────────────────┐
│  gmk サーバー (Ubuntu, 8 core, 32GB RAM)            │
│                                                     │
│  ┌─────────────────────────────────┐                │
│  │  Slack Bot (Docker container)   │ ← 全テナント共有│
│  │  Node.js + @slack/bolt          │                │
│  │  Socket Mode (1 Slack App)      │                │
│  └──────────┬──────────────────────┘                │
│             │ HTTP POST /v1/chat/completions         │
│             ▼                                        │
│  ┌──────────────────────────────────────────┐       │
│  │  Tenant Router (振り分けレイヤー)          │       │
│  │  teamId → port mapping                    │       │
│  └──┬────────────┬────────────┬──────────────┘       │
│     ▼            ▼            ▼                      │
│  ┌────────┐  ┌────────┐  ┌────────┐                 │
│  │OpenClaw│  │OpenClaw│  │OpenClaw│  ← テナント毎   │
│  │GW :3801│  │GW :3802│  │GW :3803│    Gateway      │
│  │ demo   │  │ tenantB│  │ tenantC│    プロセス      │
│  └───┬────┘  └───┬────┘  └───┬────┘                 │
│      ▼           ▼           ▼                      │
│  ┌────────┐  ┌────────┐  ┌────────┐                 │
│  │workspace│ │workspace│ │workspace│ ← テナント毎   │
│  │SOUL.md │  │SOUL.md │  │SOUL.md │   ワークスペース│
│  │memory/ │  │memory/ │  │memory/ │                 │
│  └────────┘  └────────┘  └────────┘                 │
└─────────────────────────────────────────────────────┘
```

### 2.2 現状 vs 目標

| 項目 | 現状（MVP） | 目標（Phase 2） |
|------|------------|----------------|
| Bot | 1コンテナ（共有） | 同左（変更なし） |
| OpenClaw | シェルプロセス + systemd | Docker コンテナ化 |
| テナント管理 | 手動（ディレクトリ作成） | プロビジョニングスクリプト自動化 |
| 利用量管理 | インメモリ（Map） | SQLite永続化 |
| 課金 | 未実装 | Stripe連携 |
| Slack App | 単一App（全テナント共有） | 同左 |

## 3. コンポーネント詳細

### 3.1 Slack Bot（共有）

- **ランタイム:** Node.js 22 / Docker container
- **フレームワーク:** @slack/bolt 4.x（Socket Mode）
- **Slack App:** 1つ（App ID: A0AFDHJUWM7）
- **接続方式:** Socket Mode（WebSocket。Inbound URLなし、ファイアウォール不要）
- **コンテナ:** `tasuku-bot`、`--network host`、`--restart unless-stopped`

#### 処理フロー
1. Slackからイベント受信（`app_mention` or DM `message`）
2. `teamId` でテナント特定 → 対応するOpenClaw Gatewayポートを解決
3. `POST /v1/chat/completions` にリクエスト
4. レスポンスをSlackに返信

#### セッション管理
- sessionKey形式: `tenant:{teamId}:user:{userId}:dm` or `tenant:{teamId}:user:{userId}:thread:{threadTs}`
- OpenClaw側で会話履歴を保持（sessionKeyベース）

### 3.2 Tenant Router（新規実装）

現状はBot内で単一Gateway（:3801）に固定接続。マルチテナント化にはルーティングが必要。

```javascript
// tenant-router.js
const TENANT_MAP = {
  // teamId → { port, token }
  "T067C2GV64B": { port: 3801, token: "demo-token-001" },
  // 新規テナント追加時にここに追記（Phase 1）
  // Phase 2: SQLite/JSONファイルから動的読み込み
};

export function resolveTenant(teamId) {
  return TENANT_MAP[teamId] || null;
}
```

### 3.3 OpenClaw Gateway（テナント毎）

- **1テナント = 1 Gatewayプロセス**（データ完全分離）
- **ポート:** 3801〜3850（最大50テナント）
- **config:** `~/tasuku-tenants/{tenantId}/.openclaw/openclaw.json`
- **workspace:** `~/tasuku-tenants/{tenantId}/workspace/`

#### config テンプレート
```json
{
  "auth": {
    "profiles": {
      "anthropic:default": {
        "provider": "anthropic",
        "mode": "token"
      }
    }
  },
  "agents": {
    "defaults": {
      "workspace": "/home/matsu/tasuku-tenants/{tenantId}/workspace"
    }
  },
  "gateway": {
    "port": "{PORT}",
    "mode": "local",
    "bind": "auto",
    "auth": {
      "mode": "token",
      "token": "{GENERATED_TOKEN}"
    },
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true },
        "responses": { "enabled": true }
      }
    }
  },
  "channels": {},
  "plugins": { "entries": {} }
}
```

#### workspace テンプレート
```
workspace/
├── AGENTS.md      # エージェント設定
├── SOUL.md        # たすくペルソナ（共通テンプレート）
├── USER.md        # 顧客情報（テナント固有）
├── TOOLS.md       # ツール設定
└── memory/        # 会話記録・学習
```

### 3.4 利用量管理

#### Phase 1（MVP）: インメモリ
- 現状のまま（`usage.js` の Map）
- Bot再起動でリセット（許容）
- リミット: 100メッセージ/日、3,000/月

#### Phase 2: SQLite永続化
```sql
CREATE TABLE usage (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,        -- YYYY-MM-DD
  count INTEGER DEFAULT 0,
  PRIMARY KEY (team_id, user_id, date)
);

CREATE TABLE tenants (
  team_id TEXT PRIMARY KEY,
  name TEXT,
  port INTEGER UNIQUE NOT NULL,
  token TEXT NOT NULL,
  plan TEXT DEFAULT 'solo',   -- solo/team/business
  status TEXT DEFAULT 'trial', -- trial/active/suspended/cancelled
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  trial_ends_at TEXT
);
```

- DBファイル: `~/tasuku-data/tasuku.db`
- Bot内でbetter-sqlite3使用（同期、高速）

### 3.5 課金（Stripe）

#### フロー
```
顧客がLP→Googleフォーム送信
    ↓ （手動）
管理者がテナント作成 + Stripe顧客作成
    ↓
Stripe Checkout Session生成 → 顧客にURL送付
    ↓
顧客が支払い → Webhook → テナントstatus: active
    ↓
サブスクリプション更新/解約 → Webhook → status更新
```

#### Webhook処理（Phase 2）
- エンドポイント: Bot内に `/stripe/webhook` 追加（Express）
- イベント: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`
- 支払い失敗 → 3日猶予 → suspended（Bot応答停止）
- 解約 → cancelled（30日後データ削除）

#### 料金プラン
| プラン | 月額（税別） | ユーザー数 | Stripe Price ID |
|--------|-------------|-----------|-----------------|
| Solo | ¥10,000 | 1人 | 作成時に設定 |
| Team | ¥25,000 | 3人 | 作成時に設定 |
| Business | ¥40,000 | 5人 | 作成時に設定 |

- 3日間無料トライアル（クレカ登録必須）
- 課金単位: Slackワークスペース

### 3.6 Slack App 配布方式

#### Phase 1: 単一ワークスペース（matsubokkuri）
- デモ・テスト用
- 直接インストール済み

#### Phase 2: マルチワークスペース対応
- Slack App を「Distribution」有効化
- OAuth Install Flow:
  1. 顧客が task.teraren.com/install からインストール
  2. OAuth callback → Bot Token取得 → DB保存
  3. テナント自動プロビジョニング
- **重要:** Socket Mode は単一ワークスペースのみ対応
- マルチWSには **Events API（HTTP）** への切り替えが必要

#### Socket Mode → Events API 移行

| 項目 | Socket Mode（現在） | Events API（Phase 2） |
|------|---------------------|----------------------|
| 接続 | WebSocket（Outbound） | HTTP POST（Inbound） |
| URL | 不要 | 必要（公開エンドポイント） |
| 複数WS | ❌ 不可 | ✅ 可能 |
| ファイアウォール | 不要 | Inbound 443必要 |

**移行方法:**
- Cloudflare Tunnel (`cloudflared`) で gmk を公開
- `https://api.task.teraren.com/slack/events` → `localhost:3000`
- Bolt の `socketMode: false` + `receiver: ExpressReceiver` に変更
- 各テナントの Bot Token を DB から動的取得

## 4. テナントプロビジョニング

### 4.1 プロビジョニングスクリプト

```bash
#!/bin/bash
# provision-tenant.sh <team_id> <team_name>
set -e

TEAM_ID=$1
TEAM_NAME=$2
BASE_DIR=/home/matsu/tasuku-tenants
TENANT_DIR="${BASE_DIR}/${TEAM_ID}"

# ポート割り当て（3801〜3850）
NEXT_PORT=$(find ${BASE_DIR} -name "openclaw.json" -exec grep -h '"port"' {} \; | \
  grep -oP '\d+' | sort -n | tail -1)
PORT=$((NEXT_PORT + 1))

# トークン生成
TOKEN=$(openssl rand -hex 16)

# ディレクトリ作成
mkdir -p "${TENANT_DIR}/.openclaw"
mkdir -p "${TENANT_DIR}/workspace/memory"

# OpenClaw config生成
cat > "${TENANT_DIR}/.openclaw/openclaw.json" << EOF
{
  "auth": {
    "profiles": {
      "anthropic:default": {
        "provider": "anthropic",
        "mode": "token"
      }
    }
  },
  "agents": {
    "defaults": {
      "workspace": "${TENANT_DIR}/workspace"
    }
  },
  "gateway": {
    "port": ${PORT},
    "mode": "local",
    "bind": "auto",
    "auth": {
      "mode": "token",
      "token": "${TOKEN}"
    },
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true },
        "responses": { "enabled": true }
      }
    }
  },
  "channels": {},
  "plugins": { "entries": {} }
}
EOF

# Workspace テンプレートコピー
cp "${BASE_DIR}/templates/SOUL.md" "${TENANT_DIR}/workspace/"
cp "${BASE_DIR}/templates/AGENTS.md" "${TENANT_DIR}/workspace/"
cp "${BASE_DIR}/templates/TOOLS.md" "${TENANT_DIR}/workspace/"

# USER.md（テナント固有）
cat > "${TENANT_DIR}/workspace/USER.md" << EOF
# USER.md
- **Team:** ${TEAM_NAME}
- **Team ID:** ${TEAM_ID}
EOF

# systemdサービス作成
cat > "${HOME}/.config/systemd/user/openclaw-${TEAM_ID}.service" << EOF
[Unit]
Description=OpenClaw Gateway (${TEAM_NAME})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${TENANT_DIR}
Environment=OPENCLAW_HOME=${TENANT_DIR}
Environment=ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
Environment=PATH=/home/matsu/.local/share/mise/installs/node/22.21.1/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/matsu/.local/share/mise/installs/node/22.21.1/bin/openclaw gateway start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "openclaw-${TEAM_ID}.service"

echo "✅ Tenant provisioned: ${TEAM_ID}"
echo "   Port: ${PORT}"
echo "   Token: ${TOKEN}"
echo "   Dir: ${TENANT_DIR}"
```

### 4.2 テナント削除スクリプト

```bash
#!/bin/bash
# deprovision-tenant.sh <team_id>
set -e

TEAM_ID=$1
BASE_DIR=/home/matsu/tasuku-tenants
TENANT_DIR="${BASE_DIR}/${TEAM_ID}"

systemctl --user stop "openclaw-${TEAM_ID}.service" 2>/dev/null
systemctl --user disable "openclaw-${TEAM_ID}.service" 2>/dev/null
rm -f "${HOME}/.config/systemd/user/openclaw-${TEAM_ID}.service"
systemctl --user daemon-reload

# 30日間バックアップ保持
mv "${TENANT_DIR}" "${BASE_DIR}/.archived/${TEAM_ID}-$(date +%Y%m%d)"

echo "✅ Tenant deprovisioned: ${TEAM_ID}"
```

## 5. セキュリティ

### 5.1 データ分離
- OpenClaw Gateway: テナント毎に完全独立プロセス（メモリ・ファイル分離）
- workspace: テナントディレクトリ外アクセス不可（OpenClawのworkspace制約）
- APIトークン: テナント毎にランダム生成

### 5.2 ネットワーク
- OpenClaw Gateway: `127.0.0.1` バインド（外部非公開）
- Slack通信: Socket Mode（Outbound WebSocket、ポート開放不要）
- Phase 2 Events API時: Cloudflare Tunnel経由（直接ポート開放なし）

### 5.3 シークレット管理
- Anthropic API Key: systemd Environment（テナント共通、テラレン負担）
- Slack Tokens: Bot `.env`（Docker環境変数）
- Stripe Secret Key: Bot `.env`
- Gateway Tokens: 各テナントconfig内

### 5.4 リスク・対策

| リスク | 対策 |
|--------|------|
| API Key漏洩 | Gateway経由のみ、Keyはサーバー内 |
| テナント間データアクセス | プロセス分離 + workspace制約 |
| DDoS/濫用 | 利用量リミット（100/日, 3000/月） |
| サーバー障害 | systemd自動再起動、UptimeRobot監視 |
| Anthropic API障害 | タイムアウト60s + エラーメッセージ返却 |
| gmk停電/回線断 | UPS未設定（TODO）、回線冗長なし |

## 6. 監視・運用

### 6.1 ヘルスチェック
- UptimeRobot: task.teraren.com（LP）
- TODO: Bot alive監視（Slack API ping or /health エンドポイント）
- systemd: `Restart=on-failure` で自動復旧

### 6.2 ログ
- Bot: Docker logs（`docker logs tasuku-bot`）
- OpenClaw: `/tmp/openclaw-{tenantId}.log` → Phase 2: journalctl
- アクセスログ: Bot内 console.log（イベント種別、channel、user、テキスト先頭50字）

### 6.3 バックアップ
- workspace（memory含む）: TODO — 日次rsync or git push
- SQLite DB: TODO — 日次コピー
- 設定ファイル: Git管理推奨

## 7. スケーリング

### 7.1 リソース見積もり

| リソース | 1テナント | 10テナント | 50テナント |
|----------|----------|-----------|-----------|
| RAM | ~400MB | ~4GB | ~20GB |
| CPU | idle時ほぼ0 | 低負荷 | 中負荷 |
| Disk | ~10MB | ~100MB | ~500MB |
| ポート | 1 | 10 | 50 |

- gmk現状: RAM 31GB中29GB使用済み（他コンテナ28台）
- **⚠️ 現状では新規テナント追加余地がほぼない（free 266MB）**
- 対策: 不要コンテナ停止で10〜20GB確保可能か要調査

### 7.2 スケールアウト（将来）
- gmk2台目追加 or VPS（Hetzner等）
- Bot → テナントルーティング時にホスト情報も含める
- `TENANT_MAP: { teamId → { host, port, token } }`

## 8. 実装ロードマップ

### Phase 1: MVP改善（〜1週間）
1. [x] Bot基本機能（DM、メンション、利用量制限、タイムアウト）
2. [ ] Tenant Router実装（Bot内、静的Map）
3. [ ] テンプレートファイル作成（`~/tasuku-tenants/templates/`）
4. [ ] プロビジョニングスクリプト作成・テスト
5. [ ] gmk不要コンテナ整理（RAM確保）
6. [ ] Bot end-to-end テスト再確認

### Phase 2: 課金・マルチWS（〜2週間）
1. [ ] SQLite導入（テナント管理 + 利用量永続化）
2. [ ] Stripe連携（Checkout、Webhook、サブスク管理）
3. [ ] Slack App Distribution有効化
4. [ ] Socket Mode → Events API移行
5. [ ] Cloudflare Tunnel設定（`api.task.teraren.com`）
6. [ ] OAuth Install Flow実装
7. [ ] 自動プロビジョニング（OAuth callback → テナント作成）

### Phase 3: 運用強化（〜1ヶ月）
1. [ ] 管理ダッシュボードAPI実装
2. [ ] 監視・アラート（Bot死活、テナントヘルス）
3. [ ] バックアップ自動化
4. [ ] ドキュメント整備（管理者向け、顧客向けガイド）
5. [ ] MCP self-service（顧客がツール追加可能）

## 9. ディレクトリ構成（gmk）

```
/home/matsu/
├── tasuku-tenants/
│   ├── templates/                    # テンプレートファイル
│   │   ├── SOUL.md
│   │   ├── AGENTS.md
│   │   └── TOOLS.md
│   ├── demo/                         # デモテナント
│   │   ├── .openclaw/
│   │   │   └── openclaw.json
│   │   └── workspace/
│   │       ├── SOUL.md
│   │       ├── USER.md
│   │       ├── AGENTS.md
│   │       ├── TOOLS.md
│   │       └── memory/
│   ├── {teamId}/                     # 各テナント（同構造）
│   │   └── ...
│   ├── provision-tenant.sh
│   └── deprovision-tenant.sh
├── tasuku-bot/
│   ├── Dockerfile
│   ├── .env
│   ├── package.json
│   └── src/
│       ├── index.js                  # Bolt app + イベントハンドラ
│       ├── openclaw.js               # OpenClaw HTTP APIクライアント
│       ├── usage.js                  # 利用量管理
│       └── tenant-router.js          # テナントルーティング（新規）
├── tasuku-data/
│   └── tasuku.db                     # SQLite（Phase 2）
├── rebuild-bot.sh
└── .config/systemd/user/
    ├── openclaw-demo.service
    └── openclaw-{teamId}.service     # テナント毎
```

## 10. 未決定事項

| # | 項目 | 選択肢 | 推奨 |
|---|------|--------|------|
| 1 | gmk RAM不足 | 不要コンテナ停止 / メモリ増設 / VPS併用 | 不要コンテナ停止を先に調査 |
| 2 | Phase 2のSlack接続方式 | Events API + Cloudflare Tunnel / Socket Mode複数App | Events API + Tunnel |
| 3 | バックアップ先 | 別ディスク / S3互換(R2) / Git | R2（Cloudflare既利用） |
| 4 | Anthropic APIキー | テラレン一括 / テナント毎 | テラレン一括（Phase 1）|
| 5 | テナント名 | teamId / カスタム名 | teamId（一意保証）|
| 6 | UPS導入 | あり / なし | 要検討（自宅サーバーSLA次第）|
