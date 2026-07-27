# セットアップガイド

## 前提条件

- Node.js 20 以上
- npm
- AWS アカウントと認証情報（`aws configure` 設定済み）
- Git

### エージェント機能を使う場合（任意）

- [uv](https://docs.astral.sh/uv/)（`curl -LsSf https://astral.sh/uv/install.sh | sh` または `brew install uv`）
  - 配布用パッケージのビルドと、ローカルでのエージェント実行に使います
  - Python は uv が管理するため、システムに個別に用意する必要はありません
  - エージェントが動くのは Python 3.12〜3.13 です（3.14 は `ag-ui-strands` 非対応）

Docker は不要です。AgentCore Runtime へは
[direct code deployment（CodeZip）](https://aws.amazon.com/blogs/machine-learning/iterate-faster-with-amazon-bedrock-agentcore-runtime-direct-code-deployment/)
でデプロイするため、コンテナのビルドが発生しません。

## Web アプリのセットアップ

```bash
# リポジトリのクローン
git clone <リポジトリURL>
cd <プロジェクト名>

# 依存関係のインストール
npm ci

# 環境変数の設定
cp .env.example .env.local
# .env.local を編集（エージェント不使用なら編集不要）

# Amplify sandbox の起動（バックエンド開発用、別ターミナルで）
npx ampx sandbox

# 開発サーバーの起動（別ターミナルで）
npm run dev
```

`http://localhost:3000/sample` で Todo リストが動けば成功です。

### 環境変数

エージェント機能を使わない場合、環境変数の設定は不要です。

| 変数 | 用途 | 設定場所 |
|------|------|---------|
| `AGENT_ENABLED` | `true` のとき、AgentCore Runtime / Memory を Amplify バックエンドの一部としてデプロイする。未設定なら Web アプリのみ | シェルの環境変数（ローカル） / Amplify コンソールの環境変数（Hosting） |
| `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` | `copilotkitStreamingRelay` の Lambda 関数 URL（`CopilotProvider.tsx` の `runtimeUrl`） | `.env.local` / Amplify コンソール |
| `ROLE_CONFIG_TABLE_NAME` | RoleConfig テーブル名（`GET /api/roles` が DynamoDB を `Scan` する対象。`NEXT_PUBLIC_` プレフィックスなし） | `.env.local` / Amplify コンソール |

後ろの 2 つは、バックエンドをデプロイすると `amplify_outputs.json` の `custom` に
出力されるので、そこからコピーしてください。

```bash
# npx ampx sandbox / pipeline-deploy の実行後
cat amplify_outputs.json | jq .custom
{
  "copilotkitRelayUrl": "https://xxxxxxxx.lambda-url.us-west-2.on.aws/",
  "roleConfigTableName": "RoleConfig-xxxxxxxxxxxxxxxxxxxxxxxxxx-NONE",
  "agentCoreRuntimeArn": "arn:aws:bedrock-agentcore:...:runtime/AWS_MCP_Agent_main_branch-xxxxxxxxxx",
  "agentCoreMemoryId": "AWS_MCP_AgentMemory_main_branch-xxxxxxxxxx"
}
```

`agentCoreRuntimeArn` と `agentCoreMemoryId` は確認用の出力です。中継 Lambda には
CDK が直接配線するため、**環境変数として設定する必要はありません**。

## エージェントのセットアップ（任意）

エージェント機能は Amplify バックエンドの一部としてデプロイされます。別のデプロイ
コマンドはありません。`AGENT_ENABLED=true` を設定したうえで通常どおり
`npx ampx sandbox` / `git push` すれば、AgentCore Runtime と Memory が作られます。

デプロイ手順の全体は [deployment.md](deployment.md) を参照してください。ここでは
ローカルでの作業に必要なことだけを説明します。

### 配布用パッケージのビルド

`AGENT_ENABLED=true` でデプロイする前に、エージェントの配布用パッケージを作る必要が
あります。CDK はディレクトリを zip して S3 に上げるだけで、依存関係の解決はしません。

```bash
./scripts/build-agent-package.sh
```

`agents/app/AWS_MCP_Agent/.build/` に、Linux arm64 向けに展開した依存とエージェントの
ソースが入ります（約 130MB、`.gitignore` 対象）。

- 依存は `agents/app/AWS_MCP_Agent/uv.lock` から解決されるため、ビルドは再現可能です
- `--python-platform aarch64-unknown-linux-gnu` によるクロス解決なので、macOS や
  x86 のマシンでも実行できます
- direct code deployment のパッケージ上限は 250MB です。スクリプトが超過を検査して
  止めます

Amplify Hosting のビルド中は `amplify.yml` の `preBuild` がこのスクリプトを実行します
（`AGENT_ENABLED=true` のブランチのみ）。

### ローカルでのエージェント単体確認

AWS リソースを作らずに、エージェントのロジックだけを確認できます。

```bash
cd agents/app/AWS_MCP_Agent
uv sync --group dev --python 3.13
LOCAL_DEV=1 uv run uvicorn main:app --host 0.0.0.0 --port 8080
```

別のターミナルから叩きます。

```bash
# /ping エンドポイント
curl http://localhost:8080/ping

# AG-UI リクエスト
curl -N -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{
    "threadId": "test-1",
    "runId": "run-1",
    "messages": [{"id": "m1", "role": "user", "content": "1+2は？"}],
    "tools": [], "context": [], "state": {}, "forwardedProps": {}
  }'
```

AWS リソースを操作するツールは、セッションに紐づくロールがないため使えません
（`X-Role-Names` ヘッダーが必要）。自前実装のツール（計算・日時・単位変換）までの
確認になります。

### テストと lint

```bash
cd agents/app/AWS_MCP_Agent
uv run pytest
uvx ruff check --select F .
```

### プロジェクト構成

```
amplify/
├── agent/resource.ts         # AgentCore Runtime / Memory / 実行ロールの定義
├── auth/ data/               # Cognito / AppSync + DynamoDB
├── functions/
│   └── copilotkitStreamingRelay/   # 中継 Lambda（認証ゲート + SigV4 署名）
└── backend.ts                # 全体の配線（AGENT_ENABLED の分岐を含む）

agents/
└── app/
    └── AWS_MCP_Agent/        # AWS MCP エージェント
        ├── main.py           # AG-UI サーバー（FastAPI + ag-ui-strands）
        ├── model/            # モデルローダー
        ├── prompts/          # システムプロンプト
        ├── roles/            # Role_Set 選択・AssumeRole・認証情報注入
        ├── scope/            # 操作スコープ判定
        ├── gateway/          # AWS MCP Server への接続（stdio プロキシ）
        ├── memory/           # AgentCore Memory 連携
        ├── pyproject.toml    # Python 依存関係
        ├── uv.lock           # ロックファイル（ビルドの再現性の源）
        ├── Dockerfile        # Container ビルド用（CodeZip では未使用、後述）
        └── .build/           # ビルド出力（生成物、.gitignore 対象）

scripts/
└── build-agent-package.sh    # 配布用パッケージのビルド
```

> **`Dockerfile` について**: 現在の構成（CodeZip）では使いません。パッケージが
> 250MB を超えて Container ビルドに切り替える必要が出たときの参照用に残しています。
> その場合は AgentCore CLI（`@aws/agentcore`）でのデプロイに戻す形になります。

## Kiro + Agent Toolkit for AWS

`.kiro/settings/mcp.json` で Agent Toolkit for AWS の MCP サーバーが設定済みです。
Kiro から以下の機能が利用できます:

- AWS ドキュメント検索
- AWS CLI コマンド実行
- Python スクリプト実行（boto3 経由）
- Agent Skills のオンデマンド検索・取得
- リージョン別サービス可用性の確認

Skills はローカルにインストールせず、MCP サーバー経由でオンデマンド検索されます。

## ローカル開発の制限事項

| 機能 | ローカルで動作 | 備考 |
|------|:---:|------|
| Todo リスト | ✅ | sandbox 起動が必要 |
| Cognito 認証 | ✅ | sandbox の Cognito を使用 |
| エージェント単体 | ✅ | `uvicorn`。AWS リソースは作らない |
| エージェントチャット（結合） | ❌ | SigV4 + `copilotkitStreamingRelay` 専用の Lambda 実行ロールが必要 |

エージェントチャットの結合テストは Amplify Hosting のデプロイ環境で行ってください。
環境ごとの対応関係は [environments.md](environments.md) にあります。

## 注意事項

- `.env.local` はコミットしないでください
- Amplify sandbox は開発用の一時的なバックエンド環境を作成します
- sandbox で `AGENT_ENABLED=true` を使うと、開発者ごとに AgentCore Runtime と Memory が
  作られます。Runtime は消費ベース課金で待機コストがないため実害は小さいですが、
  必要なとき以外は有効にしないのが無難です
- `LOCAL_DEV=1` を設定すると OpenTelemetry の警告が抑制されます
