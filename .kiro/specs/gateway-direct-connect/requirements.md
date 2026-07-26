# Requirements Document

## Introduction

既存の「aws-mcp-gateway-agent」機能のアーキテクチャを、AWS 公式に確認された制約に基づいて刷新する。旧設計は「1 Gateway + 複数 MCP Server ターゲット（MCP Proxy for AWS 経由）」を前提としていたが、正しいパターンは「**アカウントごとに 1 Gateway、各 Gateway に 1 つの AWS MCP ターゲット（GATEWAY_IAM_ROLE による直接 SigV4 接続）**」である。

クロスアカウント運用は、対象アカウントごとに Gateway をデプロイし、リソースベースポリシーで中央 Runtime のロールに `InvokeGateway` を許可する形で実現する。中央の AgentCore Runtime は、セッションコンテキストに含まれる Gateway URL に接続し、AWS MCP ツールを利用する。

本変更はデータモデル・エージェント・API Route・フロントエンドに影響するが、ユーザー体験（ログイン → 接続選択 → チャット）は維持する。

### 変更の要点（旧設計との差分）

| 旧設計 | 新設計 |
|--------|--------|
| 1 Gateway + 複数 mcpServer ターゲット（Proxy 経由） | アカウントごとに 1 Gateway、各 Gateway に 1 AWS MCP ターゲット（直接接続） |
| `gatewayTargetName` でターゲットを識別 | `gatewayUrl` で接続先 Gateway を識別 |
| 固定 `GATEWAY_URL` 環境変数 | セッションごとに Gateway URL を切り替え |
| ツール名プレフィックス `<target>___` で分離 | 単一ターゲット Gateway のためプレフィックス不要（あっても 1 つ） |
| MCP Proxy for AWS 必須 | 不要 — Gateway が GATEWAY_IAM_ROLE で直接 SigV4 接続 |

## Glossary

- **Gateway**: AgentCore Gateway。1 つの AWS アカウント / リージョンの AWS MCP Server に接続するマネージドサービス。アカウントごとにデプロイされる
- **AWS_MCP_Server**: AWS MCP Server エンドポイント（`https://aws-mcp.<region>.api.aws/mcp`）。IAM（SigV4）認証を受け付ける
- **Gateway_URL**: Gateway の MCP エンドポイント URL。エージェントが接続する宛先。Gateway ごとに一意
- **GATEWAY_IAM_ROLE**: Gateway ターゲットの認証方式。Gateway のサービスロールが AWS MCP Server に SigV4 で直接接続する。Proxy 不要
- **Connection**: 運用者（管理者）が管理する接続カタログの 1 エントリ。表示名、AWS アカウント ID、リージョン、Gateway URL を含む
- **Connection_Catalog**: 利用可能な Connection の集合
- **Admin / ADMINS group**: 接続カタログの CRUD を許可された Cognito の管理者グループ
- **Chat_Session**: ユーザーとエージェント間の 1 つの対話セッション。1 つの Connection と Operation_Scope に固定される
- **Agent**: AgentCore Runtime 上で動作する Strands エージェント。セッションの Gateway URL に MCP クライアントで接続し AWS MCP ツールを使用する
- **Runtime**: AgentCore Runtime。中央アカウントにデプロイされ、複数の Gateway に接続可能
- **Profile_Selector**: チャット開始前にユーザーが Connection_Catalog から接続を選択する UI コンポーネント
- **Operation_Scope**: セッションで許可される AWS 操作の範囲（readonly / readwrite / admin）
- **Resource_Policy**: Gateway に付与するリソースベースポリシー。クロスアカウントの Runtime ロールに InvokeGateway を許可する
- **Frontend**: Next.js + CopilotKit で構成される Web アプリケーション
- **API_Route**: /api/copilotkit に配置される Next.js API Route。SigV4 署名で AgentCore Runtime にプロキシする
- **Data_Model**: Amplify Gen 2 で定義される DynamoDB ベースのデータモデル

## Requirements

### Requirement 1: Gateway の直接接続構成

**User Story:** 運用者として、各 AWS アカウントに Gateway をデプロイし AWS MCP Server に直接 SigV4 で接続させたい。Proxy を介さず、シンプルかつ安全に AWS リソースへのアクセスを提供するため。

#### Acceptance Criteria

1. THE Gateway SHALL connect to the AWS_MCP_Server endpoint (`https://aws-mcp.<region>.api.aws/mcp`) using GATEWAY_IAM_ROLE credential provider with SigV4 authentication
2. THE Gateway SHALL be scoped to a single AWS account, where the Gateway's service role IAM permissions determine which AWS resources can be operated on
3. WHEN the Agent invokes an AWS MCP tool via the Gateway, THE Gateway SHALL route the request to the AWS_MCP_Server and return the response within 30 seconds
4. IF the Gateway does not receive a response from the AWS_MCP_Server within 30 seconds, THEN THE Gateway SHALL return an error to the Agent indicating a timeout with the tool name
5. WHEN the Gateway encounters a connection error with the AWS_MCP_Server, THE Gateway SHALL return an error to the Agent indicating the failure type (connection refused, DNS resolution failure, or authentication failure)
6. THE Gateway SHALL expose its tools via an MCP endpoint URL (Gateway_URL) that the Agent can connect to using streamable HTTP transport

### Requirement 2: クロスアカウント構成

**User Story:** 運用者として、複数の AWS アカウントをまたいで管理したい。各アカウントに Gateway をデプロイし、中央の Runtime から接続できるようにするため。

#### Acceptance Criteria

1. THE Gateway SHALL support a Resource_Policy that grants specific IAM roles from other accounts permission to invoke the Gateway (InvokeGateway)
2. THE Runtime SHALL be capable of connecting to multiple Gateways deployed in different AWS accounts by using the Gateway_URL from the session context
3. WHEN the Runtime receives a session context containing a Gateway_URL, THE Agent SHALL connect to that specific Gateway for the duration of the Chat_Session
4. THE Runtime's execution role SHALL be granted InvokeGateway permission on each target account's Gateway via the target Gateway's Resource_Policy

### Requirement 3: エージェントの Gateway 接続

**User Story:** AWS ユーザーとして、AI エージェントが自分のセッションで選択された接続先 Gateway に接続し、そのアカウントの AWS リソースを自然言語で操作したい。

#### Acceptance Criteria

1. WHEN the Agent receives a session context with a Gateway_URL, THE Agent SHALL establish an MCP client connection to that Gateway_URL within 30 seconds
2. IF the Agent cannot establish a connection to the Gateway_URL within 30 seconds, THEN THE Agent SHALL log the failure and report a connection error to the user indicating that the Gateway is unreachable
3. THE Agent SHALL discover available AWS MCP tools from the connected Gateway via tools/list
4. WHEN a user sends a message in the Chat_Session, THE Agent SHALL interpret the request, select tools whose descriptions match the user's intent, and invoke them via the connected Gateway
5. IF no tool of the connected Gateway matches the user's request, THEN THE Agent SHALL respond indicating that the requested operation is not supported and list the categories of available tools
6. WHEN a tool invocation returns an error, THE Agent SHALL report the error to the user in natural language and suggest at least one corrective action
7. THE Agent SHALL restrict tool invocations to the Operation_Scope defined for the current session
8. IF a tool invocation is rejected due to Operation_Scope restrictions, THEN THE Agent SHALL inform the user with a message indicating the rejected operation name, the current scope restriction, and a suggestion to start a new session with read-write permissions

### Requirement 4: 接続カタログ（データモデル変更）

**User Story:** 開発者として、接続カタログに Gateway URL フィールドを追加し、セッションごとに接続先 Gateway を特定できるようにしたい。

#### Acceptance Criteria

1. THE Data_Model SHALL define a Connection model with fields: id (auto-generated), displayName (required, 1〜100 characters), awsAccountId (required, 12-digit string), awsRegion (required), gatewayUrl (required, the Gateway MCP endpoint URL), description (optional), createdAt (auto-generated), updatedAt (auto-generated)
2. THE Data_Model SHALL authorize the Connection model so that members of the ADMINS group can create, update, and delete entries, and any authenticated user can read entries
3. THE Data_Model SHALL define a ChatSession model with fields: id (auto-generated), ownerUserId (required), connectionId (required, references a Connection), operationScope (required, one of: "readonly", "readwrite", "admin"), startedAt (auto-generated), endedAt (optional)
4. THE Data_Model SHALL enforce owner-based authorization on the ChatSession model so that only the owning user can access their own records
5. THE Data_Model SHALL use Cognito user pool authentication as the default authorization mode
6. IF a Connection is deleted, THEN THE Data_Model SHALL prevent deletion while any ChatSession references that Connection

### Requirement 5: 接続カタログ管理 UI

**User Story:** 管理者として、各アカウントの Gateway URL を含む接続情報を登録・管理したい。一般ユーザーが接続先を簡単に選択できるようにするため。

#### Acceptance Criteria

1. WHERE the authenticated user belongs to the ADMINS group, THE Frontend SHALL provide a UI for creating a Connection with displayName (1〜100 characters), awsAccountId (12-digit number), awsRegion (pattern `[a-z]+-[a-z]+-[0-9]+`), gatewayUrl (valid URL), and description (optional)
2. WHERE the authenticated user belongs to the ADMINS group, THE Frontend SHALL provide a UI for editing an existing Connection
3. WHERE the authenticated user belongs to the ADMINS group, WHEN the user requests deletion of a Connection, THE Frontend SHALL display a confirmation dialog before executing the deletion
4. THE Frontend SHALL provide a UI for any authenticated user to list and read the Connection_Catalog entries, displaying each entry's displayName, awsAccountId, and awsRegion
5. WHEN an administrator creates or edits a Connection, THE Frontend SHALL validate that awsAccountId is a 12-digit number, awsRegion matches `[a-z]+-[a-z]+-[0-9]+`, gatewayUrl is a valid HTTPS URL, and displayName is 1〜100 characters
6. IF validation fails on any field during creation or editing, THEN THE Frontend SHALL display an inline error message per field indicating the expected format, and SHALL NOT submit the form

### Requirement 6: セッションごとの接続固定

**User Story:** AWS ユーザーとして、各チャットセッションが特定の接続に固定されることで、どのアカウントに対して操作しているか常に把握したい。

#### Acceptance Criteria

1. WHEN a user starts a new Chat_Session, THE Profile_Selector SHALL require the user to select one Connection before the chat input becomes active, and SHALL NOT render the chat interface until a Connection is selected
2. WHEN a user starts a new Chat_Session, THE Profile_Selector SHALL allow the user to select an Operation_Scope for the session
3. WHILE a Chat_Session is active, THE Frontend SHALL display the selected Connection's displayName, awsAccountId, and awsRegion in the chat header area, visible without scrolling
4. WHILE a Chat_Session is active, THE Frontend SHALL prevent changing the selected Connection without starting a new session
5. WHEN the API_Route receives a chat request for an active Chat_Session, THE API_Route SHALL resolve the Connection and include the Gateway_URL and Operation_Scope as session context passed to the Agent
6. IF the selected Connection is deleted or becomes unavailable while a Chat_Session is active, THEN THE Frontend SHALL display an error message and disable further chat input until the user starts a new session

### Requirement 7: 操作スコープ制御

**User Story:** AWS ユーザーとして、セッションごとに操作範囲を制限し、意図しない破壊的操作を防止したい。

#### Acceptance Criteria

1. THE Frontend SHALL provide Operation_Scope options including at minimum: readonly and readwrite
2. IF Operation_Scope is set to readonly, THEN THE Agent SHALL reject tool invocations classified as write operations (create, update, delete, or any action that changes AWS resource state)
3. WHILE a Chat_Session is active, THE Agent SHALL enforce the Operation_Scope regardless of user instructions within the chat
4. WHEN the Agent rejects a tool invocation due to Operation_Scope restrictions, THE Agent SHALL respond with a message indicating the rejected operation name, the current scope restriction, and a suggestion to start a new session with read-write permissions
5. THE Data_Model SHALL store the Operation_Scope selection as part of the ChatSession record
6. IF no Operation_Scope is explicitly selected by the user, THEN THE Frontend SHALL default to readonly

### Requirement 8: API Route の拡張

**User Story:** 開発者として、API Route が接続カタログから Gateway URL を解決し、エージェントにセッションコンテキストとして渡すことで、エージェントが正しい Gateway に接続できるようにしたい。

#### Acceptance Criteria

1. WHEN the API_Route receives a chat request, THE API_Route SHALL extract the connectionId and operationScope from the request body
2. IF the request body does not contain a connectionId or operationScope, THEN THE API_Route SHALL return a 400 error with a message indicating the required fields are missing
3. WHEN the API_Route receives a valid connectionId, THE API_Route SHALL resolve the Connection from the Connection_Catalog server-side and include the gatewayUrl as a header (X-Gateway-Url) to AgentCore Runtime
4. IF the Connection cannot be resolved from the Connection_Catalog, THEN THE API_Route SHALL return a 400 error indicating the Connection was not found
5. IF the request is not from an authenticated user (no valid Cognito token), THEN THE API_Route SHALL return a 401 error without proxying the request
6. WHEN the API_Route proxies a request to AgentCore Runtime, THE API_Route SHALL pass the operationScope value as a header (X-Operation-Scope) to AgentCore Runtime

### Requirement 9: チャット UI の拡張

**User Story:** AWS ユーザーとして、接続を選択してすぐにチャットを開始でき、現在のアカウント情報が常に見えるシンプルな UI を使いたい。

#### Acceptance Criteria

1. THE Frontend SHALL render the chat interface as the primary view at the root path, requiring user authentication before display
2. THE Profile_Selector SHALL list the available Connection_Catalog entries for the user to select from
3. WHILE a Chat_Session is active, THE Frontend SHALL display the Chat_Session's connected AWS account ID, region, and Connection displayName in a fixed header area above the chat messages
4. THE Frontend SHALL provide a "New Session" action that ends the current Chat_Session and returns the user to the Profile_Selector
5. WHEN no Connection exists in the Connection_Catalog, THE Frontend SHALL display the Profile_Selector with a message guiding the user to contact an administrator, and SHALL prevent access to the chat interface
6. WHERE the authenticated user belongs to the ADMINS group, THE Frontend SHALL provide access to the connection catalog management UI
7. WHERE the authenticated user does not belong to the ADMINS group, THE Frontend SHALL display only the Profile_Selector and chat interface, without connection catalog management controls
8. IF the Frontend fails to load the Chat_Session's Connection information, THEN THE Frontend SHALL display an error message and provide the "New Session" action for recovery

### Requirement 10: アクセス制限とユーザー管理

**User Story:** 管理者として、アプリケーションを招待制に制限し、カタログ管理を管理者に限定することで、AWS アカウントアクセスが一般公開されないようにしたい。

#### Acceptance Criteria

1. THE Frontend SHALL disable Cognito self-registration such that new users are created only by an administrator (AllowAdminCreateUserOnly = true)
2. THE Frontend SHALL require successful authentication before granting access to any application view
3. THE Data_Model SHALL restrict creation, editing, and deletion of Connection entries to members of the ADMINS group
4. IF a non-admin authenticated user attempts to create, edit, or delete a Connection, THEN THE Data_Model SHALL reject the operation
5. WHERE the authenticated user does not belong to the ADMINS group, THE Frontend SHALL NOT expose controls for creating, editing, or deleting Connection entries

### Requirement 11: Gateway ターゲット構成（運用者向け）

**User Story:** 運用者として、各アカウントの Gateway に AWS MCP ターゲットを正しく構成し、セキュアに AWS MCP Server へ接続させたい。

#### Acceptance Criteria

1. THE Gateway target SHALL be configured with targetType `mcpServer` pointing to the AWS_MCP_Server endpoint (`https://aws-mcp.<region>.api.aws/mcp`)
2. THE Gateway target SHALL use `GATEWAY_IAM_ROLE` credential provider type with iamCredentialProvider configuration specifying service `execute-api` and the target region
3. THE Gateway's service role SHALL have IAM permissions to invoke the AWS_MCP_Server endpoint (SigV4 authentication)
4. WHEN a new account is onboarded, THE operator SHALL deploy a new Gateway in the target account with the AWS MCP target and a Resource_Policy granting the central Runtime role InvokeGateway permission
5. WHEN a new Gateway is deployed and configured, THE administrator SHALL create a corresponding Connection entry in the Connection_Catalog with the new Gateway's MCP endpoint URL

### Requirement 12: 既存実装からの移行

**User Story:** 開発者として、既存の動作するコードを段階的に新アーキテクチャに移行し、ユーザー体験を維持しつつ内部構造を刷新したい。

#### Acceptance Criteria

1. THE Data_Model SHALL replace the `gatewayTargetName` field with `gatewayUrl` in the Connection model
2. THE API_Route SHALL replace the `X-Gateway-Target` header with `X-Gateway-Url` header when proxying to AgentCore Runtime
3. THE Agent SHALL replace the fixed `GATEWAY_URL` environment variable with dynamic Gateway URL resolution from session context (X-Gateway-Url header)
4. THE Agent SHALL manage MCP client connections per session, connecting to the Gateway URL specified in the session context
5. THE Frontend SHALL update the Connection form to accept `gatewayUrl` (HTTPS URL) instead of `gatewayTargetName`
6. THE Frontend SHALL maintain the existing user flow: login → select connection → chat, without requiring additional steps from the user
