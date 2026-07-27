# AWS MCP エージェント接続アーキテクチャ

## 概要

本ドキュメントは、AWS MCP（Model Context Protocol）エージェントの接続アーキテクチャ、デプロイ判断、およびトラブルシューティングの知見をまとめたものです。

本システムは、ブラウザから CopilotKit 経由で AgentCore Runtime 上の Strands Agent に接続し、AWS MCP エンドポイントを通じて AWS サービスを操作するアーキテクチャです。

### コンポーネント構成

| コンポーネント | 役割 |
|---------------|------|
| CopilotKit (ブラウザ) | ユーザーインターフェース。Cognito JWT で認証 |
| copilotkitStreamingRelay (Amplify Gen 2 カスタム関数、Lambda 関数 URL) | CopilotRuntime プロキシ。SigV4 署名を付与して AgentCore に中継し、応答をストリーミングでブラウザに逐次転送 |
| AgentCore Runtime | Strands Agent の実行環境。AG-UI プロトコルでリクエストを受信 |
| mcp-proxy-for-aws | SigV4 署名付き MCP クライアント。Runtime の実行ロールで署名 |
| AWS MCP エンドポイント | AWS サービスへの MCP ゲートウェイ |

> **Note**: 以前は Next.js API Route（`/api/copilotkit`、Amplify Hosting SSR Lambda）が
> この中継処理を担っていましたが、Amplify Hosting の SSR Compute はレスポンス
> ストリーミングをサポートしないため、本番環境でのみ応答がバッファリングされる問題が
> ありました。現在は `amplify/functions/copilotkitStreamingRelay/` に定義された独立の
> Lambda 関数（Lambda 関数 URL、`InvokeMode: RESPONSE_STREAM`）が中継処理を行います。
> `route.ts` は削除済みです。詳細はリポジトリルートの
> [README.md](../README.md#新しい-lambda-関数copilotkitstreamingrelayについて) を参照してください。

---

## 接続構成

```
ブラウザ (CopilotKit + Cognito JWT)
  → copilotkitStreamingRelay Lambda 関数 URL (Amplify Gen 2 カスタム関数)
    → SigV4 署名 (copilotkitStreamingRelay 専用の実行ロール)
      → AgentCore Runtime (agents_AWS_MCP_Agent)
        → mcp-proxy-for-aws (SigV4, Runtime 実行ロール)
          → AWS MCP エンドポイント (https://aws-mcp.us-east-1.api.aws/mcp)
            → AWS サービス (S3, EC2, Lambda 等)
```

### 認証の流れ

1. ブラウザ → Cognito 認証 → JWT トークン取得
2. ブラウザ → `copilotkitStreamingRelay` の Lambda 関数 URL に Bearer トークン付きリクエスト
3. Lambda → Cognito トークンの存在を確認（ユーザー認証ゲート）
4. Lambda → 専用実行ロールの IAM 権限で SigV4 署名
5. AgentCore Runtime → Runtime 実行ロールの認証情報で AWS MCP に SigV4 接続

---

## IAM ロール構成

| ロール | 主な権限 | 用途 |
|--------|---------|------|
| copilotkitStreamingRelay 専用実行ロール（CDK が自動作成） | `bedrock-agentcore:InvokeAgentRuntime` | Lambda 関数 URL から AgentCore Runtime を呼び出す |
| Runtime 実行ロール (ApplicationAgentAWSMCPAgen-...) | `s3:*`, `ec2:Describe*`, `lambda:*` 等 | Runtime から AWS MCP 経由で AWS リソースを操作する |
| Gateway サービスロール | （現在は未使用） | Gateway 経由の接続は tools/call バグのため断念 |

> 以前は `AmplifySSRComputeRole`（Amplify Hosting のコンピューティングロール）に
> `bedrock-agentcore:InvokeAgentRuntime` を付与していましたが、中継処理の移行に伴い
> この権限は撤去済みです。`AmplifySSRComputeRole` に残っているのは `dynamodb:Scan`
> （`/api/roles` 用）のみです。

### copilotkitStreamingRelay 専用実行ロールの注意点

- Resource には `runtime-arn/*` を含めること（`amplify/functions/copilotkitStreamingRelay/resource.ts` で自動導出済み）
- AgentCore への呼び出し時に `/runtime-endpoint/DEFAULT` サフィックスがつくため、ARN 完全一致では 403 になる

```json
{
  "Effect": "Allow",
  "Action": "bedrock-agentcore:InvokeAgentRuntime",
  "Resource": "arn:aws:bedrock-agentcore:us-east-1:<ACCOUNT_ID>:runtime/agents_AWS_MCP_Agent-*/*"
}
```

---

## 環境変数

### Runtime 環境変数

| 変数 | 設定場所 | デフォルト値 | 説明 |
|------|---------|-------------|------|
| `AWS_MCP_ENDPOINT` | Runtime 環境 | `https://aws-mcp.us-east-1.api.aws/mcp` | AWS MCP エンドポイント URL |
| `AWS_MCP_REGION` | Runtime 環境 | `us-east-1` | SigV4 署名に使用するリージョン |

### Amplify Hosting / copilotkitStreamingRelay 環境変数

| 変数 | 設定場所 | 値の例 | 説明 |
|------|---------|--------|------|
| `AGENTCORE_RUNTIME_ARN` | Amplify コンソール（バックエンドビルド時に読まれる） | `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/agents_AWS_MCP_Agent-xxxxxxxxxx` | `copilotkitStreamingRelay` Lambda の環境変数、および IAM ポリシーの `Resource` の両方に使われる（`NEXT_PUBLIC_` プレフィックスなし） |
| `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` | Amplify コンソール（フロントエンドビルド時に埋め込み） | `https://xxxxxxxxxxxxxxxxxxxxxxxxxxxx.lambda-url.us-east-1.on.aws/` | `copilotkitStreamingRelay` の関数 URL。`CopilotProvider.tsx` の `runtimeUrl` が参照する |

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
- コンピューティングロール（`AmplifySSRComputeRole`）は Amplify が作成し、`dynamodb:Scan` を
  手動で付与する（`/api/roles` 用）
- `copilotkitStreamingRelay` と Runtime の実行ロールは CDK が自動作成するため手動設定は不要
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

### CopilotKit v2 の properties 受け渡し

- CopilotKit v2 は properties を `body.body.forwardedProps` に格納する（v1 の `body.properties` ではない）
- API Route で両方をフォールバック参照する実装にした
- 複数リクエストを1ターンで送るため、2回目以降は `forwardedProps` が含まれない場合がある → `_sessionHeaders` を維持する設計

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
| "An error occurred when starting the runtime" | `main.py` のインポートエラー or MCP 接続失敗 | `agentcore logs` で確認。`uv lock` 忘れ、`ModuleNotFoundError` が多い |
| "ModuleNotFoundError: No module named 'xxx'" | `pyproject.toml` に依存追加後 `uv lock` していない | `cd agents/app/AWS_MCP_Agent && uv lock` → 再デプロイ |
| "Failed to start MCP client: the client initialization failed" | AWS MCP への接続失敗（権限 or ネットワーク） | Runtime 実行ロールの権限確認。エンドポイント URL とリージョン確認 |
| 403 ACCESS_DENIED (InvokeAgentRuntime) | Amplify コンピューティングロールの権限不足 | Resource に `runtime-arn/*` を含めること（`/runtime-endpoint/DEFAULT` サフィックスがつくため） |
| "Tool invocation failed" (Gateway 経由時) | Gateway の tools/call バグ | 直接接続方式を使う（現在の実装） |
| CopilotKit で "接続先を聞かれる" | `forwardedProps` が API Route で読めていない | `body.body.forwardedProps` を参照しているか確認 |

### ログ確認コマンド

```bash
# AgentCore Runtime のログ
agentcore logs

# Amplify SSR Lambda のログ（AWS Console）
# CloudWatch → /aws/amplify/<app-id>/<branch>/compute
```

---

## セッション分離の設計考察

### 事実（確認済み）

| 項目 | 状態 | 根拠 |
|------|------|------|
| アカウント分離 | Runtime 実行ロールの IAM 権限で物理的に制御される | AWS MCP は呼び出し元の credentials をそのまま downstream に転送する（AWS Security Blog 確認済み） |
| リージョン分離 | IAM では制限困難 | AWS MCP の `call_aws` ツールは `--region` パラメータを受け付け、全リージョンのリソースにアクセス可能。IAM の `aws:RequestedRegion` 条件が AWS MCP 経由で有効かは未検証 |
| スコープ（read/write）制御 | IAM ロールレベルでのみハード制御可能 | Runtime は 1 ロールで全セッション共有。セッションごとに IAM 権限は変えられない |
| Runtime と IAM ロール | 1 Runtime = 1 IAM 実行ロール（固定） | AgentCore Runtime の仕様。per-request でロール切替不可 |
| AWS MCP の credentials 処理 | Runtime 実行ロールの credentials が AWS MCP を通じて downstream AWS サービスに渡る | AWS Security Blog "Understanding IAM for Managed AWS MCP Servers" で確認 |
| AWS MCP のリージョンアクセス | 1 つの MCP エンドポイント（us-east-1）から全リージョンのリソースにアクセス可能 | `aws s3api list-buckets` 等でリージョン横断の結果が返ることを動作確認済み |

### 考察: クロスアカウント対応パターン

#### パターン A: AssumeRole 方式（Runtime 1 つ）

```
Runtime (中央アカウント)
  → AWS MCP (中央アカウントの IAM ロール)
    → STS AssumeRole → 対象アカウントのロール
      → 対象アカウントのリソース操作
```

- **メリット**: Runtime 管理が 1 つで済む
- **課題**: AWS MCP が AssumeRole を自動的に行うか、エージェントが明示的に STS を呼ぶ必要があるかは未検証。`mcp-proxy-for-aws` は `--profile` パラメータを持つがこれは CLI のプロファイル切替であり、Runtime 内では使えない可能性がある
- **IAM 要件**: Runtime 実行ロールに `sts:AssumeRole` 権限 + 対象アカウントに信頼ポリシー

#### パターン B: アカウント別 Runtime 方式

```
UI → API Route → Runtime A (アカウント A の IAM ロール) → AWS MCP
              → Runtime B (アカウント B の IAM ロール) → AWS MCP
```

- **メリット**: IAM でのハード分離が確実。アカウント間のデータ漏洩リスクなし
- **課題**: Runtime のデプロイ・管理コスト増。セッション選択時に接続先 Runtime ARN を切り替える実装が必要
- **実装**: フロントエンドの Connection カタログに Runtime ARN を紐付け、API Route が接続先を切り替え

### 考察: スコープ制御の設計方針

#### 提案: Readonly / ReadWrite を Runtime 2 台で分離

```
Runtime (readonly)   — IAM ロール: s3:Get*, s3:List*, ec2:Describe* のみ
Runtime (readwrite)  — IAM ロール: s3:*, ec2:*, lambda:* 等（write 含む）
```

- **理由**: 1 Runtime = 1 IAM ロールの制約があるため、ハードなスコープ制御には Runtime を分けるのが最もシンプル
- **ユーザー体験**: セッション開始時に「読み取りのみ / 更新可能」を選択すると、対応する Runtime に接続される
- **実装変更**: API Route の `NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN` を 2 つ持ち（`_READONLY` / `_READWRITE`）、operationScope に応じて接続先を切り替え。SigV4 署名先の ARN を動的に変更する
- **メリット**: ハードな分離。readonly を選んだユーザーは物理的に write 操作不可能
- **コスト影響**: Runtime は invocation 時のみ課金（microVM per-session）。2 台あっても使っていない方のコストはゼロ

#### リージョン制御について

- 現時点ではリージョンのハード制御は優先度低（自アカウント内なのでリスクが限定的）
- 将来的に IAM の `aws:RequestedRegion` 条件が AWS MCP 経由で有効か検証する価値はある
- プロンプト制御で「このセッションでは us-east-1 のリソースのみ操作」と指示する方が現実的

---

## 将来の改善ロードマップ

### Phase 1（現在）: 単一 Runtime + 全権限

- 自アカウント、全リージョン、全操作
- スコープ制御なし
- 動作確認とフィードバック収集

### Phase 2: Readonly / ReadWrite の Runtime 分離

- Runtime を 2 台デプロイ（IAM ロールで read/write を分離）
- API Route で operationScope に応じて接続先を切り替え
- ユーザーはセッション開始時にスコープを選択

### Phase 3: マルチアカウント対応

- パターン A（AssumeRole）またはパターン B（アカウント別 Runtime）を検証・実装
- Connection カタログにアカウント情報を紐付け

### Phase 4: Gateway 再導入（バグ修正後）

- Gateway 経由に戻すことで以下が利用可能:
  - ツールのセマンティック検索（searchType: SEMANTIC）
  - Cedar ポリシーエンジンによるセッション単位のハード制御
  - ツールのフィルタリングと一元管理
  - Gateway 1 台で複数ターゲット（リージョン/アカウント別）を管理

---

## クロスアカウント対応の調査結果（2026年6月時点）

### 事実（公式ソースで確認済み）

| # | 事実 | 根拠 |
|---|------|------|
| 1 | AWS MCP Server は公式にクロスアカウント / クロスロールアクセスに対応している | AWS What's New (2026/06/05): "The AWS MCP Server now supports cross-account and cross-role access" |
| 2 | 仕組みは `mcp-proxy-for-aws` の `--profile` / `aws_profile` パラメータによるプロファイル切替 | mcp-proxy-for-aws README "Multi-account access" セクション |
| 3 | ツール呼び出し時に `aws_profile` を指定すると、対応するプロファイルの credentials で SigV4 署名される | AWS ドキュメント "Multi-profile support" (agent-toolkit/latest/userguide/multi-account-access.html) |
| 4 | `aws_profile` パラメータは AWS MCP Server に転送される前に strip される（MCP Server 側は単一 credentials のリクエストとして処理） | mcp-proxy-for-aws README |
| 5 | `mcp-proxy-for-aws` は `credentials` パラメータで programmatic に credentials を注入可能（boto3 credential chain の代わりに明示指定） | mcp-proxy-for-aws README "Programmatic Access" セクション |
| 6 | ローカル開発では `~/.aws/config` の assume-role プロファイル定義で実現される | AWS ドキュメント "Setting up the AWS MCP Server" |
| 7 | `call_aws` ツールは `--profile` CLI パラメータもサポートしており、プロファイルごとの credentials でコマンドを実行する | GitHub Discussion #1994 (awslabs/mcp) メンテナー回答 |

### 考察（未検証・推論）

#### Runtime 内でのクロスアカウント実現方法

ローカル開発では `~/.aws/config` にプロファイルを定義して `mcp-proxy-for-aws --profile prod dev` で切り替えるが、**AgentCore Runtime 内には AWS config ファイルがない**。Runtime 実行ロールの credentials のみが存在する。

このため、Runtime 内でクロスアカウントを実現するには以下のいずれかが必要:

| 方式 | 実現性 | 課題 |
|------|--------|------|
| A. Runtime 内に `~/.aws/config` を仕込む | △ 可能だがセキュリティリスク | credentials のハードコード or ファイルマウントが必要。ロールの assume-role チェーンは設定可能だが運用が複雑 |
| B. `aws_iam_streamablehttp_client` の `credentials` パラメータに AssumeRole 結果を渡す | △ 要検証 | `mcp-proxy-for-aws` の programmatic API がこれをサポートすると記載あり。ただしツール呼び出しごとに切り替える仕組みの実装が必要 |
| C. Runtime を分ける（アカウント/ロール別） | ◎ 最もシンプル | 各 Runtime に対応する IAM ロールを付与。フロントエンドで接続先を選択。IAM でハード分離 |
| D. `call_aws` の `--profile` パラメータを活用 | ? 要検証 | Runtime 実行ロールから target アカウントのロールを AssumeRole するプロファイルを定義できるか |

#### AssumeRole の仕組み（SwitchRole との関係）

- **STS AssumeRole**: プログラマティックに一時 credentials を取得する API。サービスロールがクロスアカウントで操作する際の標準的な方法
- **SwitchRole**: AWS Console での UI 操作名。裏側は AssumeRole と同じ
- 本システムでは AssumeRole（プログラマティック）が該当する

#### Runtime 内での AssumeRole フロー（方式 B の場合）

```
Runtime 実行ロール (アカウント A)
  → STS AssumeRole (アカウント B のロールを指定)
    → 一時 credentials 取得
      → aws_iam_streamablehttp_client(credentials=一時credentials)
        → AWS MCP → アカウント B のリソース操作
```

**前提条件**:
- アカウント B のロールにアカウント A の Runtime 実行ロールを信頼するポリシーが必要
- Runtime 実行ロールに `sts:AssumeRole` 権限が必要
- `mcp-proxy-for-aws` の `credentials` パラメータが SigV4 署名に正しく使われること（未検証）

### 結論と推奨

**短期（Phase 2）**: Readonly / ReadWrite を Runtime 2 台で分離する方式が最もシンプルで確実。

**中期（Phase 3）**: クロスアカウント対応は、まず方式 C（Runtime 分離）で実装するのが安全。方式 B（programmatic credentials）は動作検証が取れれば Runtime 管理コストを削減できる可能性がある。

**検証すべき項目**:
1. `aws_iam_streamablehttp_client(credentials=...)` で AssumeRole 結果の一時 credentials を渡して正常動作するか
2. `call_aws --profile` が Runtime 内の `~/.aws/config` なしで動作する方法があるか
3. AWS MCP の `aws:RequestedRegion` 条件キーが IAM ポリシーで有効に機能するか
