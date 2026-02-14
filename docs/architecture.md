# たすく — システムアーキテクチャ

## システム構成図

```
┌─────────────────┐     ┌──────────────────────────────────────────┐
│   ブラウザ       │     │  gmk サーバー (Ubuntu, 8C/32GB)          │
│   (LP)          │     │                                          │
│  ai-hisho.      │────▶│  ┌─────────────────────────────────┐    │
│  teraren.com    │     │  │ tasuku-bot (Docker)              │    │
└─────────────────┘     │  │  ├─ Socket Mode (Slack Events)   │    │
                        │  │  ├─ Express API (:3800)          │    │
┌─────────────────┐     │  │  │   ├─ /slack/install           │    │
│   Slack          │◀──▶│  │  │   ├─ /slack/callback          │    │
│   Workspace(s)   │    │  │  │   ├─ /stripe/webhook          │    │
└─────────────────┘     │  │  │   └─ /billing/:teamId         │    │
                        │  │  ├─ tenants.json (/data/)        │    │
┌─────────────────┐     │  │  └─ usage tracking (in-memory)   │    │
│   Stripe         │───▶│  └─────────────────────────────────┘    │
│   (Webhooks)     │    │                                          │
└─────────────────┘     │  ┌─────────────────────────────────┐    │
                        │  │ OpenClaw Gateways                │    │
                        │  │  ├─ demo    (:3801)              │    │
                        │  │  ├─ t-xxx   (:3802)              │    │
                        │  │  ├─ t-yyy   (:3803)              │    │
                        │  │  └─ ...     (systemd services)   │    │
                        │  └─────────────────────────────────┘    │
                        └──────────────────────────────────────────┘
```

## ユーザーフロー

### 1. サインアップ（Slack OAuth）

```
LP → 「無料で試す」ボタン
  → GET /slack/install
  → Slack OAuth画面
  → ユーザーが許可
  → GET /slack/callback?code=xxx
  → Slack API: oauth.v2.access (トークン取得)
  → tenants.json にテナント作成
  → (将来) create-tenant.sh で専用Gateway起動
  → リダイレクト → 成功ページ
```

### 2. メッセージ処理

```
Slack → @たすく メッセージ
  → Socket Mode Event
  → team_id からテナント特定
  → 使用量チェック
     ├─ Free: total_messages < 10 → OK
     ├─ Free: total_messages >= 10 → 課金案内メッセージ
     ├─ Paid: daily < 100 && monthly < 3000 → OK
     └─ Paid: over limit → 制限メッセージ
  → OpenClaw Gateway (テナント別) に転送
  → AI応答をSlackに返信
  → 使用量カウンター更新
```

### 3. 課金フロー

```
無料枠超過 → Stripe Checkout URL 表示（3プラン）
  → ユーザーがプラン選択・カード入力
  → 3日間無料トライアル開始
  → Stripe Webhook: checkout.session.completed
  → tenants.json 更新 (plan, stripe_customer_id)
  → メッセージ制限解除
```

## データモデル

### tenants.json

```json
{
  "T12345ABC": {
    "tenant_id": "t-t12345abc",
    "team_id": "T12345ABC",
    "team_name": "Acme Corp",
    "bot_token": "xoxb-...",
    "gateway_url": "http://127.0.0.1:3802",
    "gateway_token": "tok-...",
    "gateway_port": 3802,
    "plan": "solo",
    "status": "active",
    "stripe_customer_id": "cus_...",
    "stripe_subscription_id": "sub_...",
    "total_messages": 42,
    "installed_by": "U12345",
    "created_at": "2026-02-14T10:00:00Z",
    "updated_at": "2026-02-14T12:00:00Z"
  }
}
```

### 使用量（in-memory, MVP）

- Free tier: `total_messages` in tenants.json (persistent)
- Paid tier: daily/monthly counters in-memory (resets on restart)
- TODO: Redis or SQLite for production

## プラン・料金

| プラン | 月額 | ユーザー数 | メッセージ上限 |
|--------|------|-----------|---------------|
| Free | ¥0 | - | 10回（生涯） |
| Solo | ¥10,000 | 1人 | 100/日 |
| Team | ¥25,000 | 3人 | 100/日/人 |
| Business | ¥40,000 | 5人 | 100/日/人 |

全有料プラン: 3日間無料トライアル、月3,000メッセージ上限

## テナント プロビジョニング

### MVP（現在）
- 全テナントがdemo Gatewayを共有
- セッションキーでテナント分離

### Phase 2（スケーリング）
- create-tenant.sh で専用Gateway起動（systemd service）
- ポート自動割当（3802〜）
- OAuth callback時に自動プロビジョニング

### ファイル構成

```
~/tasuku-tenants/
├── template/
│   └── openclaw.json
├── demo/           # 既存デモテナント
│   ├── openclaw.json
│   └── workspace/
├── t-xxx/          # テナントごと
│   ├── openclaw.json
│   └── workspace/
│       ├── SOUL.md
│       ├── AGENTS.md
│       ├── USER.md
│       └── TOOLS.md
├── create-tenant.sh
└── delete-tenant.sh
```

## インフラ

- **サーバー**: gmk (Ubuntu, 8 cores, 32GB RAM)
- **Bot**: Docker container `tasuku-bot`
- **Gateway**: systemd user services (1 per tenant)
- **LP**: GitHub Pages (matsubo/tasuku-lp) via Cloudflare
- **DNS**: ai-hisho.teraren.com → Cloudflare → gmk

## スケーリング計画

1. **〜50テナント**: 現在のgmkサーバー1台で十分
2. **50〜200テナント**: Gateway を複数サーバーに分散、ロードバランサー追加
3. **200+テナント**: Kubernetes + テナント管理API + 自動スケーリング
4. **データ**: tenants.json → PostgreSQL、使用量 → Redis

## セキュリティ

- テナント間のデータ分離（Gateway別ワークスペース）
- Slack Bot Token はテナントごとに管理
- Stripe Webhook は署名検証
- Gateway Token はテナントごとにユニーク
- .env にシークレット集約、Dockerで分離
