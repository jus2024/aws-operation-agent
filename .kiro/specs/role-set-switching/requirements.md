# Requirements Document

## Introduction

本仕様は、`direct-role-switching` で確立した土台メカニズム（AgentCore Runtime の `BeforeToolCallEvent` フック内で `boto3 sts:AssumeRole` を直接呼び出し、取得した一時認証情報を `mcp-proxy-for-aws` サブプロセスに起動時 `env=` として渡す方式。実機で Admin ロール選択時の S3 バケット作成成功を確認済み）の上に、複数 AWS アカウント・複数ロールを1つのセッションで自由に扱えるようにする仕組みを構築する。

### 方針転換の経緯

本仕様の初期ドラフトでは、Admin と ReadOnly で非対称な構造的安全策を検討していた。具体的には、Admin 用の Runtime はアカウントごとに Runtime そのものを分離し（Runtime = アカウント数）、Admin ロールは1 Runtime あたり1エントリのみに制限することで、誤操作が別アカウントに及ぶことを構造的に防ぐという設計であった。ReadOnly 側は逆に、1つの Runtime に複数アカウント分の ReadOnly ロールを持たせ、調査対象アカウントはセッション内で LLM が都度判断する方式を採っていた。

ユーザーとの議論の結果、この非対称な構造的安全策は撤廃し、利便性を優先する方針に転換した。転換後の方針は次の通りである。

- Runtime は複数ではなく **1つのみ**とする（`direct-role-switching` の単一 Runtime 構成に戻る）。
- Role_Config は Admin/ReadOnly を問わず、Account_Label を持つ Role_Entry のフラットな一覧として定義する。Admin エントリを1つに制限する制約や、Runtime をアカウント単位に分離する制約は設けない。
- ユーザーはセッション開始時に、Role_Config から複数の Role_Entry を自由に選択して Role_Set を構成できる。admin scope のエントリと readonly scope のエントリを同じ Role_Set 内に混在させることも許可する。
- 選択した Role_Set は、そのセッション内では不変とする（変更するには新しいセッションを開始する）。
- セッション内でどの Role_Entry を使うかは、ツール呼び出し単位で LLM が自律的に選択する。これは初期ドラフトで ReadOnly 側にのみ適用していた「ツール呼び出し単位の選択メカニズム」を、admin/readonly を問わず Role_Set 内の全エントリに一般化したものである。
- スコープ強制（write 操作の許可判定）は、セッション単位の単一スコープ値ではなく、そのツール呼び出しで選ばれた個別の Role_Entry が持つ Operation_Scope に基づいて判定する。
- Role_Config のメンテナンスを画面上で行いたいという要望があるが、これは低優先度の要件として扱い、具体的な永続化方式の決定は設計フェーズに委ねる。

実装レベルでの事故防止策（誤操作防止のための追加確認ステップ等）や、Runtime 分離のような構造的安全策は、本仕様のスコープでは採用しない。

### 方針転換の経緯（2回目: Role_Config の永続化方式の確定）

上記の方針転換後、Role_Config の永続化方式について改めてユーザーと協議した。`direct-role-switching` を踏襲した `AGENT_ROLES` 環境変数（JSON文字列）を Agent のコールドスタート時に一度だけ読み込む方式では、Role_Entry を1件追加・変更・削除するたびに `agents/agentcore/agentcore.json` の編集と `agentcore deploy` の実行が必要になり、運用負荷が高いという課題が明らかになった。

この議論を受け、Role_Config の永続化方式を DynamoDB テーブル（Amplify Gen 2 の Data_Model として定義される Role_Config_Table）に確定した。これにより Role_Entry の追加・変更・削除は管理者向けのメンテナンス画面から行えるようになり、Agent の再デプロイが不要になる。この決定に伴い、これまで低優先度の要件として位置づけていた Requirement 8（Role_Config の画面メンテナンス）を正式な機能要件へ格上げした。なお、Agent が Role_Config_Table からいつ Role_Entry を取得するか（起動時のみか、都度読み込みか）、および画面での変更が Agent にどのタイミングで反映されるかの具体的な実装方式は、設計フェーズで確定する。

### 既存スペックとの関係

- **`direct-role-switching`（土台として採用）**: `BeforeToolCallEvent` フックによる直接 `sts:AssumeRole` 呼び出しと一時認証情報の `mcp-proxy-for-aws` サブプロセスへの注入方式は、本仕様でも変更せずそのまま踏襲する。単一 Runtime 構成、および `src/app/api/copilotkit/route.ts` が単一固定 Runtime ARN へルーティングする方式も変更しない。本仕様は「セッション内で1つの Role_Entry のみを使う」という制約を「セッション内で複数の Role_Entry から自律的に選択できる」制約に一般化するものである。
- **`multi-account-mcp-access`（採用しない別アプローチ）**: `mcp-proxy-for-aws` の Multi_Profile_Mode（`AWS_MCP_PROXY_PROFILES` 環境変数によるマルチプロファイル機能）を用いるアプローチであり、AgentCore Runtime の MicroVM/MMDS 環境ではツールスキーマに `aws_profile` パラメータが追加されず機能しないことが確認済みである。本仕様はこのアプローチを採用しない。

## 対象範囲外（スコープ外）

- Role_Config_Table（Role_Entry）に列挙される IAM ロールそのものの権限設計・trust policy 設定など、AWS 側の作業。
- 実装レベルでの事故防止策（例: write 操作前の追加確認ステップ、誤操作防止 UI 等）。本仕様では利便性を優先し、これらの構造的安全策は採用しない。
- Runtime を複数に分割する構成、および `src/app/api/copilotkit/route.ts` を複数 Runtime 対応に変更すること。本仕様では Runtime は1つのみであり、API_Route は `direct-role-switching` で確立した単一固定 Runtime ARN方式を変更せずそのまま使用する。
- Role_Entry の変更が Agent にどのタイミングで反映されるか（即時か、次回起動時か）の具体的な実装方式の確定。これは設計フェーズでの検討事項とする（Requirement 8 では利用者体験上のゴールのみを規定する）。

## Glossary

- **Runtime**: Amazon Bedrock AgentCore Runtime。本仕様では Runtime は常に1つのみ存在する
- **Role_Entry**: Role_Config 内の1エントリ。Role_Name・表示名・Account_Label（対象 AWS アカウントを識別する表示用ラベル）・Role_ARN・Operation_Scope・Is_Active を持つ。`direct-role-switching` の役割定義と初期ドラフトの Account_Role_Entry を一般化し、admin/readonly の両方に共通で用いる。Role_Entry は Is_Active の値に応じてアクティブ（選択候補として提示される）または非アクティブ（過去に削除され、選択候補には現れないが Role_Config_Table 上のレコードとしては残存する）のいずれかの状態を持つ
- **Is_Active**: Role_Entry が現在選択可能（アクティブ）かどうかを示すブール値のフィールド。Role_Config 画面メンテナンスにおける Role_Entry の削除操作は、このフィールドを false にすることを意味し、Role_Entry のレコード自体を Role_Config_Table から除去することを意味しない
- **Role_Config**: DynamoDB テーブル（Role_Config_Table）に永続化される、利用可能な Role_Entry のフラットな一覧。`direct-role-switching` の `AGENT_ROLES`（環境変数）に Account_Label を追加した上で、永続化先を DynamoDB テーブルへ移行したもの
- **Role_Config_Table**: Role_Config を永続化する Amplify Gen 2 の Data_Model（DynamoDB テーブル）。Role_Entry を1レコードとして保持する
- **Role_Set**: Chat_Session の開始時にユーザーが選択した、複数の Role_Entry の組み合わせ（配列）。選択後、その Chat_Session 内では不変である
- **Role_Set_Selector**: セッション開始時にユーザーが Role_Config から複数の Role_Entry を選択する UI コンポーネント（`direct-role-switching` の Role_Selector の後継。単一選択ではなく複数選択が可能）
- **Role_Name**: Role_Config 内の各 Role_Entry を一意に識別するキー
- **Role_ARN**: AssumeRole 呼び出しに使用する IAM ロールの ARN
- **Account_Label**: Role_Entry が対象とする AWS アカウントを識別する表示用ラベル
- **Operation_Scope**: 1つの Role_Entry に許可される AWS 操作範囲（"readonly"、"readwrite"、"admin" のいずれか。既存の enum 値として "readwrite" も維持するが、本仕様では主に "admin" と "readonly" を想定する）
- **STS_AssumeRole**: AWS Security Token Service の AssumeRole API。一時的なアクセスキー・シークレットキー・セッショントークンを返す
- **Temporary_Credentials**: STS_AssumeRole が返す一時認証情報（AccessKeyId、SecretAccessKey、SessionToken）
- **MCP_Proxy**: `mcp-proxy-for-aws` の stdio サブプロセス。プロセス環境の AWS 認証情報を使って SigV4 署名を行い AWS MCP Server に接続する
- **BeforeToolCallEvent_Hook**: Strands の `BeforeToolCallEvent` コールバック。各ツール呼び出し前に発火し、引数の改変やキャンセルが可能
- **Session_Context**: リクエストスコープで伝播される不変コンテキスト。本仕様では Role_Set（選択された Role_Entry の一覧）を保持する
- **Chat_Session**: ユーザー所有のチャットセッションメタデータレコード（DynamoDB の ChatSession モデル）
- **Session_History_Sidebar**: 過去セッション一覧を表示するサイドバー
- **API_Route**: `/api/copilotkit` に配置される Next.js API Route
- **Frontend**: Next.js フロントエンドアプリケーション
- **Agent**: AgentCore Runtime 上で動作する Strands エージェント
- **Data_Model**: Amplify Gen 2 で定義される DynamoDB ベースのデータモデル
- **Administrator / ADMINS group**: Role_Config 画面メンテナンス機能へのアクセスを許可された Cognito のグループ（`ADMINS`）に属するユーザー

## Requirements

### Requirement 1: Role_Config_Table からのフラット構成での読み込み

**User Story:** As a developer, I want the Agent to load a flat list of Role_Entry records, each carrying an Account_Label, from a Role_Config_Table persisted in DynamoDB, so that roles across every AWS account and scope are available for selection without partitioning the Runtime by account, limiting the number of admin entries, or requiring a redeployment to add or change a Role_Entry.

#### Acceptance Criteria

1. THE Role_Config SHALL be persisted as a flat list of Role_Entry records in a Role_Config_Table (an Amplify Gen 2 Data_Model backed by DynamoDB), where each Role_Entry SHALL specify a non-empty Role_Name that is unique within Role_Config, a non-empty display name, a non-empty Account_Label, a non-empty Role_ARN, an Operation_Scope whose value is defined in the Glossary, and an Is_Active value.
2. THE Agent SHALL retrieve Role_Config from the Role_Config_Table and SHALL hold every retrieved Role_Entry that satisfies the field requirements in Criterion 1 and whose Is_Active value is true (a "valid Role_Entry"), regardless of Account_Label or Operation_Scope, within the single Runtime for selection during Chat_Session processing.
3. IF a Role_Entry retrieved from the Role_Config_Table does not satisfy the field requirements in Criterion 1, THEN THE Agent SHALL exclude that Role_Entry from the Runtime, SHALL log an error identifying the excluded Role_Entry, and SHALL continue loading the remaining valid Role_Entry records.
4. THE Role_Config SHALL allow more than one Role_Entry whose Operation_Scope is "admin" and SHALL impose no upper limit on the count of such Role_Entry records.
5. WHEN the Agent retrieves Role_Config from the Role_Config_Table and finds zero valid Role_Entry records, THE Agent SHALL log an error indicating that no valid Role_Entry records were found, SHALL refuse to process any Chat_Session request by returning an error response indicating that no roles are configured, and SHALL continue refusing Chat_Session requests until a subsequent retrieval of Role_Config from the Role_Config_Table yields at least one valid Role_Entry.
6. WHEN the Frontend requests the list of available Role_Entry records, THE API_Route SHALL read the valid Role_Entry records currently held by the Agent (sourced from the Role_Config_Table, limited to those whose Is_Active value is true) and SHALL return to the Frontend, for each such Role_Entry, its Role_Name, display name, Account_Label, and Operation_Scope while excluding Role_ARN.
7. IF the Agent holds zero valid Role_Entry records at the time of a Frontend request, THEN THE API_Route SHALL return an empty list of Role_Entry records to the Frontend.
8. THE Agent SHALL NOT include a Role_Entry whose Is_Active value is false among the Role_Entry records offered as selection candidates via the Role_Set_Selector or any other selection mechanism, regardless of whether that Role_Entry otherwise satisfies the field requirements in Criterion 1.

### Requirement 2: セッション開始時の Role_Set 選択

**User Story:** As a user, I want to select multiple Role_Entry records via the Role_Set_Selector when starting a new chat session, mixing admin-scoped and readonly-scoped entries freely, so that I can work across several AWS accounts and permission levels within one conversation.

#### Acceptance Criteria

1. WHEN a user initiates a new Chat_Session, THE Frontend SHALL display the Role_Set_Selector component listing every Role_Entry from Role_Config, showing each entry's display name, Account_Label, and Operation_Scope.
2. THE Role_Set_Selector SHALL allow the user to select one or more Role_Entry records to form the Role_Set.
3. THE Role_Set_Selector SHALL permit a Role_Set to contain Role_Entry records whose Operation_Scope values differ, including a combination of "admin" and "readonly" entries, within the same Role_Set.
4. WHEN the user confirms a Role_Set selection containing at least one Role_Entry, THE Frontend SHALL create a new Chat_Session bound to that Role_Set.
5. IF the user attempts to confirm a Role_Set selection containing zero Role_Entry records, THEN THE Frontend SHALL keep the confirmation control disabled or non-actionable and SHALL display a validation message indicating that at least one Role_Entry must be selected before the Chat_Session can be created. THE Frontend SHALL NOT create a Chat_Session with a Role_Set containing zero Role_Entry records under any circumstance, regardless of the method by which the user attempts to bypass the confirmation control.
6. WHEN the Frontend sends a chat request within a Chat_Session, THE Frontend SHALL include the Role_Names of every Role_Entry in that Chat_Session's Role_Set as a property via CopilotKit in that request, for every chat request sent throughout the lifetime of that Chat_Session, including requests sent within a previously created Chat_Session.
7. IF Role_Config is empty or THE Frontend fails to retrieve Role_Config when a user initiates a new Chat_Session, THEN THE Frontend SHALL NOT display the Role_Set_Selector, SHALL display an error message indicating that no Role_Entry is available for selection, and SHALL prevent the Chat_Session from being created.

### Requirement 3: Role_Set のセッション内不変性

**User Story:** As a system, I want the Role_Set selected at session start to remain fixed for the lifetime of that Chat_Session, so that behavior stays predictable and a user must deliberately start a new session to change the available roles.

#### Acceptance Criteria

1. WHILE a Chat_Session is open in the Frontend, THE Frontend SHALL NOT provide any interface control that allows the user to modify the Role_Set bound to that Chat_Session.
2. WHEN a Chat_Session is created, THE Data_Model SHALL persist the Role_Names of the selected Role_Set on the Chat_Session record as a single Role_Names list. THE Data_Model SHALL NOT modify the persisted Role_Names of an existing Chat_Session record after creation.
3. THE Frontend SHALL enable a user to use a different Role_Set only by creating a new Chat_Session through the Role_Set_Selector, and SHALL NOT provide any other mechanism for changing the Role_Set of an existing Chat_Session.
4. WHEN a user selects a past Chat_Session from the Session_History_Sidebar, THE Frontend SHALL restore that Chat_Session's stored Role_Set and SHALL send its Role_Names as a property via CopilotKit on subsequent chat requests.
5. IF one or more Role_Names stored in a past Chat_Session's Role_Set do not correspond to a Role_Entry that both exists in the current Role_Config and has an Is_Active value of true, THEN THE Frontend SHALL display an indicator identifying which Role_Names are unavailable, SHALL filter the single persisted Role_Names list at runtime to the remaining Role_Names that do correspond to such a Role_Entry as the effective Role_Set for that Chat_Session going forward, and SHALL NOT modify the Role_Names persisted on the Chat_Session record. THE Data_Model SHALL continue to store the single, unfiltered Role_Names list rather than maintaining a separate list of the original persisted Role_Names and a separate list of the currently effective Role_Names. A Role_Name whose corresponding Role_Entry exists in the current Role_Config but has an Is_Active value of false SHALL be treated identically to a Role_Name that does not exist in the current Role_Config at all.
6. IF none of the Role_Names stored in a past Chat_Session's Role_Set correspond to a Role_Entry that both exists in the current Role_Config and has an Is_Active value of true, THEN THE Frontend SHALL display an error indicating that no role from the original session remains available, SHALL disable the ability to submit new chat messages within that Chat_Session, and SHALL NOT modify the Role_Names persisted on the Chat_Session record.

### Requirement 4: ツール呼び出し単位での Role_Entry の自律選択

**User Story:** As a system, I want the LLM to autonomously choose, for each tool invocation that requires AWS credentials, which Role_Entry within the session's Role_Set to use, so that a single session can operate across multiple AWS accounts and scopes without a session-wide role switch.

#### Acceptance Criteria

1. WHEN the Agent invokes a tool that requires AWS credentials (call_aws, run_script, get_presigned_url, get_tasks) AND the Session_Context's Role_Set contains two or more Role_Entry records, THE Agent SHALL expose a required Role_Name selection parameter on that tool's schema, restricted to the Role_Names present in the current Role_Set.
2. WHILE the Session_Context's Role_Set contains exactly one Role_Entry, THE Agent SHALL use that Role_Entry automatically for every credential-requiring tool call without exposing a Role_Name selection parameter.
3. WHEN a credential-requiring tool call specifies a Role_Name parameter that matches a Role_Entry in the current Role_Set, THE BeforeToolCallEvent_Hook SHALL call STS_AssumeRole using that Role_Entry's Role_ARN.
4. WHEN STS_AssumeRole returns Temporary_Credentials successfully for the selected Role_Entry, THE BeforeToolCallEvent_Hook SHALL inject those credentials into the tool execution environment (via AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN) so that the MCP_Proxy subprocess uses the assumed role's credentials for that specific tool call.
5. WHEN a tool call requires AWS credentials, THE BeforeToolCallEvent_Hook SHALL call STS_AssumeRole per such tool invocation rather than caching Temporary_Credentials across multiple tool calls, ensuring that expired credentials are never reused and that different tool calls within the same session can use different Role_Entry records without cross-contamination.
6. THE BeforeToolCallEvent_Hook SHALL derive the Role_Entry used for each STS_AssumeRole call exclusively from the Role_Name parameter and Role_Set present in that specific tool invocation's Session_Context, and SHALL NOT reuse, cache, or carry over a Role_Entry from any other tool invocation, request, or Chat_Session.
7. IF a credential-requiring tool call specifies a Role_Name parameter that does not match any Role_Entry in the current Role_Set, THEN THE BeforeToolCallEvent_Hook SHALL NOT call STS_AssumeRole, SHALL prevent execution of the underlying tool, SHALL return to the Agent an error indicating that the specified Role_Name is invalid for the current Role_Set, and SHALL leave the Session_Context's Role_Set unchanged. THE BeforeToolCallEvent_Hook SHALL apply this Criterion 7 error handling only when the Role_Name parameter is actually invalid for the current Role_Set, and SHALL NOT prevent execution or return this error for a credential-requiring tool call whose Role_Name parameter matches a Role_Entry in the current Role_Set.
8. IF STS_AssumeRole fails for the selected Role_Entry, THEN THE BeforeToolCallEvent_Hook SHALL NOT inject any credentials into the tool execution environment, SHALL prevent execution of the underlying tool, and SHALL return to the Agent an error indicating that the assume-role operation failed for that Role_Entry. THE BeforeToolCallEvent_Hook SHALL apply this Criterion 8 error handling only when STS_AssumeRole was actually attempted and failed, and SHALL NOT prevent execution of a tool call solely because STS_AssumeRole was not called.

### Requirement 5: Operation_Scope に基づくスコープ強制

**User Story:** As a system, I want scope enforcement to be evaluated against the Operation_Scope of the individual Role_Entry selected for a specific tool call, rather than a single session-wide scope value, so that a Role_Set mixing admin and readonly entries enforces the correct restriction for each call independently.

#### Acceptance Criteria

1. WHEN the Agent invokes a tool that requires AWS credentials (call_aws, run_script, get_presigned_url, get_tasks), THE BeforeToolCallEvent_Hook SHALL derive the Operation_Scope used for scope enforcement of that specific tool call from the Operation_Scope of the Role_Entry selected for that tool call, evaluated independently for each tool call.
2. THE BeforeToolCallEvent_Hook SHALL enforce Operation_Scope restrictions for that specific tool call before attempting STS_AssumeRole, rejecting disallowed tool calls without consuming an AssumeRole call.
3. WHILE the selected Role_Entry's Operation_Scope is "readonly", THE BeforeToolCallEvent_Hook SHALL reject tool calls that perform write operations (operations that create, modify, or delete an AWS resource, as distinct from read-only or describe operations) under that Role_Entry, and SHALL NOT call STS_AssumeRole for that Role_Entry as part of rejecting the tool call.
4. WHILE the selected Role_Entry's Operation_Scope is "readwrite" or "admin", THE BeforeToolCallEvent_Hook SHALL permit tool calls that perform write operations under that Role_Entry.
5. WHILE a Chat_Session's Role_Set contains both "admin" and "readonly" Role_Entry records, THE BeforeToolCallEvent_Hook SHALL independently apply Operation_Scope enforcement to each tool call based solely on the Role_Entry selected for that call, allowing write operations under an "admin" entry and rejecting write operations under a "readonly" entry within the same Chat_Session.
6. WHEN the BeforeToolCallEvent_Hook rejects a tool call due to Operation_Scope enforcement, THE BeforeToolCallEvent_Hook SHALL cancel that tool call and SHALL return an error message identifying the Role_Name and Operation_Scope that caused the rejection.

### Requirement 6: Role_Set が空、または該当ツール呼び出しに使える Role_Entry が存在しない場合のフォールバック処理

**User Story:** As a user, I want the Agent to fail clearly and safely when a Chat_Session has no usable Role_Entry for a given tool call, so that ambiguous or invalid role selection never results in an unintended AWS action.

#### Acceptance Criteria

1. WHILE the Session_Context's Role_Set is empty, WHEN a tool call that requires AWS credentials is invoked, THE BeforeToolCallEvent_Hook SHALL cancel that tool call, SHALL NOT call STS_AssumeRole, and SHALL respond indicating that the session has no role configured.
2. IF a credential-requiring tool call specifies a Role_Name parameter that does not match any Role_Entry in the current Role_Set, THEN THE BeforeToolCallEvent_Hook SHALL cancel the tool call, SHALL return an error message identifying the invalid Role_Name, and SHALL NOT call STS_AssumeRole.
3. IF the Session_Context's Role_Set contains two or more Role_Entry records AND a credential-requiring tool call omits the required Role_Name parameter, THEN THE BeforeToolCallEvent_Hook SHALL cancel the tool call, SHALL return an error message indicating that a Role_Name must be specified, and SHALL NOT call STS_AssumeRole.
4. IF any of the following holds — the Session_Context's Role_Set is empty, a credential-requiring tool call's Role_Name parameter does not match any Role_Entry in the current Role_Set, or the Session_Context's Role_Set contains two or more Role_Entry records and a credential-requiring tool call omits the required Role_Name parameter — THEN THE BeforeToolCallEvent_Hook SHALL NOT automatically select a substitute Role_Entry, retry the tool call with a different Role_Name, or fall back to any default credentials.

### Requirement 7: STS_AssumeRole 失敗時のエラー処理

**User Story:** As a developer, I want STS AssumeRole failures to be isolated to the specific Role_Entry and tool call that triggered them, consistent with the direct-role-switching design, so that one failing role does not affect the other roles available in the same Role_Set.

#### Acceptance Criteria

1. IF STS_AssumeRole fails for the Role_Entry selected in a specific tool call, THEN THE BeforeToolCallEvent_Hook SHALL cancel that tool call.
2. WHEN THE BeforeToolCallEvent_Hook cancels a tool call due to an STS_AssumeRole failure, THE BeforeToolCallEvent_Hook SHALL return an error message identifying the Role_Name and the failure category (AccessDenied, ExpiredToken, or another error).
3. THE BeforeToolCallEvent_Hook SHALL NOT automatically retry a failed STS_AssumeRole call within that same tool call, and SHALL NOT automatically substitute a different Role_Entry from the Role_Set in place of the one that failed within that same tool call.
4. WHEN an STS_AssumeRole failure occurs for one Role_Entry within a Chat_Session, THE BeforeToolCallEvent_Hook SHALL continue to permit subsequent tool calls that select a different, unaffected Role_Entry within the same Role_Set.
5. WHEN a subsequent, independent tool call selects the same Role_Entry for which STS_AssumeRole previously failed, THE BeforeToolCallEvent_Hook SHALL attempt STS_AssumeRole for that Role_Entry again rather than treating the Role_Entry as permanently unusable for the remainder of the Chat_Session.

### Requirement 8: Role_Config の画面メンテナンス

**User Story:** As an administrator, I want to create, update, and delete Role_Entry records in the Role_Config_Table through a maintenance screen, so that adding, changing, or removing an AWS role does not require redeploying the Agent.

#### Acceptance Criteria

1. THE Frontend SHALL restrict access to the Role_Config maintenance screen to users who belong to the ADMINS group.
2. IF a user who does not belong to the ADMINS group attempts to access the Role_Config maintenance screen, THEN THE Frontend SHALL deny access to that user and display an indication that the user is not authorized to view the screen.
3. WHEN an administrator submits the creation of a new Role_Entry through the Role_Config maintenance screen, THE System SHALL validate that the submitted Role_Name is unique across every Role_Entry record in the Role_Config_Table regardless of that record's Is_Active value (i.e. including records previously marked inactive under Criterion 6), and that the display name, Account_Label, Role_ARN, and Operation_Scope fields are all non-empty and, for Operation_Scope, a value defined in the Glossary, and SHALL persist the new Role_Entry to the Role_Config_Table (with Is_Active set to true) only when all such validations pass.
4. IF an administrator submits the creation of a new Role_Entry whose Role_Name duplicates the Role_Name of any existing Role_Entry record in the Role_Config_Table (whether that existing record's Is_Active value is true or false), or whose display name, Account_Label, Role_ARN, or Operation_Scope field is empty or otherwise invalid, THEN THE System SHALL reject the submission, SHALL display a validation message identifying the invalid field, and SHALL NOT persist the submitted Role_Entry to the Role_Config_Table.
5. WHEN an administrator submits an update to an existing Role_Entry through the Role_Config maintenance screen, THE System SHALL apply the same field validations described in Criterion 3 (treating the Role_Entry's own existing Role_Name as satisfying the uniqueness check) and SHALL persist the updated Role_Entry to the Role_Config_Table only when all such validations pass.
6. WHEN an administrator confirms deletion of an existing Role_Entry through the Role_Config maintenance screen, THE System SHALL mark that Role_Entry as inactive by setting its Is_Active value to false, and SHALL NOT remove that Role_Entry's record from the Role_Config_Table.
7. THE Role_Config maintenance screen SHALL enable an administrator to create, update, or delete a Role_Entry without requiring a redeployment of the Agent, such that the change becomes usable for future Chat_Session creation without the Agent being redeployed.
8. AFTER a Role_Entry has been marked inactive under Criterion 6, THE System SHALL treat that Role_Entry's Role_Name as permanently unavailable for reuse: any subsequent submission of a new Role_Entry using that same Role_Name SHALL be rejected under Criterion 4, and no operation available through the Role_Config maintenance screen SHALL restore a Role_Entry's Is_Active value from false back to true.

### Requirement 9: direct-role-switching との整合性、および multi-account-mcp-access の不採用

**User Story:** As a developer, I want this feature to build directly on the direct-role-switching foundation without reintroducing the abandoned multi-account-mcp-access approach, so that the verified single-Runtime, direct-AssumeRole architecture remains intact.

#### Acceptance Criteria

1. THE Runtime SHALL remain a single instance, identified by the single fixed Runtime ARN established by direct-role-switching.
2. THIS specification SHALL NOT introduce multiple Runtimes partitioned by Account_Label or Operation_Scope.
3. THE API_Route SHALL continue to route every chat request to the single fixed Runtime ARN established by direct-role-switching, without modification to support multiple Runtimes.
4. THE BeforeToolCallEvent_Hook SHALL continue to provision AWS credentials via direct STS_AssumeRole calls, as established by direct-role-switching.
5. THE BeforeToolCallEvent_Hook SHALL NOT adopt the mcp-proxy-for-aws Multi_Profile_Mode mechanism described in multi-account-mcp-access.
6. WHILE direct role switching (the Role_Set–based, per-tool-call Role_Entry selection mechanism defined in this Requirements Document) is active for a Chat_Session, THE Agent codebase SHALL NOT reintroduce the AWS_MCP_PROXY_PROFILES environment variable, the aws_profile tool parameter naming, or any other named environment variable, configuration key, or code identifier specific to the Multi_Profile_Mode approach documented in multi-account-mcp-access, and THE Agent SHALL prevent the Multi_Profile_Mode mechanism itself from operating for that Chat_Session.
