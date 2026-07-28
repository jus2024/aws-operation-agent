# AWS_MCP_Agent

AG-UI プロトコルに準拠した Strands エージェントです。Amazon Bedrock AgentCore Runtime
上で動作し、AWS MCP Server 経由で AWS リソースを操作します。

## 概要

`POST /invocations` で AG-UI のリクエストを受け取り、応答を `text/event-stream` で
ストリーミングします。`GET /ping` はヘルスチェックです。

ツール呼び出しごとに `BeforeToolCallEvent` フックが動き、セッションで選択された
Role_Set から適切な IAM ロールを選んで `sts:AssumeRole` し、得た認証情報を
`mcp-proxy-for-aws` のサブプロセスに渡します。

## ローカル開発

```bash
uv sync --group dev --python 3.13
LOCAL_DEV=1 uv run uvicorn main:app --host 0.0.0.0 --port 8080
```

`LOCAL_DEV=1` は OpenTelemetry の警告を抑制します。AWS 操作ツールはセッションに
紐づくロールがないため使えません。

## テストと lint

```bash
uv run pytest
uvx ruff check .
```

## デプロイ

このディレクトリ単体でデプロイするコマンドはありません。Runtime は Amplify
バックエンドスタックの一部として作られます。

```bash
# リポジトリルートで
./scripts/build-agent-package.sh
git push origin <ブランチ名>
```

詳細は [../../../docs/deployment.md](../../../docs/deployment.md) を参照してください。
