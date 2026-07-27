---
inclusion: always
---

# リポジトリ構成

想定構成:
- `src/` : Web アプリケーション本体
  - `src/app/api/roles/` : ロール一覧 API Route
  - `src/lib/agent/` : CopilotProvider（認証 + CopilotKit 接続）
  - `src/components/agent/` : AgentChatSection（CopilotChat UI）
- `amplify/` : Amplify Gen 2 バックエンド定義
  - `amplify/agent/resource.ts` : AgentCore Runtime / Memory / Runtime 実行ロールの定義
  - `amplify/functions/copilotkitStreamingRelay/` : 中継 Lambda（認証ゲート + SigV4 署名）
- `agents/` : エージェントコード
  - `agents/app/AWS_MCP_Agent/` : Strands Agent + AG-UI サーバー
- `scripts/` : 配布用パッケージ（CodeZip）のビルドスクリプト
- `.kiro/` : Kiro ワークスペース設定
- `.github/` : CI/CD とリポジトリテンプレート

ルール:
- 明示的に依頼されない限り、主要ディレクトリを移動しない
- エージェントの**実行コード**は `agents/` に、**インフラ定義**は `amplify/agent/` に置く
  （Runtime / Memory は Amplify バックエンドスタックの一部としてデプロイするため）
- `agents/` に Web UI 層（API エンドポイント、HTML、フロントエンド）を含めない
- `src/` にエージェントのランタイムロジック（Python コード、エージェント定義）を含めない
- フロントエンドとエージェントの接続は CopilotKit + 中継 Lambda（関数 URL）+ SigV4 経由とする
- `agents/app/AWS_MCP_Agent/.build/` はビルド生成物。コミットしない

# ページ構成

- 新規機能はトップページ（`src/app/page.tsx`）に構築する
- 明示的に依頼されない限り、サブページを新たに作らず、トップページを主画面とする
- `src/app/sample/` はテンプレートの参考実装であり、機能開発時にはサンプルページへのリンクを外す
- サンプルページ自体は参照用に残してよいが、ナビゲーションからは除外する
