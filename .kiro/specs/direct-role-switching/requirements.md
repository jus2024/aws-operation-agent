# Requirements Document

## Introduction

本仕様は、前回の「multi-account-mcp-access」仕様で採用した `mcp-proxy-for-aws` の Multi_Profile_Mode 方式を完全に置き換える。AgentCore Runtime の MicroVM/MMDS 環境では、mcp-proxy-for-aws がツールスキーマに `aws_profile` パラメータを追加しない（Multi_Profile_Mode が機能しない）ことが確認されたため、根本的に異なるアプローチを採用する。

### 新アーキテクチャの概要

- **直接 STS AssumeRole**: `BeforeToolCallEvent` フック内で `boto3` の `sts:AssumeRole` を直接呼び出し、取得した一時認証情報を `mcp-proxy-for-aws` サブプロセスの環境変数に注入する
- **Connection カタログ廃止**: DynamoDB の `Connection` モデル、ADMINS 専用管理 UI（`ConnectionForm`、`ConnectionCatalogManager`、`ConnectionList`）を全面撤去する
- **ロール選択の簡素化**: 利用可能なロールはアプリケーション設定（環境変数またはコード定数）で定義し、ユーザーはセッション開始時にロールを選択するだけで済むようにする
- **ChatSession モデル変更**: `connectionId` を `roleName` に置き換え、選択したロール名を直接保存する

### 前提事実（調査済み）

| 事実 | 詳細 |
|------|------|
| AgentCore Runtime 実行ロールの権限 | `sts:AssumeRole` が `AgentMCPAdminRole` および `AgentMCPReadOnlyRole` に対して許可済み |
| ロール ARN | `arn:aws:iam::<ACCOUNT_ID>:role/AgentMCPAdminRole`（AdministratorAccess）、`arn:aws:iam::<ACCOUNT_ID>:role/AgentMCPReadOnlyRole`（ReadOnlyAccess） |
| mcp-proxy-for-aws の動作 | stdio サブプロセスとして動作し、プロセス環境の AWS 認証情報（`AWS_ACCESS_KEY_ID` 等）を SigV4 署名に使用する |
| contextvars パターン | `BeforeToolCallEvent` フックが `current_session_context` ContextVar 経由でリクエストスコープのコンテキストを安全に読み取る仕組みは確立済み |
| Multi_Profile_Mode の失敗 | MicroVM/MMDS 環境では `AWS_MCP_PROXY_PROFILES` を設定してもツールスキーマに `aws_profile` が追加されない |

## Glossary

- **Agent**: AgentCore Runtime 上で動作する Strands エージェント（`agents/app/AWS_MCP_Agent`）
- **Runtime**: Amazon Bedrock AgentCore Runtime。MicroVM/MMDS 環境でエージェントを実行する基盤
- **MCP_Proxy**: `mcp-proxy-for-aws` の stdio サブプロセス。プロセス環境の AWS 認証情報を使って SigV4 署名を行い AWS MCP Server に接続する
- **Role_Config**: アプリケーション設定として定義される利用可能ロールの一覧。各エントリは表示名・ロール ARN・推論される操作スコープを持つ
- **Role_Name**: Role_Config 内の各ロールの識別キー（例: "admin", "readonly"）。ChatSession に保存され、セッション復元時のロール解決に使用される
- **Role_ARN**: AssumeRole 呼び出しに使用する IAM ロールの ARN
- **STS_AssumeRole**: AWS Security Token Service の AssumeRole API。一時的なアクセスキー・シークレットキー・セッショントークンを返す
- **Temporary_Credentials**: STS_AssumeRole が返す一時認証情報（AccessKeyId、SecretAccessKey、SessionToken）
- **Session_Context**: リクエストスコープで伝播される不変コンテキスト（role_name、operation_scope を含む）。contextvars.ContextVar で管理される
- **Chat_Session**: ユーザー所有のチャットセッションメタデータレコード（DynamoDB の ChatSession モデル）
- **Operation_Scope**: セッションに許可される AWS 操作範囲（readonly / readwrite / admin）
- **Role_Selector**: セッション開始時にユーザーが利用可能ロールから1つを選択する UI コンポーネント
- **Session_History_Sidebar**: 過去セッション一覧を表示するサイドバー
- **API_Route**: `/api/copilotkit` に配置される Next.js API Route
- **Data_Model**: Amplify Gen 2 で定義される DynamoDB ベースのデータモデル（`amplify/data/resource.ts`）
- **BeforeToolCallEvent_Hook**: Strands の `BeforeToolCallEvent` コールバック。各ツール呼び出し前に発火し、引数の改変やキャンセルが可能

## Requirements

### Requirement 1: アプリケーション設定によるロール定義

**User Story:** As a developer, I want available AWS roles to be defined as application configuration rather than user-managed database records, so that the system is simpler to set up and requires no admin action before users can start chatting.

#### Acceptance Criteria

1. THE Agent SHALL read the available role definitions from a Role_Config source (environment variables or configuration file) at startup, where each role entry specifies a Role_Name, a Role_ARN, a human-readable display name, and an associated Operation_Scope
2. WHEN the Role_Config contains zero valid role entries, THE Agent SHALL log an error at startup and SHALL refuse to process any Chat_Session requests until at least one valid role entry is configured
3. THE Role_Config SHALL define each role's Operation_Scope as exactly one of "readonly", "readwrite", or "admin", eliminating the need for a separate scope selection by the user at session start
4. THE Frontend SHALL retrieve the list of available roles from the API_Route (which reads from Role_Config), and SHALL NOT query a database or DynamoDB table to obtain the available roles
5. WHEN a Role_Name referenced by a past Chat_Session does not exist in the current Role_Config, THE Frontend SHALL display an error indicating the role is no longer available and SHALL NOT allow sending new messages in that session

### Requirement 2: BeforeToolCallEvent フックによる直接 STS AssumeRole

**User Story:** As a system, I want the BeforeToolCallEvent hook to call STS AssumeRole directly for each tool invocation, so that the mcp-proxy-for-aws subprocess uses the assumed role's temporary credentials for AWS operations, replacing the non-functional Multi_Profile_Mode approach.

#### Acceptance Criteria

1. WHEN the Agent invokes a tool that requires AWS credentials (call_aws, run_script, get_presigned_url, get_tasks), THE BeforeToolCallEvent_Hook SHALL call STS_AssumeRole using the Role_ARN associated with the current request's Role_Name from the Session_Context
2. WHEN STS_AssumeRole returns Temporary_Credentials successfully, THE BeforeToolCallEvent_Hook SHALL inject those credentials into the tool execution environment (via environment variables AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN) so that the MCP_Proxy subprocess uses the assumed role's credentials for SigV4 signing
3. THE BeforeToolCallEvent_Hook SHALL call STS_AssumeRole per tool invocation rather than caching credentials across multiple tool calls within the same session, ensuring that expired credentials are never reused
4. IF STS_AssumeRole fails (AccessDenied, ExpiredToken, or any other error), THEN THE BeforeToolCallEvent_Hook SHALL cancel the tool call and SHALL return an error message to the user identifying the Role_Name and the nature of the failure
5. THE BeforeToolCallEvent_Hook SHALL derive the Role_Name used for each STS_AssumeRole call exclusively from the Session_Context of that specific request, and SHALL NOT reuse, cache, or carry over a Role_Name from any other request or concurrently executing tool invocation
6. WHILE no Role_Name is present in the Session_Context, THE BeforeToolCallEvent_Hook SHALL cancel any tool call that requires AWS credentials and SHALL respond indicating that the session has no role configured

### Requirement 3: Session_Context の変更（aws_profile_name → role_name）

**User Story:** As a developer, I want the session context to carry a role_name instead of aws_profile_name, so that the context accurately represents the new direct-AssumeRole mechanism.

#### Acceptance Criteria

1. THE Session_Context dataclass SHALL replace the aws_profile_name field with a role_name field (string or None), representing the Role_Name selected for the current session
2. WHEN the API_Route receives a chat request whose properties include a non-empty role_name value, THE API_Route SHALL forward that role_name to the Runtime as an X-Role-Name header, replacing the previous X-Aws-Profile header
3. IF a chat request's properties do not include a non-empty role_name value, THEN THE API_Route SHALL forward the request without an X-Role-Name header, rather than substituting a default value
4. THE extract_session_context function SHALL extract role_name from the X-Role-Name header (case-insensitive) and SHALL validate that the extracted role_name exists in the Role_Config; IF the role_name does not exist in Role_Config, THE function SHALL treat it as absent (None) and log a warning
5. THE API_Route SHALL remove the X-Aws-Profile header logic entirely, as it is no longer used

### Requirement 4: ChatSession データモデルの変更

**User Story:** As a developer, I want the ChatSession model to store roleName directly instead of connectionId, so that session restoration does not depend on a Connection catalog lookup.

#### Acceptance Criteria

1. THE Data_Model SHALL replace the connectionId field on the ChatSession model with a roleName field (required, string), representing the Role_Name that was selected when the session was created
2. THE Data_Model SHALL retain the operationScope field as required, with its existing enum values of readonly, readwrite, and admin
3. THE Data_Model SHALL remove the endedAt field from the ChatSession model (dead field with no write path)
4. THE Data_Model SHALL retain the ownerUserId field (required string), sessionName field (required string), startedAt field (optional datetime), and updatedAt field (required datetime) without changing their types or required status
5. THE Data_Model SHALL continue to enforce owner-based authorization on the ChatSession model so that only the owning user can read, update, or delete their own records
6. IF a user who is not the owner of a ChatSession record attempts to read, update, or delete that record, THEN THE Data_Model SHALL reject the operation completely

### Requirement 5: Connection モデルおよび管理 UI の完全撤去

**User Story:** As a developer, I want to remove the Connection model and its associated admin UI entirely, so that the codebase is simplified and there is no confusion about the deprecated catalog approach.

#### Acceptance Criteria

1. THE Data_Model SHALL remove the Connection model definition entirely from the schema
2. THE Frontend SHALL remove the ConnectionForm component, the ConnectionCatalogManager component, and the ConnectionList component
3. THE Frontend SHALL remove the useConnectionCatalog hook and any imports referencing the Connection model
4. THE API_Route SHALL remove the connectionResolver module (validateAndExtractContext, buildProxyHeaders) and any logic that resolves connection IDs from the request body
5. THE Frontend SHALL remove the "catalog_empty" application state and any UI flows that prompt users to ask an admin to add connections before chatting
6. WHERE the authenticated user belongs to the ADMINS group, THE Frontend SHALL NOT display any connection catalog management interface, as the catalog no longer exists

### Requirement 6: セッション開始時のロール選択 UI

**User Story:** As a user, I want to select a role from a simple list when starting a new chat, so that I can begin working without needing an admin to pre-configure connections.

#### Acceptance Criteria

1. WHEN the user initiates a new chat session, THE Frontend SHALL display the Role_Selector component showing all available roles from the Role_Config, with each role's display name and associated Operation_Scope clearly visible
2. WHEN the user selects a role from the Role_Selector, THE Frontend SHALL create a new Chat_Session with the selected Role_Name and the Operation_Scope defined by that role in the Role_Config
3. THE Frontend SHALL send the selected Role_Name as a property via CopilotKit on every chat request within that session, replacing the previous connectionId and awsProfileName properties
4. THE Frontend SHALL NOT require a separate Operation_Scope selection step, as the scope is derived from the selected role's definition in Role_Config
5. IF the Role_Config contains only one role, THE Frontend SHALL automatically select that role and proceed to the chat session without displaying the Role_Selector

### Requirement 7: 過去セッション復元

**User Story:** As a user, I want to select a past session from the sidebar and have the system restore the original role context, so that I can continue working in the same AWS environment as before.

#### Acceptance Criteria

1. WHEN a user selects a past Chat_Session from the Session_History_Sidebar, THE Frontend SHALL read the stored roleName and operationScope from that Chat_Session record
2. WHEN the stored roleName exists in the current Role_Config, THE Frontend SHALL switch the active session context to use that role and its associated Operation_Scope, and SHALL send the roleName property on subsequent chat requests
3. IF the stored roleName does not exist in the current Role_Config, THEN THE Frontend SHALL display an error message indicating the role is no longer available and SHALL NOT allow sending new messages in that session
4. WHILE displaying a restored past Chat_Session, THE Frontend SHALL display the role's display name and Operation_Scope in the session header
5. WHILE displaying a past Chat_Session whose roleName cannot be resolved in the current Role_Config, THE Frontend SHALL display an indicator that the original role is unavailable, in place of the role display name

### Requirement 8: Operation_Scope 強制の維持

**User Story:** As a system, I want operation scope enforcement to continue working independently of the new AssumeRole mechanism, so that even within an admin role, the scope restricts which tools can be called.

#### Acceptance Criteria

1. THE BeforeToolCallEvent_Hook SHALL enforce Operation_Scope restrictions before attempting STS_AssumeRole, rejecting disallowed tool calls without consuming an AssumeRole call
2. THE BeforeToolCallEvent_Hook SHALL derive the Operation_Scope from the Session_Context (which is set based on the role's configured scope in Role_Config), not from a separate user-selected value
3. WHILE the Operation_Scope is "readonly", THE BeforeToolCallEvent_Hook SHALL reject tool calls that perform write operations, consistent with existing scope enforcement behavior

### Requirement 9: 既存実装からの移行

**User Story:** As a developer, I want a clear migration path from the current Connection-catalog-based implementation to the new direct-role-switching implementation.

#### Acceptance Criteria

1. THE project documentation SHALL specify that sandbox environments are migrated by running `amplify sandbox delete` and recreating the sandbox, consistent with previous migration procedures
2. THE Agent codebase SHALL remove all references to Multi_Profile_Mode, AWS_MCP_PROXY_PROFILES environment variable, and the aws_profile parameter injection logic in the existing BeforeToolCallEvent_Hook
3. THE Agent codebase SHALL remove the _tool_accepts_aws_profile check and AUTH_REQUIRING_TOOLS set that were specific to the Multi_Profile_Mode approach
4. THE API_Route SHALL remove the X-Aws-Profile header and the X-Gateway-Url header references, and SHALL introduce the X-Role-Name header as described in Requirement 3.2
5. THE Frontend SHALL preserve the existing chat-session-history behaviors (session listing, renaming, deletion) unchanged except for replacing connection-restoration with role-restoration as described in Requirement 7
6. THE CopilotProvider component SHALL replace the connectionId, operationScope, and awsProfileName properties with a single roleName property (the Frontend derives operationScope from Role_Config locally)

### Requirement 10: ロール設定の提供 API

**User Story:** As a frontend developer, I want an API endpoint that returns the available roles, so that the Role_Selector can display the list without hardcoding role information in the frontend bundle.

#### Acceptance Criteria

1. THE API_Route SHALL expose a GET endpoint (or equivalent mechanism) that returns the list of available roles with each role's Role_Name, display name, and Operation_Scope
2. WHEN the GET endpoint is called by an authenticated user, THE API_Route SHALL return the full list of available roles from the server-side Role_Config
3. IF the calling user is not authenticated (no valid Bearer token), THEN THE API_Route SHALL return a 401 Unauthorized response
4. THE response format SHALL include enough information for the Frontend to display the Role_Selector without any additional lookup or configuration
