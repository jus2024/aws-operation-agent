# Requirements Document

## Introduction

既存の「接続カタログ (Connection Catalog)」と「チャットセッション履歴 (chat-session-history)」機能を全面改定し、真のマルチアカウント対応を実現する。

現状調査で判明した事実:

- `Connection.awsAccountId` / `Connection.awsRegion` は表示専用メタデータであり、実行時のルーティングには一切使用されていない。
- `Connection.gatewayUrl` はフロントエンドから `X-Gateway-Url` ヘッダーとして送信されるが、`agents/app/AWS_MCP_Agent/main.py` のエージェントはこのヘッダーを読み取らない（コード中に「per-session Gateway routing is reserved for future use」という明示的コメントがある）。エージェントは起動時に単一の `AWS_MCP_ENDPOINT` 環境変数へ、Runtime 自身の実行ロール（IAM SigV4）で 1 回だけ接続し、その MCPClient を全セッションで共有している。
- したがって現状は、UI でどの Connection を選択しても、実際に操作される AWS アカウント／リージョンは常に同一である。
- `ChatSession.endedAt` は「セッション終了」機能自体が存在しないため、一度も書き込まれることのない死んだフィールドである。
- `ChatSession.operationScope` はスキーマ上 optional だが、生成コードは常に値を設定しており実質必須である。

利用者との合意により、真のマルチアカウント対応は STS AssumeRole によるクロスアカウントロールチェーンではなく、既存依存パッケージ `mcp-proxy-for-aws`（`aws_iam_streamablehttp_client` を提供）が標準サポートする **マルチプロファイル機能** を用いて実現する。この機能は `AWS_MCP_PROXY_PROFILES` 環境変数（または `--profile` 引数）でプロファイル名を列挙すると、認証が必要なツール（`call_aws`, `run_script`, `get_presigned_url`, `get_tasks`）のスキーマに `aws_profile` パラメータが追加され、エージェント/LLM がツール呼び出し時に使用するプロファイルを選択できるようになる。この機構は SigV4 認証を前提とし、本プロジェクトは既に SigV4 のみを使用しているため、認証方式自体の変更は不要である。

本改定は「加算的な機能追加」ではなく、意味を失った既存フィールドの棚卸しを含む **全面改定 (Full Revision)** である。フィールドごとの扱いを以下に明示する。

### フィールドの扱い（全面改定サマリー）

| フィールド | 現状 | 本改定後 |
|---|---|---|
| `Connection.awsAccountId` | 表示専用（未使用） | **再定義**: `awsProfileName` が実際に指す AWS アカウントを示す表示用メタデータとして継続。ルーティングそのものには使用しない |
| `Connection.awsRegion` | 表示専用（未使用） | **再定義**: 同上。表示用メタデータとして継続 |
| `Connection.gatewayUrl` | セッションヘッダーとして送信されるが Agent 側で未読・未使用 | **廃止**: Agent は単一の `AWS_MCP_ENDPOINT`/`AWS_MCP_REGION` に接続し続ける設計を前提とし、Connection ごとに異なる Gateway URL を持つ必要がなくなるため削除する |
| `Connection.awsProfileName`（新規） | なし | **新規追加**: `mcp-proxy-for-aws` のマルチプロファイル機能に渡す実際の AWS CLI プロファイル名。Connection 選択 → 使用プロファイル決定の唯一の実効フィールドとなる |
| `ChatSession.endedAt` | 常に未設定（死んだフィールド） | **削除**: 「セッション終了」機能は存在せず、復活させる要件も本改定にはないため削除する |
| `ChatSession.operationScope` | スキーマ上 optional、実質必須 | **必須化**: `.required()` に変更する |
| `ChatSession.connectionId` | セッション作成時の Connection を記録 | **維持し、復元用途を明確化**: 過去セッション選択時に、その Connection（＝プロファイル・スコープ）へ実際にコンテキストを切り替えるための正式な参照として使う（現状は記録されるだけで復元に使われていない） |

## Glossary

- **Connection**: 運用者が管理する接続カタログの 1 エントリ。本改定後は「どの AWS CLI プロファイルを使用するセッションか」を表す単位となる
- **Connection_Catalog**: Connection の集合。ADMINS グループのみ作成・更新・削除でき、認証済みユーザーは読み取りのみ可能
- **AWS_Profile_Name**: Connection に新規追加される、AWS Runtime 実行環境上に存在すべき AWS CLI プロファイルの名前を表す文字列フィールド
- **MCP_Proxy**: 依存パッケージ `mcp-proxy-for-aws` が提供する `aws_iam_streamablehttp_client`。SigV4 認証で AWS MCP Server に接続する
- **Multi_Profile_Mode**: MCP_Proxy がマルチプロファイル機能を有効化した状態。認証が必要なツール（`call_aws`, `run_script`, `get_presigned_url`, `get_tasks`）のスキーマに `aws_profile` パラメータが追加される
- **AWS_MCP_PROXY_PROFILES**: MCP_Proxy にマルチプロファイル機能を有効化させる環境変数（スペース区切りのプロファイル名一覧）
- **Agent**: AgentCore Runtime 上で動作する Strands エージェント（`agents/app/AWS_MCP_Agent`）
- **Runtime**: Amazon Bedrock AgentCore Runtime。Agent の実行基盤
- **Chat_Session**: ユーザー所有のチャットセッションメタデータレコード（DynamoDB の ChatSession モデル）
- **Operation_Scope**: セッションに許可される AWS 操作範囲（readonly / readwrite / admin）
- **Session_History_Sidebar**: 既存の chat-session-history 機能で導入された、過去セッション一覧を表示するサイドバー
- **API_Route**: `/api/copilotkit` に配置される Next.js API Route。SigV4 署名で AgentCore Runtime へプロキシする
- **Data_Model**: Amplify Gen 2 で定義される DynamoDB ベースのデータモデル（`amplify/data/resource.ts`）
- **Credential_Provisioning_Mechanism**: Runtime の実行環境（コンテナ／マイクロ VM）に、Connection_Catalog に登録された各 AWS_Profile_Name に対応する AWS 認証情報を配置する仕組み。本ドキュメント作成時点で未確定であり、Requirement 7 で明文化する調査事項とする

## Requirements

### Requirement 1: エージェントのマルチプロファイル基盤構成

**User Story:** 運用者として、Agent が単一の SigV4 接続を維持しつつ、セッションごとに異なる AWS アカウントの認証情報を使い分けられるようにしたい。カスタムのクロスアカウントロールチェーンを実装せずに済むようにするため。

#### Acceptance Criteria

1. WHEN the Agent starts, THE Agent SHALL connect to a single AWS_MCP_Server endpoint using MCP_Proxy, consistent with the existing single-endpoint connection pattern in `gateway/client.py`
2. IF the Agent fails to connect to the AWS_MCP_Server endpoint at startup, THEN THE Agent SHALL block Runtime initialization and SHALL refuse to process any Chat_Session requests until a connection succeeds
3. WHERE one or more AWS_Profile_Name values are configured in the Connection_Catalog, THE Runtime deployment configuration SHALL set the AWS_MCP_PROXY_PROFILES environment variable (or equivalent MCP_Proxy profile configuration) listing every distinct AWS_Profile_Name value
4. WHEN Multi_Profile_Mode is enabled, THE Agent SHALL expose an aws_profile parameter on each tool whose underlying operation requires AWS credentials (call_aws, run_script, get_presigned_url, get_tasks)
5. WHERE Multi_Profile_Mode is disabled, THE Agent SHALL NOT expose an aws_profile parameter on any tool schema
6. IF an aws_profile value passed to a tool call does not correspond to a profile available in the Runtime execution environment, THEN THE Agent SHALL attempt the tool call exactly once without pre-validating the profile name beforehand, allow the underlying MCP_Proxy call to fail, report a tool execution error to the user indicating the profile name that could not be resolved, and SHALL NOT automatically retry that tool call using a different aws_profile value or omitting the aws_profile value
7. IF the Agent's error-reporting step for an unresolved aws_profile itself fails, THEN THE Agent SHALL still ensure the tool execution result returned to the caller (the LLM orchestration loop) is not reported as a successful result, and MAY fail silently on the error-reporting step itself (best-effort reporting)
8. THE Agent SHALL preserve existing Operation_Scope enforcement (Requirement in prior specs) independently of which aws_profile is selected for a given tool call

### Requirement 2: セッション開始時のプロファイル選択とエージェントへの伝播

**User Story:** AWS ユーザーとして、セッション開始時に選択した Connection（＝プロファイル）が、実際にそのセッション中のすべての AWS 操作に使われることを期待したい。

#### Acceptance Criteria

1. WHEN a user selects a Connection to start a Chat_Session, THE Frontend SHALL include the selected Connection's AWS_Profile_Name in the properties sent via CopilotKit alongside connectionId and operationScope
2. WHEN the API_Route receives a chat request whose properties include a non-empty AWS_Profile_Name value, THE API_Route SHALL forward that AWS_Profile_Name to the Runtime as a distinct header (e.g. X-Aws-Profile), separate from X-Operation-Scope
3. IF a chat request's properties do not include a non-empty AWS_Profile_Name value, THEN THE API_Route SHALL forward the chat request to the Runtime without an X-Aws-Profile header, rather than substituting a default value or a value from any previous request
4. WHILE a Chat_Session is active, WHEN the Agent invokes a tool that accepts an aws_profile parameter, THE Agent SHALL set that parameter to the AWS_Profile_Name received in that specific request's session context (the X-Aws-Profile header defined in Acceptance Criterion 2)
5. IF the session context does not include an AWS_Profile_Name, THEN THE Agent SHALL refuse to invoke any tool that accepts an aws_profile parameter and SHALL respond to the user indicating that the session is missing a required AWS profile, rather than falling back to the Runtime's default execution role credentials
6. THE Agent SHALL derive the AWS_Profile_Name used for each tool invocation exclusively from the AWS_Profile_Name present in that invocation's own request session context, and SHALL NOT reuse, cache, or carry over an AWS_Profile_Name from any other request, Chat_Session, or concurrently executing tool invocation

> **設計フェーズでの検証事項**: 現行の AG-UI / Strands 実行モデルでは、Agent はセッションごとの再構築ではなく起動時に一度だけ構築される（`_build_gateway_agent()` を参照）。Requirement 2.4 / 2.6 の「リクエストごとに session context から aws_profile を取得し、他セッションと混在させない」という観測可能な振る舞いは、(a) セッションごとにエージェントインスタンスまたはツールバインディングを動的に構築する方式、または (b) 各リクエストの入力コンテキストから `aws_profile` を読み取り LLM のツール呼び出し引数に反映させる方式、のいずれで実現するかを設計フェーズで確定すること。単一 Agent インスタンスが複数セッションを並行処理する場合、プロファイルの取り違え（クロスセッション汚染）を防ぐ実装方式の選定は特に重要である。

### Requirement 3: Connection データモデルの全面改定

**User Story:** 開発者として、Connection モデルのフィールドが実際の挙動と一致するように、廃止・再定義・新規追加を行いたい。

#### Acceptance Criteria

1. THE Data_Model SHALL add an awsProfileName field (required, string, 1 to 64 characters, restricted to alphanumeric characters, hyphens, underscores, and periods) to the Connection model, representing the AWS CLI profile name that the Agent SHALL use for sessions bound to that Connection
2. THE Data_Model SHALL remove the gatewayUrl field from the Connection model
3. THE Data_Model SHALL retain awsAccountId (required, 12-digit string) and awsRegion (required) on the Connection model as informational metadata describing the AWS account and region that awsProfileName is expected to resolve to; format validation of these fields (12-digit numeric check, region pattern check) is the Frontend's responsibility as described in Requirement 6, and is not enforced as a Data_Model schema constraint
4. THE Data_Model SHALL retain displayName (required) and description (optional) on the Connection model unchanged
5. THE Data_Model SHALL continue to authorize the Connection model so that only members of the ADMINS group can create, update, or delete entries, and any authenticated user can read entries
6. IF a user who is not a member of the ADMINS group attempts to create, update, or delete a Connection record, THEN THE Data_Model SHALL reject the operation completely, granting no partial or limited access

### Requirement 4: ChatSession データモデルの全面改定

**User Story:** 開発者として、ChatSession モデルから死んだフィールドを取り除き、実質必須のフィールドを正式に必須化したい。

#### Acceptance Criteria

1. THE Data_Model SHALL remove the endedAt field from the ChatSession model
2. THE Data_Model SHALL change the operationScope field on the ChatSession model from optional to required, retaining its existing enum values of readonly, readwrite, and admin
3. IF a create or update mutation on the ChatSession model omits a value for the required operationScope field, THEN THE Data_Model SHALL reject the mutation and SHALL NOT persist a ChatSession record lacking an operationScope value
4. THE Data_Model SHALL retain connectionId (required) on the ChatSession model as the authoritative reference used to restore a session's original Connection when that session is reselected
5. THE Data_Model SHALL retain the ownerUserId field (required string), sessionName field (required string), startedAt field (optional datetime), and updatedAt field (required datetime) on the ChatSession model without changing their types or required status
6. THE Data_Model SHALL continue to enforce owner-based authorization on the ChatSession model so that only the owning user can read, update, or delete their own records
7. IF a user who is not the owner of a ChatSession record attempts to read, update, or delete that record, THEN THE Data_Model SHALL reject the operation completely, granting no partial or limited access

### Requirement 5: 過去セッション選択時の接続復元

**User Story:** ユーザーとして、履歴サイドバーから過去のセッションを選択したとき、そのセッションが元々使っていた Connection（プロファイル・スコープ）に自動的に切り替わってほしい。現在アクティブな Connection が引き継がれてしまうと、意図しないアカウントに対して操作してしまう危険があるため。

#### Acceptance Criteria

1. WHEN a user selects a past Chat_Session from the Session_History_Sidebar, THE Frontend SHALL retrieve that Chat_Session's stored connectionId and operationScope from the Data_Model, and SHALL then look up the Connection record identified by that connectionId in the Connection_Catalog to obtain its awsProfileName, displayName, awsAccountId, and awsRegion
2. WHEN the Frontend resolves the past Chat_Session's connectionId, THE Frontend SHALL switch the active session context (Connection, AWS_Profile_Name, and Operation_Scope) to match the selected Chat_Session's stored values, replacing whatever Connection was active immediately before selection
3. IF the Connection referenced by a past Chat_Session's connectionId no longer exists in the Connection_Catalog, THEN THE Frontend SHALL display an error message identifying the missing Connection and SHALL NOT allow sending new messages in that session until the user starts a new session
4. WHEN the active session context changes as a result of selecting a past Chat_Session, THE Frontend SHALL update the CopilotKit properties (connectionId, operationScope, awsProfileName) sent on the next chat request to reflect the restored Connection
5. IF the Frontend fails to update the CopilotKit properties after switching to a restored Chat_Session's Connection, THEN THE Frontend SHALL display an error message indicating that the session could not be fully restored and SHALL block the user from sending new messages in that session until the properties are successfully updated
6. WHILE displaying a restored past Chat_Session, THE Frontend SHALL display the restored Connection's displayName, awsAccountId, and awsRegion in the session header, visible without scrolling
7. IF the Data_Model lookup of a past Chat_Session's stored fields or of the associated Connection record fails for a reason other than the Connection being absent from the Connection_Catalog (e.g. a network or server error), THEN THE Frontend SHALL display an error message indicating that the past session could not be restored and SHALL NOT allow sending new messages in that session until the user retries the selection or starts a new session
8. WHILE displaying a past Chat_Session whose Connection could not be resolved per Acceptance Criterion 3, THE Frontend SHALL display, in the session header, an indicator that the original Connection is missing, in place of the displayName, awsAccountId, and awsRegion, visible without scrolling

### Requirement 6: 接続カタログ管理 UI の更新

**User Story:** 管理者として、Connection の作成・編集フォームで新しい awsProfileName フィールドを入力し、廃止された gatewayUrl フィールドは操作しないようにしたい。

#### Acceptance Criteria

1. THE ConnectionForm component SHALL provide an input field for awsProfileName accepting between 1 and 256 characters (required) and SHALL NOT provide an input field for gatewayUrl
2. WHEN an administrator submits the ConnectionForm with an awsProfileName value that is empty or consists only of whitespace characters, THE Frontend SHALL display an inline validation error adjacent to the awsProfileName field and SHALL NOT submit the form
3. THE Frontend SHALL validate that awsAccountId is a 12-digit number and awsRegion matches the pattern `[a-z]+-[a-z]+-[0-9]+`, consistent with existing validation rules
4. WHEN an administrator submits the ConnectionForm with an awsAccountId value that is not a 12-digit number or an awsRegion value that does not match the pattern `[a-z]+-[a-z]+-[0-9]+`, THE Frontend SHALL display an inline validation error identifying the invalid field and SHALL NOT submit the form
5. THE ConnectionCatalogManager component SHALL display awsProfileName alongside displayName, awsAccountId, and awsRegion in the catalog list view
6. WHERE the authenticated user belongs to the ADMINS group, THE Frontend SHALL always expose the create, edit, and delete controls for Connection entries in the ConnectionCatalogManager
7. WHERE the authenticated user does not belong to the ADMINS group, THE Frontend SHALL display the Connection_Catalog entries in read-only mode and SHALL NOT expose controls for creating, editing, or deleting Connection entries

### Requirement 7: Runtime 実行環境への AWS 認証情報のプロビジョニング（要調査・高感度）

**User Story:** 運用者として、Connection_Catalog に登録された各 AWS_Profile_Name に対応する実際の AWS 認証情報を、AgentCore Runtime の実行環境に安全に配置する方法を明確にしたい。この方法が確定していない限り、マルチプロファイル機能は動作しない。

> **高感度変更（IAM／認証情報）**: 本 Requirement が対象とする範囲は IAM ロール・認証情報の配置方法に直接関わるため、リポジトリのワークフロー方針に従い PR レビュー必須の変更として扱うこと。

#### Acceptance Criteria

1. THE project documentation SHALL specify the Credential_Provisioning_Mechanism by which AWS credentials for each configured AWS_Profile_Name become available inside the Runtime's execution environment (e.g. AWS CLI profile files, environment-variable-based credential sets, or another documented method)
2. THE Credential_Provisioning_Mechanism SHALL NOT store long-lived AWS credential material (e.g. access key ID, secret access key, or session token) in the Data_Model, in application source code, or in version control; storing the AWS_Profile_Name string itself in the Data_Model as a reference identifier is not considered a violation of this criterion
3. WHEN the Runtime execution environment is rebuilt or redeployed, THE Credential_Provisioning_Mechanism SHALL make every AWS_Profile_Name that was resolvable in the execution environment before the rebuild or redeployment resolvable again after it completes, without the operator performing any additional manual configuration steps beyond those already completed prior to the rebuild or redeployment
4. WHEN a new Connection is added to the Connection_Catalog with a new AWS_Profile_Name, THE operator SHALL follow the documented procedure specified in Acceptance Criterion 1 to provision the corresponding AWS credentials into the Runtime execution environment; THE Connection SHALL be considered usable only once the Agent can successfully resolve that AWS_Profile_Name for a tool call, as described in Acceptance Criterion 5
5. IF a Connection's AWS_Profile_Name has no corresponding credentials provisioned in the Runtime execution environment (the profile is completely absent), THEN THE Agent SHALL report a tool execution error identifying the unresolved profile; the underlying MCP_Proxy MAY fall back to a different AWS account's credentials as long as this error is reported, since preventing that fallback is outside the Agent's control
6. THE Agent SHALL only apply the error-reporting behavior in Acceptance Criterion 5 above when the AWS_Profile_Name is entirely absent from the Runtime execution environment; THE Agent is NOT required to distinguish between invalid or inaccessible credentials for a profile that does exist

### Requirement 8: 既存実装からの移行

**User Story:** 開発者として、破壊的スキーマ変更を伴う本改定を、既存のカタログデータおよび既存セッションデータへの影響を明示した上で適用したい。

#### Acceptance Criteria

1. THE project documentation SHALL document the migration procedure for the two breaking schema changes covered by this revision — removal of gatewayUrl from Connection and removal of endedAt from ChatSession — specifying that sandbox environments SHALL be migrated by running `amplify sandbox delete` and recreating the sandbox, and that production environments SHALL undergo either a manual data migration of existing records or a full re-registration of Connection and Chat_Session data, consistent with the migration handling previously applied to the gatewayTargetName → gatewayUrl rename
2. IF a pre-existing Connection record has no value for the newly required awsProfileName field at the time the schema change described in Requirement 3.1 is deployed, THEN THE operator SHALL update or re-register that Connection record with a valid awsProfileName value before it is made available for use, and THE Frontend SHALL NOT present that Connection as selectable for starting a new Chat_Session until the update or re-registration is complete
3. THE Agent SHALL remove references to the AWS_MCP Gateway-URL-per-session mechanism that was never activated (the commented-out `build_agent_for_session` reservation in `main.py`), replacing it with the Multi_Profile_Mode mechanism described in Requirement 1 and Requirement 2
4. THE API_Route SHALL remove the X-Gateway-Url header and introduce the X-Aws-Profile header described in Requirement 2.2
5. THE Frontend SHALL preserve the existing login → select Connection → chat session-start flow for users who are not members of the ADMINS group, without introducing any new required user action (such as manually entering or selecting an AWS profile) beyond the existing steps; the new awsProfileName input field described in Requirement 6.1 SHALL be exposed only within the ADMINS-group Connection Catalog management UI
6. THE Frontend SHALL preserve the existing chat-session-history behaviors (session listing, renaming, deletion) unchanged except for the connection-restoration behavior introduced in Requirement 5
