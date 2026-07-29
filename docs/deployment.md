# デプロイガイド

Web アプリとエージェント（AgentCore Runtime / Memory）は**同じ Amplify バックエンド
スタックの一部**としてデプロイされます。デプロイコマンドは 1 つだけで、Git push で
完結します。

エージェント機能を含めるかは `AGENT_ENABLED` 環境変数で切り替えます。未設定なら
Web アプリのみがデプロイされ、AgentCore のリソースは作られません。

リージョンは Amplify アプリのリージョンに揃います（コードにハードコードしていません）。
エージェント機能を使う場合は、そのリージョンで Amazon Bedrock AgentCore が利用可能で、
Bedrock のモデルアクセスが有効になっている必要があります。詳細は
[docs/architecture-aws-mcp.md](architecture-aws-mcp.md#リージョンの扱い) を参照してください。

## 全体像

```
┌─────────────────────────────────────────────────────────────┐
│ Amplify Hosting                                             │
│                                                             │
│  Next.js SSR Lambda (コンピューティングロール、/api/roles のみ)   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Amplify Gen 2 バックエンドスタック（amplify/backend.ts で配線）   │
│                                                             │
│  Cognito User Pool (ユーザー認証)                             │
│  AppSync + DynamoDB (データ / RoleConfig / ChatSession)       │
│                                                             │
│  copilotkitStreamingRelay Lambda（専用実行ロール）              │
│    Lambda 関数 URL (RESPONSE_STREAM)                        │
│    └─ 認証ゲート → SigV4 署名 ─┐                             │
│                                │                            │
│  ── AGENT_ENABLED=true のときのみ ──                          │
│  AgentCore Runtime (AG-UI)  ◀──┘                            │
│    └─ Strands Agent + ag-ui-strands（CodeZip 配布）           │
│  AgentCore Memory (会話履歴、RemovalPolicy=RETAIN)             │
│  Runtime 実行ロール                                           │
│    └─ AssumeRole → 運用者が用意した読み取り専用 / 管理者ロール    │
└─────────────────────────────────────────────────────────────┘
```

同一スタックに載っているため、以下がすべて synth 時に解決されます。**手動で ARN や
テーブル名を調べてコンソールに貼る作業はありません。**

- Runtime の `ROLE_CONFIG_TABLE_NAME` ← RoleConfig テーブルの実名
- Runtime 実行ロールの `dynamodb:Scan` の対象 ← 同テーブルの ARN
- Runtime 実行ロールの `sts:AssumeRole` の対象 ← `AWS::AccountId` から組み立て
- 中継 Lambda の `AGENTCORE_RUNTIME_ARN` / `AGENTCORE_MEMORY_ID` ← 作成した実リソース
- 中継 Lambda の `InvokeAgentRuntime` / `ListEvents` の Resource ← 同上

**認証フロー:**
1. ブラウザ → Cognito 認証 → JWT トークン取得
2. ブラウザ → `copilotkitStreamingRelay` の Lambda 関数 URL に Bearer トークン付きリクエスト
3. Lambda → Cognito JWT の署名を検証（ユーザー認証ゲート）
4. Lambda → 専用実行ロールの IAM 権限で SigV4 署名
5. Lambda → AgentCore Runtime に署名済みリクエスト送信、応答をストリーミングでブラウザに逐次転送
6. Runtime → ツール呼び出しごとに選択されたロールへ `AssumeRole` し、AWS MCP Server 経由で AWS を操作

> **Note**: CopilotKit Runtime の中継処理は、以前は Amplify Hosting の SSR Lambda
> （Next.js Route Handler `/api/copilotkit`）が担っていましたが、Amplify Hosting の
> SSR Compute はレスポンスストリーミング（`awslambda.streamifyResponse()`）を
> サポートしないため、本番環境でのみ応答がバッファリングされる問題がありました。
> 現在は `amplify/functions/copilotkitStreamingRelay/` に定義された独立の Lambda 関数
> （Lambda 関数 URL・`InvokeMode: RESPONSE_STREAM`）が中継処理を行います。

---

## 1. エージェントを使う場合の事前準備

エージェント機能を使わない場合、この章は飛ばして手順 2 に進んでください。

### 1-1. AssumeRole 対象の IAM ロールを用意する

エージェントが操作スコープ別に引き受ける IAM ロールを、**手動で**作成します。これは
CDK の管理外です（既存の運用ロールを流用できるようにするため）。

既定では次の 2 つのロール名を前提にしています（`amplify/agent/resource.ts` の
`ASSUMABLE_ROLE_NAMES`）。

| ロール名 | 想定する権限 |
|---------|-------------|
| `AgentMCPReadOnlyRole` | `ReadOnlyAccess` |
| `AgentMCPAdminRole` | `AdministratorAccess` など、必要な範囲 |

**この権限設計が操作の実効的な境界です。** 読み取り専用で使わせたいロールには、必ず
読み取り専用の権限だけを付けてください（理由は
[README のセキュリティに関する注意事項](../README.md#操作の境界を実際に守っているのは-iam-ロールの権限です)）。

信頼ポリシーには Runtime の実行ロールを Principal として指定します。実行ロールは
デプロイ時に作られるため、**先にデプロイして ARN を確認してから信頼ポリシーを設定する**
順序になります。

```bash
# デプロイ後、Runtime 実行ロールの ARN を確認する
aws iam list-roles \
  --query "Roles[?contains(RoleName, 'AwsMcpAgentRuntimeRole')].Arn" \
  --output text
```

ロール名を変える場合は `amplify/agent/resource.ts` の `ASSUMABLE_ROLE_NAMES` を
書き換えてください。アカウント ID は `Stack` から解決されるため指定不要です。

### 1-2. 配布用パッケージをビルドする

ローカルからデプロイする場合は事前に実行します。Amplify Hosting のビルド中は
`amplify.yml` の `preBuild` が自動で実行します。

```bash
./scripts/build-agent-package.sh
```

詳細は [setup.md の配布用パッケージのビルド](setup.md#配布用パッケージのビルド) を参照。

---

## 2. Amplify Hosting へのデプロイ

### 初回接続

1. AWS コンソールで Amplify を開く
2. 「新しいアプリ」→「GitHub」を選択
3. リポジトリとブランチを選択
4. ビルド設定を確認（`amplify.yml` が自動検出されます）
5. エージェント機能を使う場合、「ホスティング」→「環境変数」で `AGENT_ENABLED=true` を設定
6. デプロイ

デプロイ完了後、以下が自動作成されます。

- Cognito User Pool（ユーザー認証）
- AppSync API + DynamoDB（データ / RoleConfig / ChatSession）
- `copilotkitStreamingRelay` Lambda + 関数 URL + 専用実行ロール
- SSR Lambda + コンピューティングロール（Next.js サーバーサイド実行）
- `AGENT_ENABLED=true` の場合: AgentCore Runtime / Memory / Runtime 実行ロール

### ブランチ別デプロイ

| ブランチ | 環境 | `AGENT_ENABLED` |
|---------|------|-----------------|
| `main` | 本番 | 使うなら `true` |
| `develop` | ステージング（任意） | 使うなら `true` |

各ブランチは独立した Cognito・DynamoDB・Runtime・Memory を持ちます。リソース名は
Amplify のバックエンド識別子から作られるため（例 `AWS_MCP_Agent_main_branch`）、
同一アカウントに共存できます。詳細は [environments.md](environments.md) を参照。

### CI/CD の流れ

```
Push → GitHub Actions（lint / 型チェック）→ Amplify Hosting
                                              preBuild:  エージェントのパッケージビルド
                                              build:     pipeline-deploy（バックエンド）
                                                         next build（フロントエンド）
```

---

## 3. コンピューティングロールへの権限追加

Amplify Hosting がアプリ単位で自動作成する IAM ロール（デフォルト名
`AmplifySSRComputeRole`）に、`dynamodb:Scan` を追加します。SSR Lambda 上で動く
`GET /api/roles` が RoleConfig テーブルを読むために必要です。

このロールは Amplify Hosting サービス側が管理するアプリレベルのリソースで、
`amplify/backend.ts` の CDK スタックには含まれないため、コンソールまたは CLI で
直接付与する必要があります。

1. Amplify コンソール → アプリ →「アプリケーションの設定」→「IAM ロール」を開く
2. 「コンピューティングロール」の ARN を確認し、IAM コンソールでそのロールを開く
3. 「許可を追加」→「インラインポリシーを作成」で `dynamodb:Scan` を追加する

```bash
aws iam put-role-policy \
  --role-name AmplifySSRComputeRole \
  --policy-name RoleConfigScanAccess \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "dynamodb:Scan",
      "Resource": "arn:aws:dynamodb:<リージョン>:<ACCOUNT_ID>:table/<RoleConfig テーブル名>"
    }]
  }'
```

> **`bedrock-agentcore:InvokeAgentRuntime` はここには不要です。** この権限は
> `copilotkitStreamingRelay` 専用の Lambda 実行ロールが持ち、バックエンドの
> デプロイ時に CDK が自動付与します。

`dynamodb:Scan` がない場合、`GET /api/roles` は `AccessDeniedException` を捕捉して
空配列を返す実装のため、画面にはエラーが出ず「新規チャット」ダイアログが一瞬開いて
すぐ閉じる、という分かりにくい症状になります。

---

## 4. 環境変数の設定

Amplify コンソール → アプリ → ホスティング → 環境変数:

| キー | 値 | 説明 |
|------|-----|------|
| `AGENT_ENABLED` | `true` | エージェント機能を含める。未設定なら Web アプリのみ |
| `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` | `copilotkitStreamingRelay` の関数 URL | `amplify_outputs.json` の `custom.copilotkitRelayUrl` |
| `ROLE_CONFIG_TABLE_NAME` | RoleConfig テーブル名 | `amplify_outputs.json` の `custom.roleConfigTableName` |

後ろの 2 つはデプロイ後に確定するため、**初回はデプロイ → 値を確認 → 環境変数を設定 →
再デプロイ**の順になります。

`AGENTCORE_RUNTIME_ARN` と `AGENTCORE_MEMORY_ID` の設定は不要です（CDK が中継 Lambda に
直接配線します）。

> **`ROLE_CONFIG_TABLE_NAME` について**: Amplify Hosting は Next.js のサーバーサイドに
> コンソールの環境変数をデフォルトでは渡しません
> （[AWS 公式ドキュメント](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-environment-variables.html)）。
> `amplify.yml` のビルドコマンドで `.env.production` へ書き出す対応が入っています。

---

## 5. 動作確認

1. Amplify Hosting の URL にアクセス
2. Cognito でログイン（管理者ユーザーの作成と `ADMINS` グループへの追加が必要）
3. 管理画面から手順 1-1 で用意したロールを登録する
4. トップページで新規チャットを作成し、ロールを選んでメッセージを送信
5. AG-UI ストリーミングで応答が表示されれば成功

### トラブルシューティング

| 症状 | 原因 | 対処 |
|------|------|------|
| ロール一覧が空 / 新規チャットのダイアログがすぐ閉じる | `ROLE_CONFIG_TABLE_NAME` 未設定、またはコンピューティングロールに `dynamodb:Scan` がない | 手順 3・4 を確認 |
| 401 Unauthorized | Cognito 未ログイン | ログイン画面でサインイン |
| 500 Internal Server Error | `AGENT_ENABLED` を設定せずにデプロイした（Runtime が存在しない） | 手順 4 を確認し、バックエンドを再デプロイ |
| ツール呼び出しが `AccessDenied`（`sts:AssumeRole`） | 対象ロールの信頼ポリシーに Runtime 実行ロールが入っていない | 手順 1-1 を確認 |
| ツール呼び出しが `AccessDenied`（AWS API） | 引き受けたロールにその操作の権限がない | 意図した挙動。必要なら権限設計を見直す |
| デプロイが `Your artifact contains Python cache files` で失敗 | 古いビルド出力を使った | `./scripts/build-agent-package.sh` を再実行 |
| 過去セッションの履歴が復元されず 500 | Memory の作成に失敗している | CloudFormation スタックのイベントを確認 |

CloudWatch Logs で詳細を確認:
- 中継 Lambda: `/aws/lambda/<関数名>`
- AgentCore Runtime: `/aws/bedrock-agentcore/runtimes/<Runtime 名>-DEFAULT`
- Amplify SSR Lambda: `/aws/amplify/<app-id>/<branch>/compute`

---

## 6. 更新時のデプロイ

```bash
# エージェントのコードを変更した場合は、先にパッケージを作り直す
./scripts/build-agent-package.sh   # ローカルからデプロイする場合のみ

git push origin <ブランチ名>
```

Amplify Hosting が Git push を検知して自動ビルド・デプロイします。フロントエンド・
バックエンド・エージェントのどれを変更した場合も同じ手順です。

---

## 7. お片付け（リソース削除）

1. AWS コンソール → Amplify → アプリを削除
2. sandbox を使っていた場合は `npx ampx sandbox delete`

`copilotkitStreamingRelay`・AgentCore Runtime・Runtime 実行ロールはバックエンド
スタックの一部なので自動的に削除されます。

**AgentCore Memory は `RemovalPolicy.RETAIN` のため削除されません**（会話履歴を
守るため）。不要なら手動で削除してください。

```bash
aws bedrock-agentcore-control list-memories
aws bedrock-agentcore-control delete-memory --memory-id <ID>
```

手動で作成した `AgentMCPReadOnlyRole` / `AgentMCPAdminRole` も CDK 管理外のため、
不要になったら手動で削除してください。コンピューティングロールは Amplify が管理する
ため、ロール自体は削除しないでください。

---

## 注意事項

- 環境変数は Amplify コンソールで設定してください（シークレットをリポジトリにコミットしない）
- sandbox の Cognito と Amplify Hosting の Cognito は異なるため、sandbox 環境での
  エージェント結合テストは不可（詳細は
  [environments.md](environments.md#ローカルでできることできないこと)）
- Runtime 名 / Memory 名は Amplify のバックエンド識別子から作られます。ブランチ名を
  変えるとリソースが置き換わり、**Memory の置き換えは会話履歴の断絶を意味します**
