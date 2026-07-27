# セットアップガイド

## 前提条件

- Node.js 20 以上
- npm
- AWS アカウントと認証情報（`aws configure` 設定済み）
- Git

### エージェント機能を使う場合（任意）

- Python 3.12〜3.13（3.14 は ag-ui-strands 非対応）
- Docker（Container ビルドのエージェントに必要）
- AgentCore CLI (`npm install -g @aws/agentcore`)

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

| 変数 | 用途 | 必須 |
|------|------|------|
| `AGENTCORE_RUNTIME_ARN` | AgentCore Runtime の ARN（`copilotkitStreamingRelay` の Lambda 環境変数・IAM ポリシー用。`NEXT_PUBLIC_` プレフィックスなし） | エージェント使用時のみ |
| `AGENTCORE_MEMORY_ID` | AgentCore Memory の ID（会話履歴の読み出し `ListEvents` 用。未設定だと該当の IAM ポリシー自体が付与されず、履歴復元が 500 になる） | エージェント使用時のみ |
| `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` | `copilotkitStreamingRelay` の Lambda 関数 URL（`CopilotProvider.tsx` の `runtimeUrl`） | エージェント使用時のみ |
| `ROLE_CONFIG_TABLE_NAME` | RoleConfig テーブル名（`GET /api/roles` が DynamoDB を `Scan` する対象。`NEXT_PUBLIC_` プレフィックスなし） | エージェント使用時のみ |

`AGENTCORE_RUNTIME_ARN` と `AGENTCORE_MEMORY_ID` は CDK synth 時のシェル環境変数として
読まれます。ローカルでは `.env.local` に記載するか、シェルで `export` した状態で
`npx ampx sandbox` を実行してください。値の取得方法は後述の
[プレースホルダと ID の埋め方](#プレースホルダと-id-の埋め方エージェント機能を使う場合) を参照してください。

ローカル開発では環境変数なしで Web アプリの基本機能（Todo リスト等）が動作します。エージェントチャットは
これらの変数の設定・sandbox デプロイ後にのみ動作します（`copilotkitStreamingRelay` は
`npx ampx sandbox` を実行するとバックエンドの一部として一緒にデプロイされます）。

## エージェントのセットアップ（任意）

### AgentCore CLI のインストール

```bash
npm install -g @aws/agentcore
agentcore --version
```

### Python 環境

```bash
cd agents/app/AWS_MCP_Agent
python3.13 -m venv .venv    # Python 3.12 または 3.13 を使用
source .venv/bin/activate
pip install -e .
```

### ローカル動作確認

```bash
# 方法 1: uvicorn で直接起動（最小確認）
cd agents/app/AWS_MCP_Agent
source .venv/bin/activate
LOCAL_DEV=1 uvicorn main:app --host 0.0.0.0 --port 8080

# 方法 2: AgentCore CLI でローカル開発サーバーを起動
cd agents
agentcore dev
```

動作確認:

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

### プロジェクト構成

```
agents/
├── agentcore/
│   ├── agentcore.json           # AgentCore プロジェクト設定（Runtime / Memory / Gateway）
│   ├── aws-targets.json         # デプロイ先（アカウント + リージョン、.gitignore 対象）
│   ├── aws-targets.json.example # 上記のテンプレート
│   └── cdk/                     # CDK インフラ定義（IAM 権限の付与先）
├── app/
│   └── AWS_MCP_Agent/           # AWS MCP エージェント
│       ├── main.py              # AG-UI サーバー（FastAPI + ag-ui-strands）
│       ├── model/               # モデルローダー
│       ├── prompts/             # システムプロンプト
│       ├── roles/               # Role_Set 選択・AssumeRole・認証情報注入
│       ├── scope/               # 操作スコープ判定
│       ├── gateway/             # AWS MCP Server への接続（stdio プロキシ）
│       ├── memory/              # AgentCore Memory 連携
│       ├── pyproject.toml       # Python 依存関係
│       ├── Dockerfile           # Container ビルド用
│       └── uv.lock              # ロックファイル
├── AGENTS.md                    # AgentCore プロジェクト説明
└── README.md                    # エージェント開発ガイド
```

## プレースホルダと ID の埋め方（エージェント機能を使う場合）

このリポジトリは公開用に、AWS アカウント ID やリソース ID を `<...>` 形式の
プレースホルダに置き換えてあります。エージェント機能を使う場合は、以下をすべて
自分の環境の値に書き換えてください（書き換えないまま `agentcore deploy` すると、
存在しない ARN を参照した IAM ポリシーが作られ、実行時に `AccessDenied` になります）。

### 埋める順序

プレースホルダには「先に決まる値」と「Amplify バックエンドをデプロイした後にしか
分からない値」の2種類があります。次の順序で進めてください。

1. `<YOUR_AWS_ACCOUNT_ID>` / `<YOUR_REGION>` を埋める（先に決まる）
2. Amplify バックエンドをデプロイし（Amplify Hosting のブランチ、または
   `npx ampx sandbox`）、生成された RoleConfig テーブル名を確認する
3. `<APPSYNC_API_ID>` を埋める
4. `agentcore deploy` を実行する
5. `agentcore status` で Runtime ARN と Memory ID を確認し、環境変数に設定する

### 一覧

| プレースホルダ | 書き換える場所 | 入れる値 / 取得方法 |
|---------------|---------------|--------------------|
| `<YOUR_AWS_ACCOUNT_ID>` | `agents/agentcore/aws-targets.json`（`.example` からコピー）、`agents/agentcore/cdk/lib/cdk-stack.ts`（`MCP_AGENT_ASSUMABLE_ROLE_ARNS` / `ROLE_CONFIG_TABLE_ARN_BY_RUNTIME`） | デプロイ先の AWS アカウント ID（12桁）。`aws sts get-caller-identity --query Account --output text` |
| `<YOUR_REGION>` | `agents/agentcore/aws-targets.json` | デプロイ先リージョン（例: `us-west-2`）。`cdk-stack.ts` の DynamoDB ARN にもリージョンが直接書かれているため、`us-west-2` 以外を使う場合はそちらも合わせて変更する |
| `<APPSYNC_API_ID>` | `agents/agentcore/agentcore.json`（`AWS_MCP_Agent` の `ROLE_CONFIG_TABLE_NAME`）、`cdk-stack.ts`（`ROLE_CONFIG_TABLE_ARN_BY_RUNTIME.AWS_MCP_Agent`） | デプロイした Amplify バックエンドが生成した RoleConfig テーブル名 `RoleConfig-xxxxxxxx-NONE` の中央部分（AppSync API の ID）。AWS コンソール → DynamoDB → テーブル一覧で `RoleConfig-` から始まるテーブルを探し、`amplify:branch-name` タグで目的の環境のものかを確認する |
| （AgentCore Memory ID） | 環境変数 `AGENTCORE_MEMORY_ID`（ローカルは `.env.local`、Amplify Hosting はコンソールの環境変数） | `agentcore status` の Memory リソースに表示される ID（例: `agents_AWS_MCP_AgentMemory-XXXXXXXXXX`）。ソースコードに書く値ではない |
| （AgentCore Runtime ARN） | 環境変数 `AGENTCORE_RUNTIME_ARN`（同上） | `agentcore status` に表示される `AWS_MCP_Agent` の Runtime ARN |

> **`agentcore.json` と `cdk-stack.ts` の整合性**: 各 Runtime の
> `ROLE_CONFIG_TABLE_NAME`（`agentcore.json`）と、`cdk-stack.ts` の
> `ROLE_CONFIG_TABLE_ARN_BY_RUNTIME` に書いた ARN のテーブル名部分は、
> **必ず同じ値**にしてください。ずれると Runtime は読めないテーブルを参照し、
> ロール一覧が空になります。フロントエンド側の `ROLE_CONFIG_TABLE_NAME`
> （`.env.local` / Amplify コンソール）も同じテーブルを指す必要があります。

> **`<ACCOUNT_ID>` の表記について**: `docs/architecture-aws-mcp.md` などの
> IAM ポリシー例に出てくる `<ACCOUNT_ID>` は説明用のマスクです。書き換えが必要な
> 実ファイルは上記の表に挙げたものだけです。

初期状態の Runtime は `AWS_MCP_Agent` の 1 つだけなので、埋めるテーブル ID も 1 つです。
ステージング環境などを追加して Runtime を増やす場合は、環境ごとに
`agentcore.json` のエントリと `ROLE_CONFIG_TABLE_ARN_BY_RUNTIME` の ARN が増えます（手順は
[README の環境を増やす場合の Runtime 追加について](../README.md#環境を増やす場合の-runtime-追加について) を参照）。

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
| エージェント単体 | ✅ | uvicorn / agentcore dev |
| エージェントチャット（結合） | ❌ | SigV4 + `copilotkitStreamingRelay` 専用の Lambda 実行ロールが必要 |

エージェントチャットの結合テストは Amplify Hosting のデプロイ環境で行ってください。
sandbox / ステージング / 本番がそれぞれどのリソースを指すかは
[environments.md](environments.md) に、デプロイ手順は [deployment.md](deployment.md) にあります。

## 注意事項

- `.env.local` はコミットしないでください
- Amplify sandbox は開発用の一時的なバックエンド環境を作成します
- `LOCAL_DEV=1` を設定すると OpenTelemetry の警告が抑制されます
- AgentCore CLI の `agentcore dev` はローカル開発サーバーを起動しますが、AWS リソースは作成しません
