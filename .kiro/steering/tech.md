---
inclusion: always
---

# 技術方針

主要スタック:
- フロントエンド: Next.js + TypeScript
- バックエンド: AWS Amplify Gen 2
- エージェント UI: CopilotKit（@copilotkit/react-core/v2 + @copilotkit/react-ui）
- エージェント通信: AG-UI プロトコル
- エージェント（任意）: Python 3.12〜3.13 / Strands Agents SDK + ag-ui-strands
- エージェント実行基盤（任意）: Amazon Bedrock AgentCore Runtime
- エージェントの依存管理: uv（`uv.lock` が配布用パッケージの源）
- リポジトリ: GitHub
- デプロイ先: Amplify Hosting（Web アプリとエージェントを同一スタックで一括）
- IDE 支援: Kiro + Agent Toolkit for AWS（MCP サーバー）

技術ルール:
- フロントエンドと Amplify バックエンド定義には TypeScript を使用する
- Python は `agents/` 内でのみ使用する
- エージェントのランタイム関連処理は Web アプリ本体から分離する
- 暗黙の規約より、明示的で読みやすい設定を優先する
- MCP サーバーは Agent Toolkit for AWS（aws-mcp）を使用する

# CopilotKit + AgentCore 接続の構成

```
ブラウザ (@copilotkit/react-core/v2 + CopilotChat)
  → copilotkitStreamingRelay の Lambda 関数 URL (InvokeMode: RESPONSE_STREAM)
    → Cognito JWT 署名検証
      → CopilotRuntime + ExperimentalEmptyAdapter
        → HttpAgent (fetch: sigv4Fetch でカスタム SigV4 署名)
          → AgentCore Runtime (IAM 認証, AG-UI プロトコル)
```

重要な設定:
- バックエンドの CopilotRuntime には `ExperimentalEmptyAdapter` が必須
- フロントエンドは `@copilotkit/react-core/v2` を使う（v1 ではない）
- AgentCore への認証は SigV4（IAM）— JWT は CopilotKit 経由では動作しない
- 中継は Next.js の Route Handler ではなく専用 Lambda（関数 URL）で行う。Amplify Hosting の
  SSR Compute はレスポンスストリーミングを有効化しないため
- `bedrock-agentcore:InvokeAgentRuntime` はこの Lambda 専用の実行ロールが持つ
  （コンピューティングロールには不要）
- AgentCore Runtime / Memory は Amplify バックエンドスタックの一部
  （`amplify/agent/resource.ts`、`AGENT_ENABLED=true` のときのみ）
