# agents/

AWS MCP エージェントの実行コードです。Web UI 層は含みません。

インフラ定義（AgentCore Runtime / Memory / Runtime 実行ロール）はこのディレクトリでは
なく **`amplify/agent/resource.ts`** にあります。Runtime は Amplify バックエンド
スタックの一部としてデプロイされるため、このディレクトリに CDK やデプロイ設定は
ありません。

```
agents/
└── app/
    └── AWS_MCP_Agent/        # Strands Agent + AG-UI サーバー
        ├── main.py           # /invocations と /ping を提供する FastAPI アプリ
        ├── model/            # モデルローダー
        ├── prompts/          # システムプロンプト
        ├── roles/            # Role_Set 選択・AssumeRole・認証情報注入
        ├── scope/            # 操作スコープ判定
        ├── gateway/          # AWS MCP Server への接続（stdio プロキシ）
        ├── memory/           # AgentCore Memory 連携
        ├── clock/ units/ calc/ visualization/   # 自前ツール
        ├── pyproject.toml    # 依存定義
        ├── uv.lock           # ロックファイル（配布パッケージの源）
        ├── Dockerfile        # Container ビルド用（現構成では未使用）
        └── .build/           # 配布用パッケージのビルド出力（生成物）
```

## ローカル実行

```bash
cd app/AWS_MCP_Agent
uv sync --group dev --python 3.13
LOCAL_DEV=1 uv run uvicorn main:app --host 0.0.0.0 --port 8080
```

AWS リソースは作られません。AWS 操作ツールはセッションに紐づくロールがないため
使えないので、自前ツール（計算・日時・単位変換）までの確認になります。

```bash
curl http://localhost:8080/ping

curl -N -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"threadId":"t1","runId":"r1","messages":[{"id":"m1","role":"user","content":"1+2は？"}],
       "tools":[],"context":[],"state":{},"forwardedProps":{}}'
```

## テストと lint

```bash
cd app/AWS_MCP_Agent
uv run pytest
uvx ruff check --select F .
```

`.build/` はサードパーティの依存を展開したビルド生成物なので、`pyproject.toml` の
`[tool.ruff]` と `[tool.pytest.ini_options]` で対象外にしています。

## デプロイ

専用のデプロイコマンドはありません。配布用パッケージを作ってから、Amplify の
バックエンドをデプロイします。

```bash
# リポジトリルートで
./scripts/build-agent-package.sh
git push origin <ブランチ名>       # または AGENT_ENABLED=true npx ampx sandbox
```

詳細は [../docs/deployment.md](../docs/deployment.md) を参照してください。

## 実行環境（AgentCore Runtime）

- プロトコル: AG-UI（`protocolConfiguration: AGUI`）
- エンドポイント: `POST /invocations`、`GET /ping`
- ランタイム: Python 3.13、Linux arm64
- 配布方式: [direct code deployment（CodeZip）](https://aws.amazon.com/blogs/machine-learning/iterate-faster-with-amazon-bedrock-agentcore-runtime-direct-code-deployment/)
  — zip を S3 に置く方式で、Docker は不要
- 許可されるカスタムヘッダー: `X-Role-Names`、
  `X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId`（`amplify/agent/resource.ts` の
  `requestHeaderAllowlist`）

Runtime に渡される環境変数（`ROLE_CONFIG_TABLE_NAME` など）は CDK が設定します。
ローカル実行時のみ `.env.local` で指定できます（`.env.example` を参照）。

> **`Dockerfile` について**: 現構成では使いません。配布パッケージが 250MB（CodeZip の
> 上限）を超えて Container ビルドに切り替える必要が出たときの参照用に残しています。
> その場合は AgentCore CLI（`@aws/agentcore`）によるデプロイに戻す形になります。
