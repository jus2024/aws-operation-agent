# Implementation Plan: Role Set Switching

## Overview

本実装計画は、`direct-role-switching` の単一 Runtime・直接 STS AssumeRole 方式を踏襲しつつ、Role_Config の永続化先を `AGENT_ROLES` 環境変数から DynamoDB テーブル（Amplify Gen 2 Data_Model `RoleConfig`）へ移行し、セッション開始時に複数の Role_Entry（Role_Set）を選択してツール呼び出し単位で LLM が自律的に Role_Entry を選ぶモデルへ一般化するためのコーディングタスクである。Role_Entry の削除は論理削除（`isActive=false`）とし、`Role_Name` の再利用を構造的に禁止する。

design.md の Component 1〜20、Data Models、Correctness Properties（Property 1〜23）を反映している。

実装言語（設計踏襲）:
- フロントエンド / API Route: **TypeScript**（プロパティテスト = `fast-check`）
- エージェント: **Python 3.12〜3.13**（プロパティテスト = `hypothesis`）
- Amplify データモデル: **TypeScript**（`amplify/data/resource.ts`）

進め方: Amplify データモデル変更（他レイヤーの前提）→ IAM 変更（DynamoDB 読み取り権限） → エージェント（`roles/store.py` → `roles/config.py` → `context/session_context.py` → `roles/hook.py` → `roles/tool_schema.py` → `prompts/system.py` → `main.py` 結線）→ フロントエンド（純粋関数層 + PBT → API Route → コンポーネント → ページ統合）の順に進める。各タスク完了後は最も狭い範囲の検証（lint/型チェック/PBT/スモークテスト）を実施する（`testing` 方針）。各 PBT は最低 100 イテレーション、タグ `Feature: role-set-switching, Property {n}: {description}` を付し、同一ファイルを対象とする複数プロパティは 1 PBT タスクにまとめる（ファイル競合を避けるため）。

### 高感度タスク（PR レビュー必須・`security` / `repo-workflow` ルール）

- **1.1** Amplify データモデルの破壊的変更（`RoleConfig` 新規モデル追加、`ChatSession.roleName`→`roleNames` 配列化、`operationScope` フィールド削除）
- **2.1** IAM 変更: AgentCore Runtime 実行ロールへの DynamoDB `dynamodb:Scan` 権限追加（テーブル ARN 限定の最小権限）
- **4.1** セッションコンテキストのヘッダー契約変更（`X-Role-Name`→`X-Role-Names` JSON 配列、`X-Operation-Scope` 廃止）。全リクエスト共有の抽出ロジックの変更
- **5.1** `BeforeToolCallEvent` フック（`roles/hook.py`）の書き換え。全セッション共有の単一フックであり、スコープ強制・Role_Entry 選択・AssumeRole の実行順序を担う中核ロジック
- **8.1** `main.py` の結線変更（`contextvars` によるリクエストスコープ伝播、フック登録、`RoleSelectingToolWrapper` の適用箇所）
- **12.1** `/api/roles` の実装変更（DynamoDB 直接 `Scan`。`roleArn` 非公開・`isActive=true` フィルタという情報最小化境界を担う）
- **13.6** `RoleConfigManager.tsx` / `RoleConfigForm.tsx`（ADMINS 専用の Role_Config 書き込み経路。全ユーザーが選択候補として参照する Role_Config_Table への唯一の書き込み口）
- **14.1** `page.tsx` の状態マシン変更（全セッション共有のロール復元・管理者リンク表示ロジック）

---

## Tasks

- [x] 1. Amplify データモデル変更（高感度・破壊的スキーマ変更）
  - [x] 1.1 `amplify/data/resource.ts` を更新する
    - `RoleConfig` モデルを新規追加する: `name`（必須）, `displayName`（必須）, `accountLabel`（必須）, `roleArn`（必須）, `scope`（`a.ref("OperationScope").required()`）, `isActive`（`a.boolean().required().default(true)`）。認可は `allow.group("ADMINS")` のみ（`allow.authenticated()` は付与しない）
    - `ChatSession`: `roleName: a.string().required()` を `roleNames: a.string().array().required()` に置換し、`operationScope` フィールドを削除する。`ownerUserId` / `sessionName` / `startedAt` / `updatedAt` / セカンダリインデックス / `allow.owner()` は変更しない
    - 破壊的変更である旨と Migration Plan（sandbox は `amplify sandbox delete` で再作成、本番は既存 `roleName` → `roleNames: [roleName]` の手動移行または再登録のいずれかを運用者が選択）をコードコメントに明記する
    - _Requirements: 1.1, 3.2, 8.3, 8.4, 8.6_
    - **高感度**: 既存 ChatSession データ・RoleConfig の新規テーブル作成に影響する。デプロイ影響（sandbox 再作成が必要、本番は移行手順に従う）を PR に明記する
    - 検証: 型チェック（生成される `Schema` 型に `RoleConfig.isActive` が存在し、`ChatSession.roleNames` が `string[]` 型、`ChatSession.operationScope` が存在しないことを確認）。Amplify 変更はデプロイ・設定への影響を記載する（`testing` 方針）

- [x] 2. IAM 変更 — AgentCore Runtime 実行ロールへの DynamoDB 読み取り権限追加（高感度）
  - [x] 2.1 `agents/agentcore/cdk/lib/cdk-stack.ts` を更新する
    - 既存の `MCP_AGENT_ASSUMABLE_ROLE_ARNS` 定数と同じパターンで、`ROLE_CONFIG_TABLE_ARN`（プレースホルダ文字列。実際の ARN は Amplify バックエンドデプロイ後に判明するため、運用者が Amplify デプロイ後に値を確定してから CDK を再デプロイする旨をコメントに明記する）定数を追加する
    - `this.application.environments.get('AWS_MCP_Agent')` に対し、`env.runtime.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:Scan'], resources: [ROLE_CONFIG_TABLE_ARN] }))` を追加する（既存の `sts:AssumeRole` 権限追加ブロックと同じ箇所、または直後に追加する）
    - `dynamodb:PutItem` / `UpdateItem` / `DeleteItem` は付与しない（書き込みは ADMINS ユーザーが Amplify Data Model の GraphQL API 経由で行うため不要。design.md の「いずれの変更もテーブル ARN を明示的に絞った最小権限とし、書き込み権限は付与しない」を反映）
    - _Requirements: 1.2_
    - **高感度（IAM）**: 最小権限（対象テーブル ARN のみ）であることを PR で確認する。実際のテーブル ARN 反映と再デプロイは運用者タスク（下記 O2）に分離する
    - 検証: `cd agents/agentcore/cdk && npm run build`（または既存の CDK ビルドコマンド）で型チェック。実際の IAM 効果確認は AgentCore デプロイ後のスモークテストで行う

- [x] 3. Agent: Role_Config_Table アクセス層（DynamoDB 読み取り + TTL キャッシュ）
  - [x] 3.1 `agents/app/AWS_MCP_Agent/roles/store.py` を新規作成する
    - `scan_role_config_items() -> list[dict]`: boto3 DynamoDB リソースで `ROLE_CONFIG_TABLE_NAME` 環境変数が指すテーブルを `Scan` し、`LastEvaluatedKey` によるページネーションを処理して全アイテムの `dict` リストを返す
    - テーブル名未設定時は `RuntimeError` を発生させる。boto3/botocore の例外はそのまま呼び出し元（`roles/config.py`）に伝播させる（キャッチしない）
    - _Requirements: 1.1, 1.2_

  - [x] 3.2 `agents/app/AWS_MCP_Agent/roles/config.py` を変更する
    - `RoleConfig` dataclass に `account_label: str` と `is_active: bool` を追加する
    - `_parse_entry` / `_parse_items` を DynamoDB アイテム（`dict` のリスト）を入力とする実装に変更し、`name` の一意性チェック（重複時は2件目以降を除外、first occurrence wins）を追加する。`isActive` フィールドの欠落は防御的に `False` として扱う
    - データソースを `AGENT_ROLES` 環境変数の起動時一度きりのパースから、`roles/store.py` 経由の DynamoDB `Scan` + TTL キャッシュ（`ROLE_CONFIG_CACHE_TTL_SECONDS` 環境変数、デフォルト30秒）に変更する
    - `get_role_configs(now: float | None = None) -> list[RoleConfig]`: TTL 経過時のみ `store.scan_role_config_items()` を呼び直し、`is_active is True` のレコードのみを返す。読み取り失敗時は直前のキャッシュ値を維持し（一度も成功していない場合は空リスト）、エラーログを出す
    - `get_role_by_name(name)` を `get_role_configs()` ベースの実装に変更する（振る舞いは維持）
    - モジュールスコープの起動時ロード（`ROLE_CONFIGS: list[RoleConfig] = load_role_configs()`）を削除し、遅延・都度チェックの TTL キャッシュに置き換える
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.8_
    - 検証: スモークテスト + インポート確認（`testing` 方針）。既存の `roles/test_hook.py` が `roles.config` の変更後も import エラーを起こさないことを確認する

  - [ ]* 3.3 `agents/app/AWS_MCP_Agent/roles/test_store.py` を新規作成する
    - モック化した boto3 DynamoDB リソースで `scan_role_config_items()` の `Scan` 呼び出しと `LastEvaluatedKey` のページネーション処理を検証する。テーブル名未設定時に `RuntimeError` を発生させることも確認する
    - _Requirements: 1.1, 1.2_

  - [ ]* 3.4 `agents/app/AWS_MCP_Agent/roles/test_config.py` を新規作成する
    - `roles.store.scan_role_config_items` をモック化し、DynamoDB アイテムのパース（`accountLabel`・`isActive` 含む）、重複 `name` の除外（first occurrence wins）、フィールド欠落エントリの除外、`isActive=false` アイテムが `get_role_configs()` の戻り値から除外されることを検証する
    - TTL キャッシュの単体テスト: TTL 経過前は再読込しないこと、経過後は再読込すること、読み取り失敗時に直前のキャッシュ値を維持すること、一度も成功していない場合は空リストを返すことを、`now` 引数の注入で確認する
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.8_

  - [ ]* 3.5 `agents/app/AWS_MCP_Agent/roles/test_config_pbt.py` を新規作成する
    - **Property 1: Role_Config のロード — アクティブな有効エントリのみの保持と全フィールドの保存**
    - **Feature: role-set-switching, Property 1: アクティブかつ有効な Role_Entry のみを全フィールド保持して返す**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.8**
    - **Property 2: 有効かつアクティブなエントリが0件の場合は空リスト**
    - **Feature: role-set-switching, Property 2: 有効エントリ0件で空リストを返す**
    - **Validates: Requirements 1.5**
    - `hypothesis` で、整形済み/不整形（フィールド欠落・型不正・不正 scope・重複 name）アイテムを混在させた任意のリストに対し、`roles.store.scan_role_config_items` をモック化した上で `get_role_configs()` の出力が仕様どおりであることを最低100イテレーションで検証する（1プロパティ = 1 `@given` ケースとして両プロパティを同ファイル内に実装する）

- [x] 4. Agent: セッションコンテキストの Role_Set 対応（高感度）
  - [x] 4.1 `agents/app/AWS_MCP_Agent/context/session_context.py` を更新する
    - `HEADER_ROLE_NAME = "X-Role-Name"` を `HEADER_ROLE_NAMES = "X-Role-Names"` に置換する
    - `SessionContext.role_name: str | None` を `role_names: tuple[str, ...]`（空 tuple = Role_Set なし）に変更し、`operation_scope` フィールドを削除する
    - 抽出ロジック: `X-Role-Names` を JSON 配列としてパースし、各要素について `get_role_by_name`（`roles.config`）で存在確認する。存在しない要素は警告ログ付きで除外する。JSON パース失敗時は例外を投げず空 tuple とする
    - `X-Operation-Scope` の読み取り・`VALID_SCOPES` / `DEFAULT_SCOPE` の定義を削除する（スコープはツール呼び出し単位で Role_Entry から導出するため、セッションコンテキストは保持しない）
    - _Requirements: 6.1_
    - **高感度**: ヘッダー契約の変更。認証済みユーザーのリクエストにのみ正しく紐づくことを PR で確認する
    - 検証: スモークテスト + インポート確認（`testing` 方針）

  - [ ]* 4.2 `agents/app/AWS_MCP_Agent/context/test_session_context.py` を更新する
    - `X-Role-Names` が正常な JSON 配列/不正 JSON/空/欠如/一部要素が現在の Role_Config に存在しない、の各ケースで `role_names` が期待通りに解決されることを検証する
    - `X-Operation-Scope` 関連の既存テストケースを削除する
    - _Requirements: 6.1_

- [x] 5. Agent: BeforeToolCallEvent フックの Role_Set 対応書き換え（高感度）
  - [x] 5.1 `agents/app/AWS_MCP_Agent/roles/hook.py` を書き換える
    - `SessionScopeAndRoleHook._on_before_tool_call` を、セッション単位の単一 `role_name`/`scope` 判定から、ツール呼び出し単位の Role_Entry 選択判定に書き換える（design.md Component 14 のコード例に従う）
    - Role_Set が空 → 拒否（`_reject_empty_role_set`）。Role_Set が1件 → 自動選択。2件以上 → `event.tool_use["input"].pop("role_name", None)` で LLM 指定の `role_name` を取得・下流ツールへは渡さない。取得できない場合は拒否（`_reject_missing_role_name_param`）。Role_Set 内に存在しない `role_name` は拒否（`_reject_invalid_role_name`）
    - 選ばれた Role_Entry の `scope` に対し `scope.enforcement.is_allowed` を STS 呼び出しより前に適用する（拒否時は AssumeRole を呼ばない）
    - `McpClientManager.ensure_role(role_name, role_config.role_arn)` を呼び出し、失敗時は role_name + 失敗種別を含む拒否メッセージを設定する（`_reject_assume_role_failure`）
    - `current_session_context` の型が `SessionContext`（role_names 版）に追従することを確認する
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 7.5_
    - **高感度**: 全セッション共有の単一フック。スコープ強制・Role_Entry 選択・AssumeRole の順序を誤ると全セッションに影響する。PR レビューで実行順序（スコープ強制 → STS）を重点確認する
    - 検証: スモークテスト + インポート確認。既存 `roles/test_hook.py`（`_strip_gateway_prefix` 関連）が変更後も通ることを確認する

  - [ ]* 5.2 `agents/app/AWS_MCP_Agent/roles/test_hook_role_selection_pbt.py` を新規作成する
    - **Property 11: 有効な role_name の選択は正しい ARN での AssumeRole と資格情報注入を引き起こす**
    - **Feature: role-set-switching, Property 11: 有効な role_name 選択で正しい ARN の AssumeRole と資格情報注入が発生する**
    - **Validates: Requirements 4.3, 4.4**
    - **Property 13: role_name の Role_Set 内外での挙動は正確に分岐する**
    - **Feature: role-set-switching, Property 13: role_name の Role_Set 内外での許可/拒否分岐が正確**
    - **Validates: Requirements 4.7, 6.2**
    - **Property 14: AssumeRole 失敗はロール名と失敗種別を含むキャンセルを生成する**
    - **Feature: role-set-switching, Property 14: AssumeRole 失敗時のキャンセルメッセージに role_name と失敗種別を含む**
    - **Validates: Requirements 4.8, 7.1, 7.2**
    - **Property 16: 空の Role_Set はゼロ AssumeRole でキャンセルされる**
    - **Feature: role-set-switching, Property 16: 空の Role_Set はゼロ AssumeRole でキャンセルされる**
    - **Validates: Requirements 6.1**
    - **Property 17: 2件以上の Role_Set で role_name 省略時はゼロ AssumeRole でキャンセルされる**
    - **Feature: role-set-switching, Property 17: role_name 省略時はゼロ AssumeRole でキャンセルされる**
    - **Validates: Requirements 6.3**
    - **Property 18: STS 失敗時にツール呼び出し内での自動再試行・代替ロールへの切替は発生しない**
    - **Feature: role-set-switching, Property 18: 単一呼び出し内で AssumeRole の自動再試行・代替が発生しない**
    - **Validates: Requirements 7.3**
    - `hypothesis` + `pytest-asyncio` で `boto3 sts:assume_role` と `MCPClient.stop/start` をモック化し、Role_Set の組み合わせ・`role_name` パラメータの有無・妥当性・STS 成功/失敗を変えながら、上記6プロパティ（単一ツール呼び出し内の決定表）を最低100イテレーションで検証する

  - [ ]* 5.3 `agents/app/AWS_MCP_Agent/gateway/test_manager_pbt.py` を新規作成する
    - **Property 12: 役割の変化は都度追従し、他の呼び出しの役割を持ち越さない**
    - **Feature: role-set-switching, Property 12: 役割変化への都度追従、他呼び出しの role_name を持ち越さない**
    - **Validates: Requirements 4.5, 4.6**
    - **Property 15: スコープ強制はツール呼び出しごとに選ばれた Role_Entry の scope に独立に従う**
    - **Feature: role-set-switching, Property 15: スコープ強制は各ツール呼び出しの Role_Entry に独立に従う**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6**
    - **Property 19: 1つの Role_Entry での失敗は同一セッション内の他の Role_Entry を使う呼び出しに影響しない**
    - **Feature: role-set-switching, Property 19: 1つの Role_Entry の失敗は同一セッション内の他 Role_Entry に影響しない**
    - **Validates: Requirements 7.4**
    - **Property 20: 以前失敗した Role_Entry も後続の呼び出しでは再試行される**
    - **Feature: role-set-switching, Property 20: 以前失敗した Role_Entry も後続呼び出しで再試行される**
    - **Validates: Requirements 7.5**
    - `hypothesis` + `pytest-asyncio` で `roles.hook.SessionScopeAndRoleHook` と `gateway.manager.McpClientManager`（STS/subprocess をモック化）を通じ、同一セッション内での複数ツール呼び出しの系列（異なる Role_Entry の選択順、admin/readonly 混在、一部呼び出しの AssumeRole 失敗を含む）に対して上記4プロパティを最低100イテレーションで検証する

- [x] 6. Agent: role_name 動的スキーマ注入
  - [x] 6.1 `agents/app/AWS_MCP_Agent/roles/tool_schema.py` を新規作成する
    - `RoleSelectingToolWrapper(AgentTool)` を実装する（design.md Component 15 のコード例に従う）。`tool_spec` プロパティを動的化し、`current_session_context.get().role_names` の長さが2件以上のときのみ `role_name`（enum = Role_Set の Role_Names）を必須パラメータとしてスキーマに注入する。1件以下の場合はパラメータを露出しない
    - `stream()` はラップ対象の `AgentTool` にそのまま委譲する
    - _Requirements: 4.1, 4.2_
    - 検証: スモークテスト + インポート確認

  - [ ]* 6.2 `agents/app/AWS_MCP_Agent/roles/test_tool_schema_pbt.py` を新規作成する
    - **Property 10: role_name パラメータの動的スキーマ露出は Role_Set のサイズに一致する**
    - **Feature: role-set-switching, Property 10: role_name パラメータの露出は Role_Set のサイズ（0/1/2+）に一致する**
    - **Validates: Requirements 4.1, 4.2**
    - `hypothesis` で任意サイズの Role_Set（0件/1件/2件以上、Role_Name の組み合わせ含む）に対し `RoleSelectingToolWrapper.tool_spec` の `role_name` パラメータ有無・enum 内容が仕様どおりであることを最低100イテレーションで検証する。加えて Role_Set が0件/1件/2件以上の具体的な `tool_spec` の例を用いた単体アサーションを含める

- [x] 7. Agent: システムプロンプトの Role_Set 一般化
  - [x] 7.1 `agents/app/AWS_MCP_Agent/prompts/system.py` を更新する
    - `build_system_prompt` から `operation_scope: str` 単一値の前提を外し、Role_Set 全体（複数の displayName・Account_Label・scope の存在、ツール呼び出しごとに `role_name` パラメータで対象を選ぶこと）を説明する一般的な文言に変更する
    - 個々の Role_ARN やアカウント ID を埋め込まない方針は維持する
    - `_build_scope_instruction` / `_build_tools_section` / `_categorize_tools` / `_infer_category` のロジックは変更しない（呼び出し方のみ変わる可能性がある点に留意）
    - _Requirements: なし（design.md の方針記述に基づく実装補助タスク。直接対応する Acceptance Criteria はないが、Requirement 4, 5 のロール選択メカニズムをユーザーに説明可能にするための前提）_
    - 検証: スモークテスト + インポート確認

  - [ ]* 7.2 `agents/app/AWS_MCP_Agent/prompts/test_system.py` を更新する
    - 更新後の `build_system_prompt` 呼び出しでプロンプト本文に具体的な Role_ARN やアカウント ID が含まれないこと、Role_Set の一般的な説明が含まれることを検証する

- [x] 8. Agent: main.py 結線 + デプロイ設定更新（高感度）
  - [x] 8.1 `agents/app/AWS_MCP_Agent/main.py` を更新する
    - `_build_template_agent` で、`Agent(...)` 構築直後に対象4ツール名（Gateway プレフィックス込み、例: `aws___call_aws`）を `RoleSelectingToolWrapper`（`roles.tool_schema`）に差し替える（`agent.tool_registry.registry[name] = RoleSelectingToolWrapper(existing_tool)`）。`StrandsAgent.__init__` がツールリストをスナップショットする前に差し替えを行う
    - `build_system_prompt` 呼び出しから `operation_scope="admin"` 引数を削除する（7.1 の変更に追従）
    - `extract_session_context` の戻り値型変更（`role_names: tuple`）に追従する。`current_session_context.set/reset` によるリクエストスコープ伝播の構造は変更しない
    - _Requirements: 4.1, 6.1_
    - **高感度**: リクエストヘッダーの抽出と `contextvars` 設定、ツールラッパーの適用順序は認証済みリクエストのセッションコンテキストが他リクエストに漏れないことを保証する中核ロジックである。PR レビューで `finally` によるリセットの確実性とラッパー差し替えのタイミングを確認する
    - 検証: スモークテスト + インポート確認。`uvicorn` または `agentcore dev` で起動し、curl で `/invocations` に `X-Role-Names` ヘッダー（0件/1件/2件以上の JSON 配列）を変えてリクエストを送り、ツールスキーマへの `role_name` 露出有無・拒否メッセージの挙動差を確認する

  - [x] 8.2 `agents/agentcore/agentcore.json` を更新する
    - `envVars` の `AGENT_ROLES` エントリを削除し、`ROLE_CONFIG_TABLE_NAME`（プレースホルダ値。実際のテーブル名は Amplify バックエンドデプロイ後に運用者が設定）と、任意で `ROLE_CONFIG_CACHE_TTL_SECONDS` を追加する
    - `requestHeaderAllowlist` の `X-Role-Name` / `X-Operation-Scope` を `X-Role-Names` に置換する
    - _Requirements: 1.1, 6.1_
    - 検証: JSON の妥当性確認（構文チェック）。実際の値反映と再デプロイは運用者タスク（下記 O1/O3）に分離する

- [x] 9. Checkpoint - エージェントスモーク確認
  - すべてのテストが通ることを確認し、疑問があればユーザーに確認する。エージェント変更はスモークテスト + インポート確認を優先する（`testing` 方針）。`uvicorn` または `agentcore dev` で起動し、curl で `/invocations` に `X-Role-Names` の有無・要素数を変えてリクエストを送り、Role_Set 選択・スコープ強制・拒否メッセージの挙動差を確認する。

- [x] 10. フロントエンド: 純粋関数層（Role_Set 選択・復元・検証ロジック）
  - [x] 10.1 `src/lib/agent/roleSetSelection.ts` を新規作成する
    - `toggleRoleSelection(selected: Set<string>, roleName: string): Set<string>`: 指定した Role_Name の選択状態を反転した新しい `Set` を返す（Requirement 2.2, 2.3）
    - `canConfirmRoleSet(selectedRoleNames: string[]): boolean`: 選択が非空のときのみ `true`（Requirement 2.5）
    - `buildRoleSetConfirmPayload(selectedRoleNames: string[]): { roleNames: string[] } | null`: 選択が空のときは `null` を返す（design.md Component 2 のコード例に従う）
    - `canOpenRoleSetSelector(roles: RoleInfo[] | null): boolean`: `roles` が `null` または空配列のとき `false`（Requirement 2.7）
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.7_

  - [ ]* 10.2 `src/lib/agent/roleSetSelection.pbt.test.ts` を新規作成する
    - **Property 4: Role_Set 選択状態は選択操作を正確に反映する**
    - **Feature: role-set-switching, Property 4: Role_Set 選択状態がトグル操作の奇数回一致集合と等しい**
    - **Validates: Requirements 2.1, 2.2, 2.3**
    - **Property 5: Role_Set 確定は非空選択でのみ Chat_Session 作成ペイロードを生成する**
    - **Feature: role-set-switching, Property 5: 非空選択のみが Chat_Session 作成ペイロードを生成する**
    - **Validates: Requirements 2.4, 2.5**
    - **Property 7: Role_Config 取得失敗時は Role_Set_Selector を開けない**
    - **Feature: role-set-switching, Property 7: ロール取得失敗/空リストで Role_Set_Selector を開けない**
    - **Validates: Requirements 2.7**
    - `fast-check` で、任意の Role_Entry 一覧・任意のトグル操作列・任意の roles-fetch 結果（空/失敗/成功）に対し、上記3プロパティを最低100イテレーションで検証する

  - [x] 10.3 `src/lib/agent/copilotProperties.ts` を更新する
    - `buildCopilotProperties(roleName?, operationScope?)` を `buildCopilotProperties(roleNames: string[] | undefined): { roleNames: string[] } | undefined` に一般化する。`roleNames` が非空配列のときのみ `{ roleNames: [...roleNames] }` を返し、空/未指定なら `undefined` を返す。`operationScope` の送出は削除する
    - _Requirements: 2.6_

  - [ ]* 10.4 `src/lib/agent/copilotProperties.pbt.test.ts` を更新する
    - **Property 6: CopilotKit properties は Role_Set の Role_Names を一貫して含む**
    - **Feature: role-set-switching, Property 6: CopilotKit properties が Role_Names を一貫して含む**
    - **Validates: Requirements 2.6**
    - 任意の非空 `roleNames` 配列に対し、出力の `roleNames` が入力と一致し、同一入力での複数回呼び出しで結果が一貫することを最低100イテレーションで検証する

  - [x] 10.5 `src/lib/agent/useSessionRestore.ts` を更新する
    - `resolveRestoredRole`（単一ロール解決）を `resolveRestoredRoleSet(storedRoleNames: string[], availableRoles: RoleInfo[]): RoleSetRestoreResult`（`available: RoleInfo[]`, `unavailableNames: string[]`）に一般化する（design.md Component 7 のコード例に従う）。入力 `storedRoleNames` は変更しない
    - `canSendInRestoredSession(result: RoleSetRestoreResult): boolean`: `available.length > 0` のときのみ `true`
    - `RestoreResult` の判別可能ユニオン型（`resolved` / `role_unavailable`）は `RoleSetRestoreResult` 型に置換する
    - _Requirements: 3.4, 3.5, 3.6_

  - [ ]* 10.6 `src/lib/agent/useSessionRestore.pbt.test.ts` を新規作成する
    - **Property 9: 過去セッション復元は現在の Role_Config との一致/不一致を正確に分類する**
    - **Feature: role-set-switching, Property 9: 過去セッション復元の available/unavailable 分類が正確**
    - **Validates: Requirements 3.4, 3.5, 3.6**
    - 任意の `storedRoleNames` と任意の `availableRoles` に対し、`available` が交差集合、`unavailableNames` が差集合と一致すること、入力が不変であること、`canSendInRestoredSession` が `available` の非空性と一致することを最低100イテレーションで検証する

  - [x] 10.7 `src/lib/agent/chatMessagePersistence.ts` を更新する
    - `buildChatSessionCreateInput(params: { ownerUserId: string; roleNames: string[] })` に変更する（`roleName: string` → `roleNames: string[]`、`operationScope` パラメータを削除）。返り値も `roleNames: string[]` を含み `operationScope` を含まない
    - `buildChatMessageCreateInput` は変更しない
    - _Requirements: 3.2_

  - [ ]* 10.8 `src/lib/agent/chatMessagePersistence.pbt.test.ts` を新規作成する
    - **Property 8: Chat_Session の Role_Names 永続化は往復不変**
    - **Feature: role-set-switching, Property 8: ChatSession 作成入力の roleNames が往復不変**
    - **Validates: Requirements 3.2**
    - 任意の非空 `roleNames` 配列に対し、`buildChatSessionCreateInput` の出力の `roleNames` フィールドが入力と一致することを最低100イテレーションで検証する

  - [x] 10.9 `src/lib/agent/roleConfigValidation.ts` を新規作成する
    - `RoleConfigInput` / `RoleConfigValidationErrors` 型、`VALID_SCOPES` を定義する（design.md Component 19 のコード例に従う）
    - `validateRoleConfigInput(input: RoleConfigInput, existingNames: string[]): RoleConfigValidationErrors`: `existingNames` は呼び出し側が `isActive` の値に関わらず全レコードの `name`（更新時は自分自身を除く）を渡す前提の純粋関数として実装する
    - `canSubmitRoleConfig(errors): boolean`
    - `applyLogicalDelete(records: { name: string; isActive: boolean }[], targetName: string): { name: string; isActive: boolean }[]`: `targetName` に一致するレコードの `isActive` のみを `false` に変更し、他のレコードとレコード件数・`id` に相当する識別情報は変更しない新しい配列を返す（一致するレコードがない場合は変更なしで元の配列と等価な内容を返す）。design.md Property 22 の「Role_Config_Table の状態変化」を純粋関数として表現するために追加する
    - _Requirements: 8.3, 8.4, 8.5, 8.6, 8.8_

  - [ ]* 10.10 `src/lib/agent/roleConfigValidation.pbt.test.ts` を新規作成する
    - **Property 21: Role_Entry 作成・更新のバリデーションゲートは Is_Active に関わらない全レコードを対象に一意性と必須フィールドを正確に強制する**
    - **Feature: role-set-switching, Property 21: バリデーションゲートが isActive 無関係の一意性と必須フィールドを強制する**
    - **Validates: Requirements 8.3, 8.4, 8.5**
    - **Property 22: Role_Entry 削除は該当エントリを非アクティブ化するのみで Role_Config_Table のレコードを除去しない**
    - **Feature: role-set-switching, Property 22: 削除操作は該当エントリの isActive のみを false にし他は不変**
    - **Validates: Requirements 8.6**
    - **Property 23: 非アクティブ化された Role_Name は将来のバリデーションで常に重複として拒否される（再利用不可の恒久性）**
    - **Feature: role-set-switching, Property 23: 非アクティブ化された Role_Name は恒久的に重複拒否される**
    - **Validates: Requirements 8.8**
    - `fast-check` で、`validateRoleConfigInput` の一意性チェック（アクティブ/非アクティブ双方の既存名を含む）、`applyLogicalDelete` の状態遷移、および非アクティブ化された名前を用いた再作成試行の拒否を、最低100イテレーションで検証する

- [x] 11. Checkpoint - フロントエンド純粋関数の lint / 型チェック
  - すべてのテストが通ることを確認し、疑問があればユーザーに確認する。フロントエンド変更は lint + 型チェックを最優先する（`testing` 方針）。純粋関数群（`roleSetSelection.ts` / `copilotProperties.ts` / `useSessionRestore.ts` / `chatMessagePersistence.ts` / `roleConfigValidation.ts`）と PBT がすべて通ることを確認する。

- [x] 12. フロントエンド: API Route 変更（高感度）
  - [x] 12.1 `src/app/api/roles/route.ts` を更新する
    - `@aws-sdk/client-dynamodb` と `@aws-sdk/lib-dynamodb` を依存に追加する（`package.json` に固定バージョンで追加。security ルールに従い正確なバージョン範囲を用いる）
    - `AGENT_ROLES` 環境変数のパース（`parseRolesFromEnv`）を廃止し、`RoleInfo` に `accountLabel: string` を追加する
    - `toRoleInfoList(items: Record<string, unknown>[]): RoleInfo[]` を新規実装する（design.md Component 5 のコード例に従う）。`name` / `displayName` / `accountLabel` が非空文字列、`scope` が有効な値であることを検証し、不正なアイテムはスキップする。`roleArn` は構造上コピーしない
    - `GET`: 認証ゲート（401）は維持し、`docClient.send(new ScanCommand({ TableName: process.env.ROLE_CONFIG_TABLE_NAME, ProjectionExpression: "#n, displayName, accountLabel, scope", FilterExpression: "isActive = :true", ExpressionAttributeNames: { "#n": "name" }, ExpressionAttributeValues: { ":true": true } }))` で `Scan` する。失敗時は空配列 `{ roles: [] }` を返す
    - _Requirements: 1.6, 1.7, 1.8_
    - **高感度**: `roleArn` 非公開・`isActive=true` フィルタという情報最小化境界を担う。PR レビューで `ProjectionExpression`/`FilterExpression` が意図通りであることを確認する
    - 検証: 型チェック + `toRoleInfoList` の PBT（下記 12.2）

  - [ ]* 12.2 `src/app/api/roles/route.pbt.test.ts` を新規作成する
    - **Property 3: /api/roles レスポンスは accountLabel を含み roleArn を除外し isActive=false を除外する**
    - **Feature: role-set-switching, Property 3: /api/roles が accountLabel を含み roleArn を除外し isActive=false を除外する**
    - **Validates: Requirements 1.6, 1.7**
    - `fast-check` で、`roleArn` の有無・`isActive` の真偽・フィールド欠落を混在させた任意の DynamoDB 生アイテムリストに対し、`toRoleInfoList` の出力が `isActive=true` の well-formed アイテムのみを `accountLabel` 含む全フィールドで返し、`roleArn` を一切含まないことを最低100イテレーションで検証する

  - [x] 12.3 `src/app/api/copilotkit/route.ts` を更新する
    - `roleName: string | undefined` の抽出を `roleNames: string[]`（`props.roleNames`、配列でなければ空配列扱い）に変更する
    - `sessionHeaders` の構築を `X-Role-Names: JSON.stringify(roleNames)`（`roleNames.length > 0` のときのみ設定）に変更し、`X-Operation-Scope` の送出を削除する
    - `AsyncLocalStorage` によるリクエストスコープ分離の構造は変更しない
    - _Requirements: 2.6_
    - **高感度**: セッションコンテキストヘッダーの伝播ロジックの変更。認証済みユーザーのセッションコンテキストが正しいリクエストにのみ紐づくことを PR で確認する

- [x] 13. フロントエンド: コンポーネント変更
  - [x] 13.1 `src/lib/agent/useRoles.ts` を更新する
    - `RoleInfo` の型変更（`accountLabel` 追加）への追従のみ。フック自体のロジックは変更しない
    - _Requirements: 1.6_

  - [x] 13.2 `src/lib/agent/useChatSessions.ts` を更新する
    - `createSession` の入力を `{ roleNames: string[] }` に変更する（`operationScope` パラメータを削除）。`buildChatSessionCreateInput`（10.7 で変更済み）呼び出しに追従する
    - `client.models.ChatSession.create()` 呼び出しの `operationScope` キャストを削除する
    - _Requirements: 3.2_

  - [x] 13.3 `src/lib/agent/accessGates.ts` を更新する
    - `canAccessRoleConfigSettings(groups: string[]): boolean`（`groups.includes("ADMINS")`）を新規追加する。既存の `canAccessAdminControls` 等は変更しない
    - _Requirements: 8.1_

  - [x] 13.4 `src/components/agent/RoleSetSelectorDialog.tsx` を新規作成する
    - `RoleSelector.tsx` の後継。モーダルダイアログとして、各 `RoleInfo` をチェックボックス付き行（displayName + Account_Label バッジ + Operation_Scope バッジ）で表示する。admin/readonly が混在してもフィルタしない
    - 選択状態はローカル state（`Set<string>`）で管理し、`toggleRoleSelection` / `canConfirmRoleSet`（`roleSetSelection.ts`）を使って「開始」ボタンの有効/無効を制御する。0件選択時はボタン非活性 + バリデーションメッセージを表示する
    - `roles` が空または取得失敗時はダイアログを開かない（呼び出し元がエラー表示を担当。design.md Component 1 参照）
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.7_

  - [x] 13.5 `src/components/agent/SessionHeader.tsx` を更新する
    - `displayName` + `operationScope` の単一表示を、`RoleChip[]`（`name`, `displayName`, `accountLabel`, `scope`, `missing?: boolean`）の複数チップ表示に変更する（design.md Component 8 参照）
    - 各チップは既存の `SCOPE_COLORS` 配色を再利用する。`missing: true` のチップは既存の欠落インジケータースタイルを個別チップ単位で表示する
    - _Requirements: 3.5, 3.6_

  - [x] 13.6 `src/components/agent/RoleConfigManager.tsx` / `src/components/agent/RoleConfigForm.tsx` を新規作成する（高感度）
    - `RoleConfigManager`: `groups: string[]` を受け取り、`canAccessRoleConfigSettings(groups)` が `false` の場合は CRUD フォームやデータ取得を行わず「このページを表示する権限がありません」のみを描画する。`true` の場合は `generateClient<Schema>()` で `client.models.RoleConfig.list()` / `.create()` / `.update()` を呼び出す（`.delete()` は使用しない）
    - 一覧はデフォルトで `isActive=true` のみ表示し、「非アクティブなエントリを表示」トグルで `isActive=false` のレコードも表示（グレー + 「非アクティブ」バッジ）。非アクティブなレコードには編集・削除・再アクティブ化ボタンを一切表示しない
    - `RoleConfigForm`: 作成・更新共通フォーム（表示名・Account_Label・Role_ARN・Operation_Scope）。送信前に `validateRoleConfigInput`（`roleConfigValidation.ts`）でクライアントサイド検証し、フィールド単位のインラインエラーを表示する。更新時は編集対象自身の現在の `name` を `existingNames` から除外する
    - 削除操作: 確認ダイアログ（論理削除である旨の文言）を経由し、確認後は `client.models.RoleConfig.update({ id, isActive: false })` を実行する。作成・更新・削除いずれかの API 呼び出し失敗時は操作を確定させずエラーメッセージを表示する
    - `roleArn` はマスクせずそのまま表示してよい（`/api/roles` の非公開制約はこの画面には適用されない）
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_
    - **高感度**: ADMINS 専用の Role_Config_Table 書き込み経路。全ユーザーが選択候補として参照するデータへの唯一の書き込み口であり、誤った検証ロジックが全ユーザーに影響する。PR レビューで論理削除（`isActive: false` への `update`）が `.delete()` を使用していないことを重点確認する

  - [x] 13.7 `src/components/agent/RoleSelector.tsx` を削除する
    - `RoleSetSelectorDialog.tsx`（13.4）への置換が完了したため、旧単一選択コンポーネントを削除する。`src/app/page.tsx` からの参照は 14.1 で更新する
    - _Requirements: 2.1_

- [x] 14. フロントエンド: ページ統合（高感度）
  - [x] 14.1 `src/app/page.tsx` を更新する
    - `AppState` の `role_selection` 状態を削除する。認証後は直接サイドバー + メイン画面に入り、「+ 新規チャット」クリックで `RoleSetSelectorDialog`（13.4）を開く `dialog_open` 状態を追加する
    - セッション0件時の空状態表示のボタンも `RoleSetSelectorDialog` を開くように変更する
    - `handleSelectSession`（過去セッション選択）を `resolveRestoredRoleSet` / `canSendInRestoredSession`（`useSessionRestore.ts`、10.5 で変更済み）を使うロジックに変更する。`available.length > 0` なら `sessionState`（`roleNames`）を更新して送信許可、`unavailableNames` があれば部分欠落表示、`available.length === 0` なら全欠落表示 + 送信禁止に遷移する
    - `useChatSessions.createSession` の呼び出しを `{ roleNames: string[] }` に変更する
    - `CopilotProvider` への props を `roleNames={appState.roleNames}` に変更する（`operationScope` prop は削除）
    - `SessionHeader` への props を `roleChips: RoleChip[]`（13.5 で変更済み）を構築して渡すように変更する
    - 認証後常時表示の管理者向けリンクボタン（`canAccessRoleConfigSettings`、13.3）を追加し、クリックで `RoleConfigManager`（13.6）を開くパネル/モーダル切り替え状態を追加する（新規サブページは作らない、`structure` ルール）
    - _Requirements: 2.1, 2.4, 2.7, 3.1, 3.3, 3.4, 3.5, 3.6, 8.1, 8.2_
    - **高感度**: 全セッション共有の状態マシン変更と管理者リンクの表示制御。PR レビューで非 ADMINS ユーザーにリンクが表示されないことを確認する

  - [x] 14.2 `src/lib/agent/CopilotProvider.tsx` を更新する
    - `roleName?: string; operationScope?: string` プロパティを `roleNames?: string[]` に一般化する。`properties` の `useMemo` 構築ロジックを `buildCopilotProperties(roleNames)`（10.3 で変更済み）呼び出しに置換する
    - _Requirements: 2.6_

- [x] 15. Final Checkpoint - 全体統合の lint / 型チェック / スモーク確認
  - すべてのテストが通ることを確認し、疑問があればユーザーに確認する。フロントエンドは lint + 型チェック（`roleName`/`operationScope`/`AGENT_ROLES`/`parseRolesFromEnv` の残存参照がないことを確認）、エージェントはスモークテスト + インポート確認を実施する。フロントエンドとエージェントの結合テストは Amplify Hosting のデプロイ環境でのみ可能であり、本チェックポイントの対象外である（`testing` 方針）。

## Notes

- `*` 付きサブタスクは任意（テスト）。実装エージェントは `*` 付きを実装せず、`*` なしを実装する。
- 各タスクは要件番号と設計プロパティ（**Property 1〜23**）を参照する。同一ファイルを対象とする複数プロパティは1つの PBT タスクにまとめている（ファイル競合回避のため）。
- PBT ライブラリ: TS = `fast-check`、Python = `hypothesis`。各 PBT は最低 100 イテレーション、タグ `Feature: role-set-switching, Property {n}: {description}`。
- 影響レイヤー: `amplify/`（データモデル）・`agents/`（エージェント + IAM/CDK）・`src/`（API Route + フロントエンド）。レイヤー責務分離（`structure` ルール）を厳守する。
- 本計画はコーディングタスクのみを対象とする。実際の IAM ARN 反映・Amplify デプロイ・エージェントデプロイ・本番データ移行は、コード編集だけでは完結しない運用者専用タスクとして下記に分離する。

### 運用者 / デプロイ専用タスク（O 系・非コード・本計画の対象外・高感度）

以下はコーディングタスクではなく、運用者が手動で実施する（PR レビュー必須）。

- **O1. Amplify バックエンドデプロイ**: タスク 1.1（`RoleConfig` モデル + `ChatSession.roleNames`）を Amplify Hosting / sandbox にデプロイし、生成された `RoleConfig` テーブルの実際の ARN・テーブル名を取得する（**高感度**、_Requirements 1.1_）。
- **O2. AgentCore Runtime 実行ロールへの実 ARN 反映**: O1 で取得したテーブル ARN でタスク 2.1 の `ROLE_CONFIG_TABLE_ARN` プレースホルダを実値に更新し、`agentcore deploy` で CDK を再デプロイする（**高感度 / IAM**、_Requirements 1.2_）。
- **O3. Amplify Hosting コンピューティングロールへの DynamoDB 読み取り権限付与**: `docs/deployment.md` の手順3と同様の手順で、コンピューティングロールに `dynamodb:Scan`（O1 のテーブル ARN 限定）のインラインポリシーを追加する。このロールは Amplify Gen 2 の CDK スタック（`amplify/backend.ts`）が管理する対象ではなく、Amplify Hosting のコンソール/AWS CLI で手動設定する対象である（**高感度 / IAM**、_Requirements 1.6_）。
- **O4. `agentcore.json` の実値反映**: タスク 8.2 の `ROLE_CONFIG_TABLE_NAME` プレースホルダを O1 で取得したテーブル名に更新し、`agentcore deploy` する（_Requirements 1.1_）。
- **O5. 初期 Role_Entry の登録**: `RoleConfigManager`（13.6）から、少なくとも1件の Role_Entry（`isActive: true`）を作成する。登録なしでは Requirement 1.5 の「ゼロ valid Role_Entry」状態が続き、Chat_Session が作成できない。
- **O6. 本番データ移行**: 既存 `ChatSession.roleName`（単数）レコードがある場合、`roleNames: [roleName]` への手動データ移行、または全面再登録のいずれかを運用者が選択する（Migration Plan、_Requirements 3.2_）。
- **O7. Amplify / フロントエンドデプロイ**: フロントエンド変更（タスク10〜14）を Amplify Hosting へデプロイする。
- **O8. エージェントデプロイ**: `agentcore deploy` でエージェントコード（タスク3〜8）をデプロイする。
- **O9. 反映確認（Requirement 8.7）**: `RoleConfigManager` で Role_Entry を追加し、Agent を再デプロイせず `ROLE_CONFIG_CACHE_TTL_SECONDS` 経過後の新規 Chat_Session でその Role_Entry が選択可能になることを確認する。

デプロイ順序（推奨）: O1（Amplify デプロイ）→ O2・O3（IAM 権限の実値反映）→ O4（agentcore.json 反映）→ O8（エージェントデプロイ）→ O5（初期 Role_Entry 登録）→ O7（フロントエンドデプロイ）→ O6（必要な場合のみ本番データ移行）→ O9（反映確認）。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "7.1", "10.1", "10.3", "10.7", "10.9", "12.1", "13.3"] },
    { "id": 1, "tasks": ["3.2", "4.1", "7.2", "10.2", "10.4", "10.5", "10.8", "10.10", "12.2", "13.1", "13.2"] },
    { "id": 2, "tasks": ["3.3", "3.4", "3.5", "4.2", "5.1", "12.3", "13.4", "13.5", "13.6"] },
    { "id": 3, "tasks": ["5.2", "5.3", "6.1"] },
    { "id": 4, "tasks": ["6.2", "8.1", "14.2"] },
    { "id": 5, "tasks": ["8.2", "14.1", "13.7"] }
  ]
}
```
