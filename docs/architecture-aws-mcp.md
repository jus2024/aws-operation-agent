# AWS MCP エージェント接続アーキテクチャ

## 概要

本ドキュメントは、AWS MCP（Model Context Protocol）エージェントの現在の接続構成、
IAM ロール構成、環境変数、既知の制約、およびトラブルシューティングをまとめたものです。

本システムは、ブラウザから CopilotKit 経由で AgentCore Runtime 上の Strands Agent に接続し、
セッションで選択されたロールに `sts:AssumeRole` してから AWS MCP エンドポイントを通じて
AWS サービスを操作します。

### コンポーネント構成

| コンポーネント | 役割 |
|---------------|------|
| CopilotKit (ブラウザ) | ユーザーインターフェース。Cognito JWT で認証 |
| copilotkitStreamingRelay (Amplify Gen 2 カスタム関数、Lambda 関数 URL) | CopilotRuntime プロキシ。SigV4 署名を付与して AgentCore に中継し、応答をストリーミングでブラウザに逐次転送 |
| AgentCore Runtime | Strands Agent の実行環境。AG-UI プロトコルでリクエストを受信 |
| AgentCore Memory | 会話履歴の保存先 |
| mcp-proxy-for-aws | SigV4 署名付き MCP クライアント。セッションで選択されたロールの一時認証情報で署名 |
| AWS MCP エンドポイント | AWS サービスへの MCP ゲートウェイ |

> **Note**: 以前は Next.js API Route（`/api/copilotkit`、Amplify Hosting SSR Lambda）が
> この中継処理を担っていましたが、Amplify Hosting の SSR Compute はレスポンス
> ストリーミングをサポートしないため、本番環境でのみ応答がバッファリングされる問題が
> ありました。現在は `amplify/functions/copilotkitStreamingRelay/` に定義された独立の
> Lambda 関数（Lambda 関数 URL、`InvokeMode: RESPONSE_STREAM`）が中継処理を行います。
> `route.ts` は削除済みです。詳細はリポジトリルートの
> [README.md](../README.md#中継-lambdacopilotkitstreamingrelayについて) を参照してください。

---

## 接続構成

```
ブラウザ (CopilotKit + Cognito JWT)
  → copilotkitStreamingRelay Lambda 関数 URL (Amplify Gen 2 カスタム関数)
    → SigV4 署名 (copilotkitStreamingRelay 専用の実行ロール)
      → AgentCore Runtime (AWS_MCP_Agent_<バックエンド識別子>)
        → sts:AssumeRole (セッションで選択されたロール)
          → mcp-proxy-for-aws (SigV4, AssumeRole で得た一時認証情報)
            → AWS MCP エンドポイント (https://aws-mcp.us-east-1.api.aws/mcp)
              → AWS サービス (S3, EC2, Lambda 等)
```

Runtime 名は Amplify のバックエンド識別子から導出されます（例: `main` ブランチなら
`AWS_MCP_Agent_main_branch`）。命名規則は
[docs/environments.md](environments.md#リソース名の付き方) を参照してください。

### 認証の流れ

1. ブラウザ → Cognito 認証 → JWT トークン取得
2. ブラウザ → `copilotkitStreamingRelay` の Lambda 関数 URL に Bearer トークン付きリクエスト
3. Lambda → Cognito トークンの存在を確認（ユーザー認証ゲート）
4. Lambda → 選択されたロール名を `X-Role-Names`、Cognito の `sub` を
   `X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId` としてヘッダーに付与
5. Lambda → 専用実行ロールの IAM 権限で SigV4 署名
6. Runtime → ヘッダーのロール名を DynamoDB のロール定義テーブルで解決し、
   対象ロールに `sts:AssumeRole`
7. Runtime → AssumeRole で得た一時認証情報で AWS MCP に SigV4 接続

---

## IAM ロール構成

| ロール | 主な権限 | 作成者 | 用途 |
|--------|---------|--------|------|
| copilotkitStreamingRelay 専用実行ロール | `bedrock-agentcore:InvokeAgentRuntime` | CDK が自動作成 | Lambda 関数 URL から AgentCore Runtime を呼び出す |
| Runtime 実行ロール | `sts:AssumeRole`（対象ロールに限定）、`dynamodb:Scan`（ロール定義テーブル）、`bedrock:InvokeModel*`、CloudWatch Logs / メトリクス | CDK が自動作成 | Runtime 自身の動作と、操作用ロールへの AssumeRole |
| `AgentMCPReadOnlyRole` / `AgentMCPAdminRole` | AWS リソースへの読み取り / 管理権限 | **手動作成** | AssumeRole 先。実際の AWS 操作はこの権限で行われる |
| Amplify のコンピューティングロール | `dynamodb:Scan`（ロール定義テーブル） | **Amplify Hosting のアプリ設定で指定**（新規アプリでは自分で作成して割り当てる） | Next.js SSR の `/api/roles` がロール一覧を返すため |

AssumeRole 先のロール名は `amplify/agent/resource.ts` の `ASSUMABLE_ROLE_NAMES` に定義されており、
Runtime 実行ロールの `sts:AssumeRole` はこの 2 つに限定されます。対象ロール側の信頼ポリシーに
Runtime 実行ロールの ARN を追加する作業は手動です（[docs/deployment.md](deployment.md) 参照）。

### copilotkitStreamingRelay 専用実行ロールの注意点

- Resource には `runtime-arn/*` を含めること（`amplify/functions/copilotkitStreamingRelay/resource.ts` で自動導出済み）
- AgentCore への呼び出し時に `/runtime-endpoint/DEFAULT` サフィックスがつくため、ARN 完全一致では 403 になる

```json
{
  "Effect": "Allow",
  "Action": "bedrock-agentcore:InvokeAgentRuntime",
  "Resource": "arn:aws:bedrock-agentcore:<REGION>:<ACCOUNT_ID>:runtime/AWS_MCP_Agent_main_branch-*/*"
}
```

---

## リージョンの扱い

リージョンはコードにハードコードしていません。2 系統あり、独立しています。

| 対象 | どのリージョンになるか |
|------|----------------------|
| Cognito / AppSync / DynamoDB / 中継 Lambda / AgentCore Runtime / Memory | **Amplify アプリのリージョン**。すべて同一スタックに作られる |
| Bedrock のモデル | 同上（`AWS_REGION` から推論プロファイルのプレフィックスを解決。`us-*` は `us.`、それ以外は `global.`） |
| AWS MCP エンドポイント | **`us-east-1` 固定**（既定値）。デプロイ先とは無関係 |

中継 Lambda はリージョンを 2 か所で使います。どちらも実行環境の `AWS_REGION`
（= Amplify のデプロイ先）と Runtime ARN から解決します。

- AgentCore への SigV4 署名リージョン: 送信先ホスト
  `bedrock-agentcore.<region>.amazonaws.com` から取り出す。ホストは Runtime ARN から
  組み立てるため、署名リージョンと呼び出し先が食い違わない
- DynamoDB / AgentCore Memory の SDK クライアント: `AWS_REGION` を使う

AWS MCP エンドポイントを `us-east-1` に固定しているのは、これが AWS MCP という
サービス自身のエンドポイントであり、デプロイ先とは別物だからです。1 つの
エンドポイントから全リージョンのリソースを操作できるため、別リージョンに
デプロイしても変更は不要です。変えたい場合は `AWS_MCP_ENDPOINT` /
`AWS_MCP_REGION` を `amplify/agent/resource.ts` の `environmentVariables` に
追加してください。

> **前提**: デプロイ先のリージョンで Amazon Bedrock AgentCore が利用可能である
> 必要があります（`us-east-1` / `us-west-2` / `ap-northeast-1` / `ap-southeast-2` /
> `eu-central-1` / `eu-west-1` などで利用可能）。あわせて、そのリージョンで
> Bedrock のモデルアクセスを有効化してください。

---

## 環境変数

### Runtime 環境変数

| 変数 | 設定場所 | 値 | 説明 |
|------|---------|-----|------|
| `ROLE_CONFIG_TABLE_NAME` | `amplify/agent/resource.ts`（CDK が実テーブル名を解決） | 自動 | ロール定義テーブル名 |
| `ROLE_CONFIG_CACHE_TTL_SECONDS` | `amplify/agent/resource.ts` | `30` | ロール定義のキャッシュ TTL |
| `AGENTCORE_MEMORY_ID` | `amplify/agent/resource.ts`（CDK が同一スタックの Memory から解決） | 自動 | 会話イベントの記録先。未設定だと `memory/session.py` が Memory を使わず、履歴復元が空になる |
| `AWS_MCP_ENDPOINT` | 既定は `agents/app/AWS_MCP_Agent/main.py` のコード内 | `https://aws-mcp.us-east-1.api.aws/mcp` | AWS MCP エンドポイント URL。上書きする場合は `resource.ts` の `environmentVariables` に追加する |
| `AWS_MCP_REGION` | 同上 | `us-east-1` | SigV4 署名に使用するリージョン |

### copilotkitStreamingRelay / フロントエンド環境変数

| 変数 | 設定場所 | 説明 |
|------|---------|------|
| `AGENT_ENABLED` | Amplify コンソール（バックエンドビルド時に読まれる） | `true` のブランチでのみ AgentCore Runtime / Memory を作成し、以下 2 つを自動配線する |
| `AGENTCORE_RUNTIME_ARN` | **自動配線**（`amplify/backend.ts`） | 同一スタック内の Runtime ARN を Lambda 環境変数と IAM ポリシーの `Resource` に流し込む。手動設定は不要 |
| `AGENTCORE_MEMORY_ID` | **自動配線**（`amplify/backend.ts`） | 同一スタック内の Memory ID |
| `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` | Amplify コンソール（フロントエンドビルド時に埋め込み） | `copilotkitStreamingRelay` の関数 URL。`CopilotProvider.tsx` の `runtimeUrl` が参照する。関数 URL は 1 回目のデプロイ後に確定するため、値の設定と再ビルドが必要 |
| `ROLE_CONFIG_TABLE_NAME` | Amplify コンソール | Next.js SSR の `/api/roles` が参照するテーブル名 |

---

## デプロイ手順

AgentCore Runtime / Memory は Amplify バックエンドスタックの一部
（`amplify/agent/resource.ts`）なので、デプロイは 1 系統です。

```bash
# 配布用パッケージのビルド（ローカルからデプロイする場合のみ）
./scripts/build-agent-package.sh

git push origin <ブランチ名>
```

- Git push で自動デプロイ（フロントエンド + `amplify/backend.ts` の全リソース。
  `AGENT_ENABLED=true` のブランチでは AgentCore Runtime / Memory も含む）
- Amplify Hosting のビルドでは `amplify.yml` の `preBuild` が配布用パッケージを作る
- 配布方式は direct code deployment（CodeZip）。コンテナビルドと ECR は不要
- `copilotkitStreamingRelay` と Runtime の実行ロールは CDK が自動作成するため手動設定は不要
- コンピューティングロールは手動で作成してアプリに設定し、`dynamodb:Scan` を付与する
  （`/api/roles` 用。手順は [README.md](../README.md#3-コンピューティングロールを設定する) 参照）
- 環境変数の変更後は再ビルドが必要

新しい依存を追加したら、先に `uv.lock` を更新してください。配布用パッケージは
このロックファイルから作られます。

```bash
cd agents/app/AWS_MCP_Agent
uv add <package-name>       # uv.lock も更新される
cd ../../..
./scripts/build-agent-package.sh
```

---

## 既知の制約と回避策

### AgentCore Gateway の tools/call バグ

- **症状**: `tools/list` は成功するが `tools/call` が "Tool invocation failed" で失敗
- **原因**: Gateway が MCP ターゲットへのツール呼び出し中継に失敗する既知の問題
- **回避策**: Gateway を経由せず、Runtime から直接 `mcp-proxy-for-aws` で AWS MCP に SigV4 接続
- **参考**: https://github.com/awslabs/agentcore-samples/issues/809

```python
# 現在の実装（直接接続）
mcp_client = build_aws_mcp_client(
    endpoint=AWS_MCP_ENDPOINT,
    region=AWS_MCP_REGION,
)
agent = Agent(model=load_model(), tools=[mcp_client])
```

### AWS MCP エンドポイントのリージョン

- `us-west-2` では Gateway からの接続が "Apache transport request failed" で失敗
- `us-east-1` では正常動作
- Runtime からの直接接続は `us-east-1` のみ検証済み

### ロール切替は MCP サブプロセスの再起動を伴う

- 認証情報はサブプロセス起動時の環境（`StdioServerParameters(env=...)`）で渡すため、
  起動後に `os.environ` を書き換えても反映されない
- セッションのロールが変わると `McpClientManager.ensure_role()` が
  `stop()` → トランスポート再割り当て → `start()` でサブプロセスを作り直す

### AWS MCP のツール名にはプレフィックスがつく

- ツール名は `aws___call_aws` のようにプレフィックス付きで届く
- 認証情報を要する対象ツールの判定は、正規化した名前で比較する
  （ログと拒否メッセージには元の名前をそのまま使う）

### CopilotKit v2 の properties 受け渡し

- CopilotKit v2 は properties を `body.body.forwardedProps` に格納する（v1 の `body.properties` ではない）
- 中継 Lambda で両方をフォールバック参照する
- 1 ターンで複数リクエストが飛ぶため、リクエストごとのセッションヘッダーは
  `AsyncLocalStorage`（`sessionHeadersStorage`）で分離する。モジュールスコープの変数に
  持たせると並行リクエスト間で競合する

### Runtime の環境変数は CDK が唯一の源泉

- `update-agent-runtime` で環境変数を追加すると、既存の変数が上書きされる（マージではない）。
  そのためコンソールや CLI で直接足した値は、次のデプロイで失われる
- 現在は `amplify/agent/resource.ts` の `environmentVariables` が唯一の定義箇所なので、
  この問題は起きない。Runtime に値を渡したい場合はここに追加する

### Runtime 起動時の MCP 接続

- Strands Agent に MCPClient を `tools` として渡すと、Agent 構築時に即座に接続を試行する
- 接続に失敗すると Runtime 起動自体が失敗する（microVM が立ち上がらない）
- `startup_timeout=60` に設定しているが、接続先が不正だとタイムアウトまで待ってから失敗する

---

## トラブルシューティング

| 症状 | 原因 | 対処 |
|------|------|------|
| 504 Gateway Timeout | Runtime 起動失敗 or 処理タイムアウト | CloudWatch Logs 確認 |
| "An error occurred when starting the runtime" | `main.py` のインポートエラー or MCP 接続失敗 | Runtime のログを確認。`uv lock` 忘れによる `ModuleNotFoundError` が多い |
| "ModuleNotFoundError: No module named 'xxx'" | `pyproject.toml` に依存追加後 `uv lock` していない | `cd agents/app/AWS_MCP_Agent && uv lock` → 再デプロイ |
| "Failed to start MCP client: the client initialization failed" | AWS MCP への接続失敗（権限 or ネットワーク） | AssumeRole 先ロールの権限確認。エンドポイント URL とリージョン確認 |
| 403 ACCESS_DENIED (InvokeAgentRuntime) | 中継 Lambda の実行ロールの権限不足 | Resource に `runtime-arn/*` を含めること（`/runtime-endpoint/DEFAULT` サフィックスがつくため） |
| AWS 操作が実行ロールの権限不足で失敗する | AssumeRole に到達していない、または対象ロールの信頼ポリシーに Runtime 実行ロールが無い | Runtime のログで `gateway.manager` の行と、エラー中の `assumed-role/...` の名前を確認する |
| ロール一覧が空でチャットを開始できない | ロール定義テーブルが空、またはコンピューティングロールに `dynamodb:Scan` が無い | 管理画面からロールを登録する。`/api/roles` の応答を確認する |
| "Tool invocation failed" (Gateway 経由時) | Gateway の tools/call バグ | 直接接続方式を使う（現在の実装） |

### ログ確認コマンド

```bash
# AgentCore Runtime のログ
aws logs tail /aws/bedrock-agentcore/runtimes/<Runtime ID>-DEFAULT --follow --region <REGION>

# 中継 Lambda のログ
aws logs tail /aws/lambda/<copilotkitStreamingRelay の関数名> --follow --region <REGION>
```

ロググループ名は次のコマンドで確認できます。

```bash
aws logs describe-log-groups \
  --log-group-name-prefix /aws/bedrock-agentcore/runtimes/AWS_MCP_Agent \
  --query 'logGroups[].logGroupName' --output text --region <REGION>
```

> **Note**: `amazon.opentelemetry.distro...otlp_aws_log_record_exporter` の
> `Failed to export logs batch code: 400, reason: (The specified log stream does not exist.`
> は ADOT のテレメトリ送信側のエラーで、エージェントの処理には影響しません。
