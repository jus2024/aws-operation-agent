# エージェントチャット

サンプルページに配置された AgentCore Runtime との対話デモです。

## 概要

Cognito 認証済みユーザーが、CopilotKit + AG-UI プロトコル経由で AgentCore Runtime 上のエージェントとリアルタイムに対話できるチャット UI です。エージェントの応答はトークン単位でストリーミング表示されます。

## アーキテクチャ

> **Note**: 以前はこの中継処理を Next.js の Route Handler（`src/app/api/copilotkit/route.ts`）が
> 担っていましたが、Amplify Hosting の SSR Compute がレスポンスストリーミングを
> サポートしない制約があったため、独立した Lambda 関数（`amplify/functions/copilotkitStreamingRelay/`、
> Lambda 関数 URL・`InvokeMode: RESPONSE_STREAM`）に移植されました。`route.ts` は削除済みです。
> 詳細はリポジトリルートの [README.md](../../README.md#新しい-lambda-関数copilotkitstreamingrelayについて) を参照してください。

```
ブラウザ (CopilotKit + Cognito トークン)
  │
  ├─ 1. fetchAuthSession() → Cognito Access Token 取得
  │
  ├─ 2. POST {copilotkitStreamingRelay の Lambda 関数 URL}
  │     Authorization: Bearer {Cognito JWT}
  │     Body: CopilotKit ランタイムリクエスト
  │
  └─ copilotkitStreamingRelay Lambda（Amplify Gen 2 カスタム関数、Node.js マネージドランタイム）
       │
       ├─ 3. Bearer トークン存在確認（ユーザー認証ゲート）
       │
       ├─ 4. CopilotRuntime + ExperimentalEmptyAdapter
       │     HttpAgent → SigV4 署名（この Lambda 専用の実行ロールの IAM 権限）
       │
       └─ 5. AgentCore Runtime (IAM 認証)
             → AG-UI イベントストリーム応答（awslambda.streamifyResponse() で逐次転送）
```

## 通信方式

### ブラウザ → copilotkitStreamingRelay

| 項目 | 値 |
|------|-----|
| プロトコル | HTTPS |
| メソッド | POST |
| エンドポイント | `copilotkitStreamingRelay` の Lambda 関数 URL（`NEXT_PUBLIC_COPILOTKIT_RELAY_URL`） |
| 認証 | `Authorization: Bearer {Cognito Access Token}` |
| リクエスト形式 | CopilotKit Runtime プロトコル |

### copilotkitStreamingRelay → AgentCore Runtime

| 項目 | 値 |
|------|-----|
| プロトコル | AG-UI over HTTPS |
| メソッド | POST |
| エンドポイント | `https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{arn}/invocations?qualifier=DEFAULT` |
| 認証 | SigV4（サービス: `bedrock-agentcore`、コンピューティングロールの IAM 権限） |
| リクエスト形式 | `RunAgentInput`（`threadId`, `runId`, `messages[]`, `tools[]`, `state`） |
| レスポンス形式 | AG-UI イベントストリーム（SSE） |

## AG-UI イベント

| イベント | 説明 |
|---------|------|
| `RUN_STARTED` | エージェント実行開始 |
| `TEXT_MESSAGE_START` | メッセージ開始 |
| `TEXT_MESSAGE_CONTENT` | テキストチャンク（`delta` フィールド） |
| `TEXT_MESSAGE_END` | メッセージ終了 |
| `TOOL_CALL_START` | ツール呼び出し開始 |
| `TOOL_CALL_RESULT` | ツール実行結果 |
| `RUN_FINISHED` | エージェント実行完了 |
| `RUN_ERROR` | エラー発生 |

## SigV4 署名の仕組み

`copilotkitStreamingRelay` Lambda 内で `@smithy/signature-v4` を使用して署名します:

1. `defaultProvider()` でこの Lambda 専用の実行ロールの認証情報を取得
2. `SignatureV4` でリクエストに署名（サービス: `bedrock-agentcore`）
3. 署名済みヘッダーを付与して AgentCore Runtime に送信

この Lambda の実行ロールには `bedrock-agentcore:InvokeAgentRuntime` 権限が必要です
（`amplify/functions/copilotkitStreamingRelay/resource.ts` で CDK が自動付与、
Amplify Hosting のコンピューティングロールには不要）。詳細はリポジトリルートの
[README.md](../../README.md#新しい-lambda-関数copilotkitstreamingrelayについて) を参照してください。

## CopilotKit

フロントエンドの UI は CopilotKit が提供するコンポーネントを使用しています:

- `CopilotKit`（`@copilotkit/react-core/v2`）— API Route への接続プロバイダー（認証ヘッダー付与）
- `CopilotChat` — チャット UI コンポーネント（ストリーミング表示対応）

CopilotKit が AG-UI イベントのパース、メッセージ状態管理、ストリーミング表示を担当するため、独自の SSE パース実装は不要です。

### copilotkitStreamingRelay Lambda 側

- `CopilotRuntime` — エージェントの管理とリクエストルーティング
- `ExperimentalEmptyAdapter` — `serviceAdapter` として必須（LLM 直接呼び出しを行わないため）
- `HttpAgent`（`@ag-ui/client`）— SigV4 署名付きの fetch で AgentCore Runtime に接続
- `awslambda.streamifyResponse()` — CopilotKit_Runtime が返す `Response` の `body`
  （`ReadableStream`）を Lambda 関数 URL のレスポンスストリームに逐次 pipe する

## エージェント側

エージェントは `ag-ui-strands` でラップされた FastAPI サーバーです:

- `create_strands_app()` で AG-UI 対応の FastAPI アプリを生成
- `/invocations`（POST）と `/ping`（GET）エンドポイントを公開
- `StrandsAgent` が Strands Agent の応答を AG-UI イベントに変換
- AgentCore Runtime に `protocol: "AGUI"` でデプロイ

## エラーハンドリング

| エラー種別 | 条件 | UI 表示 |
|-----------|------|---------|
| Runtime 未設定 | `AGENTCORE_RUNTIME_ARN`（`copilotkitStreamingRelay` の環境変数）が空 | 入力無効化 + 案内メッセージ |
| 認証エラー | Cognito 未ログイン or トークン期限切れ | 401 → CopilotKit のエラー表示 |
| 権限エラー | `copilotkitStreamingRelay` の実行ロールの権限不足 | 500 → サーバーエラー表示 |
| AG-UI エラー | `RUN_ERROR` イベント | CopilotKit のエラー表示 |

## 関連ファイル

| ファイル | 役割 |
|---------|------|
| `amplify/functions/copilotkitStreamingRelay/resource.ts` | Lambda 関数定義（`defineFunction` カスタム CDK、関数 URL、IAM ポリシー） |
| `amplify/functions/copilotkitStreamingRelay/handler.ts` | CopilotKit Runtime + SigV4 → AgentCore の中継ハンドラー（ストリーミング対応） |
| `src/components/agent/AgentChatSection.tsx` | チャット UI セクション（CopilotChat 使用） |
| `src/lib/agent/CopilotProvider.tsx` | CopilotKit プロバイダー（Cognito トークン付与、`runtimeUrl` は関数 URL） |
| `agents/app/AWS_MCP_Agent/main.py` | AG-UI サーバー（FastAPI + ag-ui-strands） |

> `src/app/api/copilotkit/route.ts`（旧 Route Handler）は削除済みです。

## 前提条件

- Amplify Hosting にデプロイ済みであること
- `AGENTCORE_RUNTIME_ARN`（`copilotkitStreamingRelay` の環境変数）が設定されていること
- `NEXT_PUBLIC_COPILOTKIT_RELAY_URL`（フロントエンドが接続する関数 URL）が設定されていること
- AgentCore Runtime がデプロイ済みであること
- `copilotkitStreamingRelay` の実行ロールに `bedrock-agentcore:InvokeAgentRuntime` 権限があること（CDK が自動付与）
- ユーザーが Cognito でログイン済みであること

## ローカルでの制限

エージェントチャットの結合テストはローカルでは実行できません:
- SigV4 署名に `copilotkitStreamingRelay` Lambda の実行ロール（IAM）が必要
- ローカルの `npm run dev` 単体には該当ロールがない（`npx ampx sandbox` でこの Lambda 自体はデプロイされるが、
  フロントエンドとの結合確認には sandbox 環境の関数 URL への接続が必要）

エージェント単体のテストは `uv run uvicorn` でローカル実行可能です。

## カスタマイズ

- エージェントのシステムプロンプトやツールは `agents/app/AWS_MCP_Agent/main.py` で変更
- CopilotKit の UI は `AgentChatSection.tsx` の `labels` やスタイルで調整
- 新しいエージェントを追加する場合は `copilotkitStreamingRelay/handler.ts` の `agents` オブジェクトにも追加
- AgentCore Memory 有効化時は `handler.ts` で `X-Amzn-Bedrock-AgentCore-Runtime-User-Id` ヘッダーを追加
