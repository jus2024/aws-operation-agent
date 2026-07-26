# Requirements Document

## Introduction

現在、`/api/copilotkit`（Next.js Route Handler、`src/app/api/copilotkit/route.ts`）は Amplify Hosting の SSR Compute（Lambda）上で動作しており、AgentCore Runtime から返される AG-UI プロトコルのストリーミングレスポンス（`text/event-stream`）を、Amplify Hosting のデプロイ環境では逐次配信できず、応答が完了してから一括でブラウザに返される（Amplify Hosting は Next.js の Route Handler に対するレスポンスストリーミングを現時点でサポートしていない仕様上の制約）。ローカル開発環境（`npm run dev`、素の Node.js サーバー）および Amplify Gen 2 sandbox 環境ではストリーミングが正しく機能することを実機確認済みであり、この問題は Amplify Hosting のデプロイ環境に限定される。

本仕様は、Amplify Hosting にデプロイした本番環境でも、ブラウザの CopilotKit チャット UI にトークン単位（またはチャンク単位）の逐次表示を実現するための改修を対象とする。

### 原因の特定（調査済み事実）

- Amplify Hosting の SSR Compute（Next.js の Route Handler を含む）は、AWS Lambda 上で動作する。AWS Lambda のレスポンスストリーミング機能（`awslambda.streamifyResponse()`、Node.js マネージドランタイム限定）を利用するには、Lambda 関数 URL の invoke mode を `RESPONSE_STREAM` に設定するなど専用の構成が必要だが、Amplify Hosting は Next.js アプリの SSR Compute に対してこの構成を提供していない。
- 実機検証（AWS re:Post のスレッド、および複数の技術記事で報告例あり）により、Amplify Hosting にデプロイした Next.js の Route Handler から `ReadableStream` を返しても、レスポンスはバッファリングされ、完了後に一括で返されることを確認済み。
- 対照実験として、ローカル開発サーバー（`npm run dev`）および Amplify Gen 2 sandbox 環境（`npx ampx sandbox` と組み合わせたローカル実行）では、同一のコード（`route.ts`）でストリーミングが正しく機能することを確認済み。したがって問題は Amplify Hosting の SSR Compute 環境固有のものであり、`route.ts` 自体の実装不備ではない。
- 参考実装として、AgentCore Runtime のストリーミングレスポンスを AWS Lambda のレスポンスストリーミングでプロキシするデモ（[msysh/agentcore-and-lambda-stream-response](https://github.com/msysh/agentcore-and-lambda-stream-response)）、および AgentCore Runtime + API Gateway + Lambda でストリーミングを実現する構成解説記事（Classmethod 社）が存在する。これらは「CopilotKit Runtime の中継処理を、Amplify Hosting の SSR Compute とは別の、レスポンスストリーミング対応の Lambda（Function URL、invoke mode = `RESPONSE_STREAM`）として独立させる」という方向性を示している。

## 対象範囲外（スコープ外）

- AgentCore Runtime 自体のストリーミング実装（AG-UI プロトコルのイベント配信）の変更。AgentCore Runtime は既にストリーミングレスポンスを返しており、これは変更しない。
- Amplify Hosting のホスティング先自体の変更（例: Vercel、ECS/Fargate への全面移行）。本仕様では Amplify Hosting を Web アプリのホスティング先として維持する前提で、CopilotKit Runtime の中継処理のみを分離する方式を検討する。
- ロール選択・Role_Set・AWS 認証情報の注入ロジック（`agents/` 配下）の変更。本仕様はトランスポート層（HTTP レスポンスの配信方式）のみを対象とし、エージェント側のロジックには影響しない。
- 認証方式（SigV4 署名、Cognito Bearer トークン検証）の変更。既存の認証ゲートはそのまま維持する。

## Glossary

- **CopilotKit_Runtime**: `@copilotkit/runtime` パッケージが提供する `CopilotRuntime`。AG-UI プロトコルのイベントを CopilotKit フロントエンドが解釈できる形式に中継する
- **API_Route**: 現在 `src/app/api/copilotkit/route.ts` に実装されている Next.js Route Handler。CopilotKit_Runtime のインスタンス化、SigV4 署名、AgentCore Runtime への転送を行う
- **SSR_Compute**: Amplify Hosting が Next.js アプリの SSR（サーバーサイドレンダリング、Route Handler を含む）を実行するために自動的にプロビジョニングする AWS Lambda 環境
- **Streaming_Relay**: 本仕様で導入する、AgentCore Runtime からのストリーミングレスポンスをブラウザへ逐次中継する処理のことを指す総称（具体的な実装場所は設計フェーズで確定する）
- **AG-UI_Event**: AgentCore Runtime が `text/event-stream` 形式で返す、AG-UI プロトコルのイベント（トークン単位のテキストチャンク、ツール呼び出し状態等を含む）
- **Chat_UI**: `CopilotChat` コンポーネントによって表示される、ブラウザ側のチャット画面
- **TTFB**: Time To First Byte。レスポンスの最初のバイトがクライアントに到達するまでの時間

## Requirements

### Requirement 1: 本番環境（Amplify Hosting）でのトークン単位の逐次表示

**User Story:** As a user, I want the assistant's response to appear incrementally as it is generated when using the production app hosted on Amplify Hosting, so that I can start reading the answer before it finishes and the experience matches what I already see in local development and sandbox environments.

#### Acceptance Criteria

1. WHEN a user sends a chat message in the Amplify Hosting–deployed production environment, THE Chat_UI SHALL display the assistant's response incrementally as AG-UI_Event data arrives, rather than displaying the complete response only after the Agent has finished generating it.
2. THE Streaming_Relay SHALL deliver AG-UI_Event data to the Chat_UI in the Amplify Hosting–deployed production environment with materially the same incremental, chunked delivery behavior observed in the local development environment (`npm run dev`) and the Amplify Gen 2 sandbox environment.
3. THE Streaming_Relay SHALL preserve the existing tool-call visualization behavior (tool cards) in the Chat_UI without regressing their display position or visibility during normal conversation, consistent with the current local-development behavior.
4. WHEN this feature is deployed to the Amplify Hosting production environment, THE Streaming_Relay SHALL reduce Time_To_First_Byte for the assistant's response as observed from the browser, compared to the current buffered (non-streaming) behavior.

### Requirement 2: 既存の認証・SigV4署名・ロール伝播との整合性

**User Story:** As a developer, I want the streaming fix to preserve every existing security control on the request path, so that solving the streaming problem does not introduce a new authentication or authorization gap.

#### Acceptance Criteria

1. THE Streaming_Relay SHALL continue to require a valid Cognito Bearer token on every chat request and SHALL reject a request lacking one with an unauthorized response, consistent with the existing authentication gate in `route.ts`.
2. THE Streaming_Relay SHALL continue to sign every request to AgentCore Runtime using SigV4, using credentials available to the component performing the signing.
3. THE Streaming_Relay SHALL continue to propagate the `X-Role-Names` header (derived from the Role_Set selected for the Chat_Session) and the `X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId` header (derived from the Cognito `sub` claim) to AgentCore Runtime on every chat request, matching the current behavior in `route.ts`.
4. THE Streaming_Relay SHALL NOT expose the AgentCore Runtime ARN, IAM role ARNs, or AWS account IDs to the browser at any point in the request or response path.
5. IF the architecture change introduces a new AWS resource (e.g., a separate Lambda function or Lambda function URL) to perform the streaming relay, THEN THAT resource'S IAM execution role SHALL be granted only the minimum permissions necessary to sign and forward requests to AgentCore Runtime (`bedrock-agentcore:InvokeAgentRuntime`), consistent with the project's least-privilege principle.

### Requirement 3: アーキテクチャ変更の説明責任とテンプレートとしての一般性

**User Story:** As a maintainer of this template repository, I want the chosen streaming solution and its tradeoffs to be clearly documented, so that future users of this starter template can understand what changed, why, and what operational impact it has.

#### Acceptance Criteria

1. WHEN this feature introduces a new AWS resource or deployment step (e.g., a separate Lambda function, a new IAM role, a new CDK stack or construct) that is not part of the existing Amplify Hosting or AgentCore CLI deployment flow, THE Design_Document SHALL identify that resource, its purpose, and how it is deployed.
2. THE README SHALL be updated to describe the new deployment step or resource introduced by this feature, including any new environment variables, IAM permissions, or manual setup steps required to reproduce the behavior in a fresh deployment.
3. IF this feature relocates the CopilotKit_Runtime or Streaming_Relay logic out of the Next.js Route Handler (`src/app/api/copilotkit/route.ts`) into a separate deployable unit, THEN THE Design_Document SHALL explain the impact on the existing `src/app/api/copilotkit/` code path and whether it is replaced, wrapped, or retained alongside the new unit.
4. THE chosen solution SHALL avoid introducing project-specific business logic into the streaming relay mechanism, keeping it a generic, reusable piece of infrastructure consistent with this repository's purpose as a reusable starter template.

### Requirement 4: 段階的なロールバック可能性

**User Story:** As a developer, I want the ability to verify the streaming fix in isolation before it affects the production Amplify Hosting deployment, so that a problem with the new relay mechanism does not take down the existing (non-streaming but functional) production chat experience.

#### Acceptance Criteria

1. THE implementation SHALL be verifiable in a non-production context (e.g., local development, sandbox, or a preview/staging deployment) before being applied to the Amplify Hosting production branch (`main`).
2. IF the new Streaming_Relay mechanism fails to deliver a response for any reason, THEN THE Chat_UI SHALL surface an error to the user rather than silently hanging or displaying no feedback, consistent with the existing error-handling behavior in the current (non-streaming) implementation.
