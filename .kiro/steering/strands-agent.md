---
inclusion: fileMatch
fileMatchPattern: "agents/**/*"
---

# Strands エージェント方針

- Python 3.12〜3.13 互換のコードを書く（3.14 は ag-ui-strands 非対応）
- エージェントはモジュール化し、ツールは明示的に定義する
- 隠れた副作用を避ける
- ログによる観測可能なランタイム動作を優先する
- 設定、プロンプト、ツール、ランタイムロジックを分離する
- ローカル実行を簡単かつ再現可能に保つ
- `agents/` はオプションのプロジェクト拡張コードであり、アプリの中心ではない

# AgentCore Runtime 前提（AG-UI プロトコル）

- エージェントは Amazon Bedrock AgentCore Runtime 上での実行を前提とする
- AG-UI プロトコルに準拠したサーバーとして実装する
- エンドポイント: `/invocations`（POST）と `/ping`（GET）
- Runtime の `protocolConfiguration` は `AGUI`（`amplify/agent/resource.ts` で設定）
- `agents/` 内に Web UI 層を含めない
- フロントエンドとの接続は CopilotKit + AG-UI + SigV4 経由

# 依存管理とローカル実行（uv）

- Python と依存の管理は uv を使用する（`uv sync --group dev --python 3.13`）
- ローカル起動: `LOCAL_DEV=1 uv run uvicorn main:app --host 0.0.0.0 --port 8080`
- テスト: `uv run pytest` / lint: `uvx ruff check --select F .`
- 依存を追加したら `uv.lock` を更新する（配布用パッケージのビルドがこのロックを使うため）
- `agents/app/AWS_MCP_Agent/.build/` はビルド生成物。lint / テストの対象外（pyproject.toml で除外済み）

# 認証構成

- AgentCore Runtime は IAM（SigV4）認証を使用する
- JWT 認証は CopilotKit 経由では動作しないため使用しない
- SigV4 署名は `copilotkitStreamingRelay`（Lambda 関数 URL、`InvokeMode: RESPONSE_STREAM`）内で行い、
  この Lambda 専用の実行ロールの権限を使用する
- `bedrock-agentcore:InvokeAgentRuntime` はこの Lambda の実行ロールが持つ。Amplify Hosting の
  コンピューティングロールには不要（必要なのは `/api/roles` 用の `dynamodb:Scan` のみ）

# デプロイ方針

AgentCore Runtime / Memory は **Amplify バックエンドスタックの一部**としてデプロイする
（`amplify/agent/resource.ts`）。AgentCore CLI は使用しない。

- `AGENT_ENABLED=true` のときのみ AgentCore のリソースを作成する（既定は無効）
- Runtime へは direct code deployment（CodeZip）で配布するため Docker 不要
  - Amplify Hosting のビルド環境が Docker 非対応という制約はこれで回避される
- デプロイ前に `./scripts/build-agent-package.sh` で配布用パッケージを作る
  （Amplify Hosting のビルドでは `amplify.yml` の `preBuild` が自動実行）
- テーブル名・ARN・Memory ID は synth 時に解決されるため手動設定しない
- リソース名は Amplify のバックエンド識別子から作る（例 `AWS_MCP_Agent_main_branch`）。
  **サフィックスを変えると Runtime / Memory が置き換わり、Memory の置き換えは会話履歴の断絶を意味する**
- AgentCore Memory は `RemovalPolicy.RETAIN`

環境分離:
- 環境の単位は Amplify のブランチ（と sandbox）のみ。エージェント側に別の環境概念はない
- ローカル開発でのエージェント動作確認は `uvicorn` を使用（AWS リソース不要）
- フロントエンド結合テストは Amplify Hosting のデプロイ環境で行う

# ドキュメント確認

- Strands Agents SDK の実装は、Power（strands）で最新ドキュメントを確認してから着手する
- AgentCore Runtime の設定・デプロイは、Power（aws-agentcore）で最新ドキュメントを確認してから着手する
- Amplify Gen 2 との統合は、Power（aws-amplify）または AWS MCP で最新ドキュメントを確認する
