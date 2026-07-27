# AGENTS.md

## リポジトリ原則
- Git をソースオブトゥルースとする
- 実装作業は feature ブランチで行う
- `main` への直接編集は想定しない
- 変更は小さく、依頼内容にスコープを絞る
- 明示的に依頼されない限り、無関係なリファクタは行わない

## セキュリティ原則
- シークレット、トークン、API キー、認証情報をハードコードしない
- AWS 標準の認証方式と環境変数ベースの設定を優先する
- IAM、CI/CD、認証、デプロイの変更はレビュー必須とする
- コンピューティングロールの権限変更は高感度変更として扱う

## 検証原則
- 最も狭い範囲の検証を最初に実行する
- 影響レイヤーを明示する: フロントエンド、Amplify バックエンド、エージェント、CI/CD
- 変更が複数レイヤーにまたがる場合は、関係性を明確に説明する

## プロジェクト構成
- `src/` : フロントエンドコード（Next.js App Router）
  - `src/app/api/roles/` : ロール一覧 API Route（RoleConfig を認証済みユーザーに返す）
  - `src/lib/agent/` : CopilotProvider（Cognito 認証 + CopilotKit 接続）
  - `src/components/agent/` : AgentChatSection（CopilotChat UI）
- `amplify/` : Amplify Gen 2 バックエンド定義
  - `amplify/auth/`, `amplify/data/` : Cognito, AppSync + DynamoDB
  - `amplify/agent/resource.ts` : AgentCore Runtime / Memory / Runtime 実行ロール
  - `amplify/functions/copilotkitStreamingRelay/` : 中継 Lambda（認証ゲート + SigV4 署名）
- `agents/` : オプションのエージェントコード（Web UI 層は含まない）
  - `agents/app/AWS_MCP_Agent/` : Strands Agent + AG-UI サーバー
- `scripts/build-agent-package.sh` : 配布用パッケージ（CodeZip）のビルド
- `.kiro/` : Kiro ワークスペース設定（steering, skills, MCP）
- `.github/` : CI ワークフロー（Web App の lint + 型チェック）
- `docs/` : 詳細ドキュメント

## 接続アーキテクチャ（エージェント使用時）
```
ブラウザ (CopilotKit + Cognito JWT)
  → copilotkitStreamingRelay Lambda 関数 URL (InvokeMode: RESPONSE_STREAM)
    → Cognito JWT 署名検証 → SigV4 署名（この Lambda 専用の実行ロール）
      → AgentCore Runtime (IAM 認証, AG-UI プロトコル)
        → BeforeToolCallEvent フックが選択済みロールで AssumeRole
          → AWS MCP Server 経由で AWS を操作
```

## デプロイ方針
- AgentCore Runtime / Memory は **Amplify バックエンドスタックの一部**（`amplify/agent/resource.ts`）
- `AGENT_ENABLED=true` のときのみ AgentCore のリソースを作成する
- Runtime へは direct code deployment（CodeZip）で配布するため Docker は不要
- デプロイ前に `./scripts/build-agent-package.sh` で配布用パッケージを作る
  （Amplify Hosting のビルドでは `amplify.yml` の `preBuild` が自動実行）
- テーブル名・ARN・Memory ID は synth 時に解決されるため、手動の環境変数設定は
  `AGENT_ENABLED` / `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` / `ROLE_CONFIG_TABLE_NAME` の 3 つのみ
- AgentCore Memory は `RemovalPolicy.RETAIN`（会話履歴を守るため）

## ツール
- IDE: Kiro
- MCP: Agent Toolkit for AWS（aws-mcp）
- Python / 依存管理: uv
- デプロイ: Amplify Hosting（Git push で自動、Web アプリとエージェントを同時に）

## CI/CD
- Web アプリ: `.github/workflows/ci.yml`（lint + 型チェック）
- エージェント: CI ワークフローは未設定。`ci.yml` は `agents/**` を `paths-ignore` しているため、
  エージェント側の検証は `agents/app/AWS_MCP_Agent/` でローカル実行する
  （`uv run pytest` / `uvx ruff check --select F .`）
- デプロイ: Amplify Hosting（push → 自動ビルド。バックエンド・フロントエンド・エージェントを一括）

## 成果物の方針
- 実用的で本番運用を意識した解決策を優先する
- 明示的に依頼されない限り、既存のプロジェクト構成を維持する
- 新規追加ファイルが必要な理由を説明する
