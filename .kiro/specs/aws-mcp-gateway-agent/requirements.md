# Requirements Document

## Introduction

AWS MCP Server を AgentCore Gateway 経由で利用し、AWS ユーザーの運用支援を行う AI エージェント機能を構築する。1 つの AgentCore Gateway が複数の MCP ターゲット（事前ステージングされた接続）をホストし、それらを 1 つの仮想 MCP サーバーとして集約する。各接続は特定の AWS アカウント / リージョン / ロール構成を表し、運用者（管理者）が AgentCore CLI で Gateway ターゲットを追加・再デプロイすることで拡充される。一般ユーザーはこの接続カタログから 1 つを選択し、操作スコープ（読み取り専用 / 読み書き）を指定してチャットセッションを開始する。接続は AWS アカウントへのアクセスを伴うため、本アプリは一般公開せず、Cognito のセルフサインアップを無効化し（管理者のみがユーザーを作成）、カタログ管理は管理者グループに限定する。フロントエンドは既存の CopilotKit チャット UI を拡張する。

## Glossary

- **Gateway**: AgentCore Gateway。複数の MCP ターゲットをホストし、1 つの仮想 MCP サーバーとしてエージェントに集約公開するマネージドサービス
- **AWS_MCP_Server**: AWS MCP Server（Agent Toolkit for AWS）。AWS リソースの操作・照会を提供する MCP サーバー
- **Gateway_Target**: Gateway 上で 1 つの接続を表す MCP ターゲット。特定の AWS アカウント / リージョン / ロール構成（MCP Proxy for AWS のプロファイル等）に紐づき、ターゲット名のプレフィックスでツール名が区別される
- **Connection (catalog entry)**: 運用者（管理者）が管理する接続カタログの 1 エントリ。表示名、AWS アカウント ID、リージョン、対応する Gateway_Target への参照（ターゲット名 / プロファイル名）などの UI 表示用メタデータ。実体の Gateway_Target のプロビジョニングは運用者のタスク（AgentCore CLI 再デプロイ）
- **Connection_Catalog**: 利用可能な Connection (catalog entry) の集合。運用者が追加することで時間とともに拡充される
- **Admin / ADMINS group**: 接続カタログの作成・編集・削除を許可された Cognito の管理者グループ（例: ADMINS）
- **Chat_Session**: CopilotKit を介したユーザーとエージェント間の 1 つの対話セッション。1 つの Connection (catalog entry) と Operation_Scope に固定される
- **Agent**: AgentCore Runtime 上で動作する Strands エージェント。Gateway 経由で AWS MCP ツールを使用する
- **Profile_Selector**: チャット開始前にユーザーが Connection_Catalog から接続を選択する UI コンポーネント
- **Operation_Scope**: セッションで許可される AWS 操作の範囲（読み取り専用、読み書きなど）
- **Frontend**: Next.js + CopilotKit で構成される Web アプリケーション
- **API_Route**: /api/copilotkit に配置される Next.js API Route。SigV4 署名で AgentCore Runtime にプロキシする
- **Data_Model**: Amplify Gen 2 で定義される DynamoDB ベースのデータモデル

## Requirements

### Requirement 1: AgentCore Gateway の構成

**User Story:** As an administrator, I want a single AgentCore Gateway to host multiple AWS MCP targets and aggregate them, so that the AI agent can use tools from any pre-staged connection through one unified MCP endpoint.

#### Acceptance Criteria

1. THE Gateway SHALL host multiple Gateway_Targets, where each Gateway_Target represents one pre-staged Connection to a specific AWS account, region, and role configuration
2. THE Gateway SHALL aggregate all Gateway_Targets into a single virtual MCP server such that a tools/list request returns the combined set of tools from every Gateway_Target
3. THE Gateway SHALL prefix each tool name with its Gateway_Target name so that the Agent can identify which Connection a tool belongs to
4. WHEN the Agent invokes an AWS MCP tool, THE Gateway SHALL route the request to the AWS_MCP_Server of the corresponding Gateway_Target and return the response within 30 seconds
5. THE Gateway SHALL use SigV4-based IAM authentication for outbound requests to each AWS_MCP_Server
6. IF the Gateway does not receive a response from an AWS_MCP_Server within 30 seconds, THEN THE Gateway SHALL return an error to the Agent indicating a timeout with the target tool name and the Gateway_Target name
7. WHEN the Gateway encounters a connection error with an AWS_MCP_Server, THE Gateway SHALL return an error to the Agent indicating the failure type (connection refused, DNS resolution failure, or authentication failure) and the Gateway_Target name

### Requirement 2: エージェントの Gateway 統合

**User Story:** As an AWS user, I want to chat with an AI agent that operates only on the connection selected for my session, so that I can manage my infrastructure through natural language with clear scope.

#### Acceptance Criteria

1. THE Agent SHALL connect to the Gateway within 30 seconds of startup and discover available AWS MCP tools across all Gateway_Targets
2. IF the Agent cannot establish a connection to the Gateway within 30 seconds, THEN THE Agent SHALL log the failure and report a connection error to the user indicating that the Gateway is unreachable
3. THE Agent SHALL restrict tool invocations to the tools of the Gateway_Target selected for the current session, identified by the Gateway_Target name prefix
4. WHEN a user sends a message in the Chat_Session, THE Agent SHALL interpret the request, select tools of the current session's Gateway_Target whose descriptions match the user's intent, and invoke them via the Gateway
5. IF no tool of the current session's Gateway_Target matches the user's request, THEN THE Agent SHALL respond to the user indicating that the requested operation is not supported and list the categories of available tools for the current Connection
6. WHEN a tool invocation returns an error, THE Agent SHALL report the error to the user in natural language and suggest at least one corrective action
7. THE Agent SHALL restrict tool invocations to the Operation_Scope defined for the current session
8. IF a tool invocation is rejected due to Operation_Scope restrictions, THEN THE Agent SHALL inform the user that the operation is outside the permitted scope for the current session

### Requirement 3: 接続カタログ（運用者管理）

**User Story:** As an administrator, I want to manage a catalog of available AWS connections, so that general users can select from pre-staged connections without configuring AWS accounts or roles themselves.

#### Acceptance Criteria

1. WHERE the authenticated user belongs to the ADMINS group, THE Frontend SHALL provide a UI for creating a Connection (catalog entry) with a display name (1〜100 characters), AWS account ID, AWS region, and a Gateway_Target reference (target name / profile name)
2. WHERE the authenticated user belongs to the ADMINS group, THE Frontend SHALL provide a UI for editing an existing Connection (catalog entry)
3. WHERE the authenticated user belongs to the ADMINS group, WHEN the user requests deletion of a Connection (catalog entry), THE Frontend SHALL display a confirmation dialog before executing the deletion
4. THE Frontend SHALL provide a UI for any authenticated user to list and read the available Connection_Catalog entries, displaying each entry's display name, AWS account ID, and region
5. WHEN an administrator creates or edits a Connection (catalog entry), THE Frontend SHALL validate that the AWS account ID is a 12-digit number and the AWS region matches the pattern `[a-z]+-[a-z]+-[0-9]+` (e.g., us-east-1, ap-northeast-1)
6. IF validation fails on any field during creation or editing, THEN THE Frontend SHALL display an inline error message per field indicating the expected format, and SHALL NOT submit the form
7. THE Frontend SHALL present the Connection (catalog entry) as UI-visible metadata pointing to a Gateway_Target, while the provisioning of the Gateway_Target itself remains an operator task performed via AgentCore CLI redeploy

### Requirement 4: セッションごとの接続固定

**User Story:** As an AWS user, I want each chat session to be locked to a specific catalog connection, so that I have clear control over which account the agent operates on.

#### Acceptance Criteria

1. WHEN a user starts a new Chat_Session, THE Profile_Selector SHALL require the user to select one Connection (catalog entry) before the chat input becomes active, and THE Profile_Selector SHALL not render the chat interface until a Connection is selected
2. WHEN a user starts a new Chat_Session, THE Profile_Selector SHALL allow the user to select an Operation_Scope for the session
3. WHILE a Chat_Session is active, THE Frontend SHALL display the selected Connection's display name, AWS account ID, and region in the chat header area, visible without scrolling
4. WHILE a Chat_Session is active, THE Frontend SHALL prevent changing the selected Connection without starting a new session
5. WHEN the API_Route receives a chat request for an active Chat_Session, THE API_Route SHALL include the selected Connection's Gateway_Target name and Operation_Scope as session context to the Agent
6. IF the selected Connection is deleted or becomes unavailable while a Chat_Session is active, THEN THE Frontend SHALL display an error message indicating the Connection is no longer available and disable further chat input until the user starts a new session

### Requirement 5: 操作スコープ制御

**User Story:** As an AWS user, I want to control what operations the agent can perform per session, so that I can prevent unintended destructive actions on my infrastructure.

#### Acceptance Criteria

1. THE Frontend SHALL provide Operation_Scope options including at minimum: read-only and read-write
2. IF Operation_Scope is set to read-only, THEN THE Agent SHALL reject tool invocations classified as write operations (create, update, delete, or any action that changes AWS resource state)
3. WHILE a Chat_Session is active, THE Agent SHALL enforce the Operation_Scope regardless of user instructions within the chat
4. WHEN the Agent rejects a tool invocation due to Operation_Scope restrictions, THE Agent SHALL respond with a message indicating the rejected operation name, the current scope restriction, and a suggestion to start a new session with read-write permissions
5. THE Data_Model SHALL store the Operation_Scope selection as part of the Chat_Session record
6. IF no Operation_Scope is explicitly selected by the user, THEN THE Frontend SHALL default to read-only

### Requirement 6: データモデル定義

**User Story:** As a developer, I want a well-structured data model for the operator-managed connection catalog and session metadata, so that the application can persist configurations reliably.

#### Acceptance Criteria

1. THE Data_Model SHALL define a Connection model with fields: id (auto-generated identifier), displayName (required, maximum 100 characters), awsAccountId (required, 12-digit string), awsRegion (required), gatewayTargetName (required, the Gateway_Target / proxy profile identifier), description (optional), createdAt (auto-generated datetime), updatedAt (auto-generated datetime)
2. THE Data_Model SHALL define a ChatSession model with fields: id (auto-generated identifier), ownerUserId (required), connectionId (required, references an existing Connection id), operationScope (required, one of: "readonly", "readwrite", "admin"), startedAt (auto-generated datetime), endedAt (optional datetime)
3. THE Data_Model SHALL authorize the Connection model so that members of the ADMINS group can create, update, and delete entries, and any authenticated user can read entries
4. THE Data_Model SHALL enforce owner-based authorization on the ChatSession model so that only the owning user can create, read, update, and delete their own ChatSession records
5. THE Data_Model SHALL use Cognito user pool authentication as the default authorization mode
6. IF a Connection is deleted, THEN THE Data_Model SHALL prevent deletion while any ChatSession references that Connection, or SHALL mark the referencing ChatSession records as referencing an unavailable Connection

### Requirement 7: API Route の拡張

**User Story:** As a developer, I want the API route to resolve the selected catalog connection and pass session context to the agent, so that the agent knows which Gateway target to operate on and what operations are permitted.

#### Acceptance Criteria

1. WHEN the API_Route receives a chat request, THE API_Route SHALL extract the Connection id and Operation_Scope from the request body
2. IF the request body does not contain a Connection id or Operation_Scope, THEN THE API_Route SHALL return a 400 error with a message indicating the required fields are missing
3. WHEN the API_Route receives a valid Connection id, THE API_Route SHALL resolve the Connection from the Connection_Catalog server-side and include the Gateway_Target name as a header to AgentCore Runtime
4. IF the Connection cannot be resolved from the Connection_Catalog, THEN THE API_Route SHALL return a 400 error with a message indicating the Connection was not found
5. IF the request is not from an authenticated user, THEN THE API_Route SHALL return a 401 error without proxying the request
6. WHEN the API_Route proxies a request to AgentCore Runtime, THE API_Route SHALL pass the Operation_Scope value as a header to AgentCore Runtime

### Requirement 8: チャット UI の拡張

**User Story:** As an AWS user, I want a chat-focused UI that lets me pick from available connections and shows which AWS account I am working with, so that I always have context about my operations.

#### Acceptance Criteria

1. THE Frontend SHALL render the chat interface as the primary view of the application at the root path, replacing the current template landing page, and SHALL require user authentication before displaying the chat interface
2. THE Profile_Selector SHALL list the available Connection_Catalog entries for the user to select from
3. WHILE a Chat_Session is active, THE Frontend SHALL display the Chat_Session's connected AWS account ID, region, and Connection display name in a fixed header area above the chat messages
4. THE Frontend SHALL provide a "New Session" action that ends the current Chat_Session and returns the user to the Profile_Selector
5. WHEN no Connection exists in the Connection_Catalog, THE Frontend SHALL display the Profile_Selector with a message guiding the user to contact an administrator, and SHALL prevent access to the chat interface until at least one Connection exists
6. WHERE the authenticated user belongs to the ADMINS group, THE Frontend SHALL provide access to a connection catalog management UI in addition to the Profile_Selector and chat
7. WHERE the authenticated user does not belong to the ADMINS group, THE Frontend SHALL display only the Profile_Selector and chat interface, without the connection catalog management UI
8. IF the Frontend fails to load the Chat_Session's Connection information, THEN THE Frontend SHALL display an error message indicating the context could not be loaded and provide the "New Session" action to allow recovery

### Requirement 9: アクセス制限とユーザー管理

**User Story:** As an administrator, I want the application to be restricted to invited users and catalog management limited to admins, so that AWS account access is not exposed to the public.

#### Acceptance Criteria

1. THE Frontend SHALL disable Cognito self-registration such that new users are created only by an administrator (AllowAdminCreateUserOnly = true)
2. THE Frontend SHALL require successful authentication before granting access to any application view
3. THE Data_Model SHALL restrict creation, editing, and deletion of Connection_Catalog entries to members of the ADMINS group
4. IF a non-admin authenticated user attempts to create, edit, or delete a Connection (catalog entry), THEN THE Data_Model SHALL reject the operation
5. WHERE the authenticated user does not belong to the ADMINS group, THE Frontend SHALL NOT expose controls for creating, editing, or deleting Connection_Catalog entries
