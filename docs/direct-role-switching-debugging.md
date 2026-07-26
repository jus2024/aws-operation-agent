# direct-role-switching デバッグ記録: ツール名プレフィックス不一致

## 概要

`direct-role-switching` 仕様の実装後、`AGENT_ROLES` で Admin ロールを選択しても S3 バケット作成が一貫して失敗する問題が発生した。表面的に無関係な3つの実在するバグを順に修正しても症状は変わらず、最終的に CloudWatch Logs の実地調査から、AgentCore Gateway のツール名プレフィックス仕様と `roles/hook.py` の比較ロジックの間にあった文字列不一致が根本原因であることが判明した。

本ドキュメントは、調査の道筋と気づきの手がかりを記録し、今後同種の問題（AgentCore Gateway 経由のツール名判定、サイレントな早期リターン）に当たった際の参考とする。

---

## 1. 症状

- Admin ロールを選択したセッションで「オレゴンリージョンに `test-verification-bucket-okamoto` という S3 バケットを作成して」と依頼
- エージェントの応答:
  > 現在のセッションで使用しているIAMロールには、S3バケットを作成する権限（`s3:CreateBucket`）がありません。
  > ユーザー/ロール: `arn:aws:sts::<ACCOUNT_ID>:assumed-role/AgentCore-agents-default-ApplicationAgentAWSMCPAgen-<...>/BedrockAgentCore-<...>`
- このロールは **Runtime の実行ロール**（S3 の List/Get のみ許可）であり、AssumeRole 先の `AgentMCPAdminRole`（AdministratorAccess）ではなかった
- つまり、Admin ロールを選んでも実行ロールの権限のままツールが呼ばれていた

## 2. 調査の道筋: 3つの実在したバグ修正では解決しなかった

以下は全て実在した別のバグであり、修正自体は正しかった。しかし、いずれを直しても症状は一切変化しなかった。

| # | 修正対象 | 問題 | 対応 |
|---|---------|------|------|
| 1 | `gateway/client.py` / `gateway/manager.py` | `os.environ` への事後的な認証情報注入は、既に起動済みのサブプロセスには反映されない（OS はサブプロセス起動時に環境を一度だけキャプチャする） | `StdioServerParameters(env=...)` で起動時に認証情報を渡す方式に変更。ロール変更時は `McpClientManager.ensure_role()` が `stop()` → `_transport_callable` 再割り当て → `start()` でサブプロセスを再構築する設計に変更 |
| 2 | `src/app/api/copilotkit/route.ts` | モジュールスコープの `_sessionHeaders` 変数は、同時実行中の複数リクエスト間で競合状態になり得る | `AsyncLocalStorage` によるリクエストスコープの分離に置換 |
| 3 | `agents/agentcore/agentcore.json` | AgentCore Runtime はデフォルトでカスタムヘッダー（`X-Role-Name`, `X-Operation-Scope`）を許可しておらず、サイレントに破棄する | `requestHeaderAllowlist: ["X-Role-Name", "X-Operation-Scope"]` を追加し `agentcore deploy` |

3つとも個別にデプロイ・確認したが、ユーザーの再試験結果は毎回「同じ失敗でした」。エラー文言も、AssumeRole 先の権限不足ではなく、**Runtime 実行ロールの権限不足**を示す AWS 自身の AccessDenied のままだった。

## 3. 根本原因: AgentCore Gateway のツール名プレフィックスと文字列不一致

CloudWatch Logs を実地調査したところ、決定的な手がかりが2つ見つかった。

### 手がかり1: 期待するログが一切出ていない

リクエスト処理のログを時系列で見ると、`session_context.extracted`（ヘッダー受信）の直後に `Tool #1: aws___call_aws` が記録されるが、その間に `roles.hook` / `gateway.manager` のログが一切出ていなかった。つまり、`SessionScopeAndRoleHook._on_before_tool_call()` 内の AssumeRole 呼び出しに到達するコードパス自体が実行されていなかった。

### 手がかり2: エラー文言が自分のコードのものと一致しない

ユーザーに返っていたエラー文言（「現在のIAMロールには s3:CreateBucket 権限がありません」）は、`roles/hook.py` が返す拒否メッセージ（例: `"Tool '...' requires AWS credentials, but this session has no role configured"`）のどれとも一致しなかった。これは、**こちらの拒否ロジックではなく、AWS 自身が返した AccessDenied を LLM が自然文で説明していた**ことを意味していた。

### 決定的な原因

CloudWatch ログに記録された実際のツール名は次の通り:

```
Tool #1: aws___call_aws
```

一方、`roles/hook.py` の判定ロジックは次のようになっていた（修正前）:

```python
AWS_CREDENTIAL_TOOLS = frozenset({"call_aws", "run_script", "get_presigned_url", "get_tasks"})

if tool_name not in AWS_CREDENTIAL_TOOLS:
    # Tool does not require AWS credentials -- allow through unmodified
    return
```

**AgentCore Gateway は、Gateway 経由で公開する全てのツール名に `{target_name}___{tool_name}`（アンダースコア3つ区切り）というプレフィックスを付与する。** そのため実際のツール名は `aws___call_aws` であり、これは `"call_aws"` という文字列と一致しない。結果として `not in AWS_CREDENTIAL_TOOLS` が常に `True` となり、`McpClientManager.ensure_role()`（STS AssumeRole + サブプロセス再構築）を呼び出す分岐そのものに一度も到達していなかった。

これは、前述の3つの修正が効果を発揮する**一歩手前**でずっと処理をスキップさせていた、もう一段深い（そして実装当初から存在していた）バグだった。

## 4. 修正内容

`roles/hook.py` に Gateway プレフィックスを正規化するヘルパーを追加し、比較の前に必ずこれを通すようにした。

```python
def _strip_gateway_prefix(tool_name: str) -> str:
    """AgentCore Gateway の `{target}___{tool}` プレフィックスを除去する。

    rpartition("___") で最後の区切りで分割するため、tool_name 自体に
    `___` が複数含まれていても Gateway の命名規則（target がプレフィックス）
    と一致する。
    """
    _prefix, separator, remainder = tool_name.rpartition("___")
    if not separator:
        return tool_name
    return remainder
```

判定側は、比較にのみ正規化後の名前を使い、ログ・ユーザー向けメッセージには元の `tool_name` を使う:

```python
# 比較にのみ正規化後の名前を使う。ログ/拒否メッセージは元の tool_name のまま。
if _strip_gateway_prefix(tool_name) not in AWS_CREDENTIAL_TOOLS:
    return
```

`roles/test_hook.py` に、今回のバグをそのまま再現する回帰テストを追加（`aws___call_aws` が正規化後に `AWS_CREDENTIAL_TOOLS` と一致すること、正規化前は一致しないことを明示的に検証）。

## 5. 検証結果

`agentcore deploy`（Runtime version 20 → 21）後、CloudWatch Logs で以下のログが初めて記録された:

```
gateway.manager.assuming_role
gateway.manager.rebuilding_subprocess
gateway.manager.rebuilt
```

ユーザーの再試験でも S3 バケット作成に成功。これにより「AGENT_ROLES で選択したロールに応じて STS AssumeRole → mcp-proxy-for-aws サブプロセスに正しい認証情報を渡す」という direct-role-switching の根幹メカニズムが実機で動作することを確認した。

## 6. 今後への教訓

1. **AgentCore Gateway 経由のツール名は必ず `{target}___{tool}` の形式でプレフィックスされる。** Gateway 経由で公開されるツールを名前で判定するコード（許可リスト、拒否リスト、ログのフィルタなど）は、比較前に必ずプレフィックスを正規化すること。ローカル開発（`agentcore dev` や直接 stdio 接続）ではプレフィックスが付かないため、ローカルでは差異が再現しない。
2. **エラーメッセージの「一致確認」は調査の初期段階で行う。** ユーザーに返っていたエラー文言と、自分のコードが返すはずの拒否メッセージを比較するだけで、「まだ自分のコードに到達していない」という事実に早く気づけた。症状が同じでも、エラーの出所（自コードの拒否 vs AWS 自身の応答）を区別することが、的外れな修正を繰り返さないための最短の判断材料になる。
3. **「ログが出ていないこと」自体が強い手がかり。** 期待するコードパスのログが一切出ていない場合、実装の不具合よりも「そのコードパスに到達していない」可能性を先に疑う。診断ログを追加する前に、既存のログの有無を確認するだけで根本原因の位置を大きく絞り込めることがある。
4. **表面的な修正を積み重ねる前に、一度実機ログで「どこまで到達しているか」を可視化する。** 今回は3つの独立したバグを直しても症状が変わらなかったことが、より深いバグの存在を示す重要なシグナルだった。同じ症状が続く場合は、個々の修正の正しさを検証するだけでなく、処理フロー全体のどの時点で処理が止まっているかを再確認するべきだった。
