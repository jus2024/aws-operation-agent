# AWS 運用アシスタント（AWS Amplify Gen 2 + AgentCore）

[![CI - Web App](https://github.com/jus2024/aws-operation-agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jus2024/aws-operation-agent/actions/workflows/ci.yml)
[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-blue.svg)](LICENSE)

AWS Amplify Gen 2 で構築した業務 Web アプリケーションに、AWS リソースを操作できる
AI エージェントを組み込んだサンプルアプリケーションです。ユーザーはブラウザのチャット
画面から自然言語で AWS リソース（S3、EC2、CloudFormation など）を問い合わせ・操作でき、
エージェントは AWS MCP Server 経由でユーザーが選択した IAM ロールの権限内でのみ動作します。

> **Note**: これはテンプレート/サンプル実装です。本番環境に導入する前に、IAM ロールの
> 権限設計・監査ログ・エラーハンドリングを自身のセキュリティ要件に合わせて見直してください。

## できること

- チャット画面から自然言語で AWS リソースを問い合わせ・操作する（例:「昨日作った S3 バケットを教えて」）
- セッションごとに、利用する IAM ロール（Role_Set）を複数選択できる（例: 読み取り専用ロール + 管理者ロールを同時に選択し、エージェントが呼び出しごとに適切なロールを選ぶ）
- ロールごとに操作スコープ（読み取り専用 / 読み書き / 管理者）を持つ。実際に操作を拒否するのは AssumeRole 先の IAM ロールの権限であり、スコープはその手前の補助的な抑止として働く（詳細は [操作の境界を実際に守っているのは IAM ロールの権限です](#操作の境界を実際に守っているのは-iam-ロールの権限です)）
- チャットセッションの履歴が保存され、サイドバーから過去のセッションを再開できる
- 管理者（Cognito の `ADMINS` グループ）は、利用可能なロールの一覧を画面から追加・編集・無効化できる

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Next.js（App Router） + TypeScript |
| バックエンド | AWS Amplify Gen 2（Cognito / AppSync / DynamoDB） |
| エージェント UI | CopilotKit（`@copilotkit/react-core/v2`） + AG-UI プロトコル |
| エージェント | Python 3.12〜3.13 / Strands Agents SDK + `ag-ui-strands` |
| エージェント実行基盤 | Amazon Bedrock AgentCore Runtime |
| AWS 操作 | AWS MCP Server（Model Context Protocol） |
| エージェントのデプロイ | Amplify Gen 2 の CDK（`amplify/agent/resource.ts`）+ direct code deployment |
| ホスティング | Amplify Hosting |

## アーキテクチャ概要

```
ブラウザ (CopilotKit + Cognito 認証)
  → copilotkitStreamingRelay Lambda 関数 URL
    (Amplify Gen 2 カスタム関数、InvokeMode: RESPONSE_STREAM)
    → SigV4 署名（この Lambda 専用の実行ロール）
      → AgentCore Runtime (AG-UI プロトコル、text/event-stream)
        → BeforeToolCallEvent フックが選択済みロールで AssumeRole
          → AWS MCP Server 経由で AWS サービスを操作
```

- ブラウザは Cognito で認証し、`copilotkitStreamingRelay`（Amplify Gen 2 のカスタム関数として
  定義された Lambda 関数 URL、認証なし・`InvokeMode: RESPONSE_STREAM`）を経由してのみ
  エージェントにアクセスできます。ブラウザから AgentCore Runtime に直接アクセスすることは
  ありません（SigV4 署名・Cognito Bearer トークン検証はこの Lambda 内でのみ行われます）。
  以前は Next.js の Route Handler（`src/app/api/copilotkit/route.ts`）がこの中継処理を担って
  いましたが、Amplify Hosting の SSR Compute は AWS Lambda のレスポンスストリーミング
  （`awslambda.streamifyResponse()`）を有効化しない仕様上の制約があり、AgentCore Runtime からの
  `text/event-stream` レスポンスが本番環境でのみバッファリングされてしまう問題があったため、
  中継処理を独立した Lambda 関数（Function URL、`RESPONSE_STREAM`）に切り出しました。
  `route.ts` は削除済みです（詳細は [新しい Lambda 関数（`copilotkitStreamingRelay`）について](#新しい-lambda-関数copilotkitstreamingrelayについて) を参照）。
- **AgentCore Runtime と Memory は Amplify バックエンドスタックの一部**です
  （`amplify/agent/resource.ts`、`AGENT_ENABLED=true` のときのみ作成）。同一スタックに
  載っているため、RoleConfig テーブル名・Runtime ARN・Memory ID・IAM ポリシーの Resource が
  すべて synth 時に解決され、手動で ARN を調べて環境変数に設定する作業がありません。
  Runtime へは Docker 不要の
  [direct code deployment（CodeZip）](https://aws.amazon.com/blogs/machine-learning/iterate-faster-with-amazon-bedrock-agentcore-runtime-direct-code-deployment/)
  で配布します。
- エージェントはセッションで選択されたロール（Role_Set）の中から、ツール呼び出しごとに
  適切な IAM ロールを選び `sts:AssumeRole` を実行します。ロールの ARN や AWS アカウント ID は
  エージェントの応答（LLM への入力）に一切露出しません。
- セッションのメタデータ（セッション名・更新日時・選択したロール）は DynamoDB
  （`ChatSession`）に保存され、Cognito の owner ベース認可で他ユーザーからアクセスできません。
  一方、会話の**発言本文**は DynamoDB ではなく AgentCore Memory に一本化されており
  （`actor_id` = Cognito `sub` と `session_id` でスコープ）、過去セッションの履歴は Memory
  からの読み出しで復元します（詳細は後述の
  [AgentCore Memory ベースの会話履歴について](#agentcore-memory-ベースの会話履歴について) を参照）。

## ディレクトリ構成

```
src/                          # フロントエンド（Next.js App Router）
  app/page.tsx                # メイン画面（サイドバー + チャット）
  app/api/roles/               # ロール一覧 API Route（RoleConfig を認証済みユーザーに返す）
  app/sample/                  # Amplify Gen 2 テンプレートの参考実装（Todo リスト）
  components/agent/           # ロール選択ダイアログ、チャット UI、ロール管理画面
  lib/agent/                  # セッション管理・ロール解決・永続化などの純粋関数モジュール（CopilotProvider.tsx を含む）
amplify/                      # Amplify Gen 2 バックエンド定義（Cognito / Data モデル / カスタム関数）
  functions/copilotkitStreamingRelay/  # CopilotKit Runtime 中継処理（Lambda 関数 URL、ストリーミング対応）
  agent/resource.ts           # AgentCore Runtime / Memory / 実行ロールの定義
agents/                       # エージェント本体（Web アプリ層は含まない）
  app/AWS_MCP_Agent/           # Strands Agent + AG-UI サーバー
scripts/                      # 配布用パッケージのビルドスクリプト
docs/                         # 詳細ドキュメント（セットアップ・デプロイ・アーキテクチャ）
.kiro/                        # Kiro ワークスペース設定（steering / specs / skills）
.github/                      # CI ワークフロー
```

> **Note**: `src/app/api/copilotkit/route.ts`（旧 CopilotKit Runtime API Route）は削除済みです。
> 中継処理は `amplify/functions/copilotkitStreamingRelay/` に移動しました（理由は後述の
> [新しい Lambda 関数（`copilotkitStreamingRelay`）について](#新しい-lambda-関数copilotkitstreamingrelayについて) を参照）。

---

## クイックスタート

### 前提条件

- Node.js 20 以上、npm
- AWS アカウントと認証情報（`aws configure` 設定済み）
- エージェント機能を試す場合: [uv](https://docs.astral.sh/uv/)（Docker は不要）

### Web アプリを動かす

```bash
git clone https://github.com/<your-account>/<your-repo>.git
cd <your-repo>
npm ci
cp .env.example .env.local
```

ターミナルを2つ開いて:

```bash
# ターミナル 1: Amplify sandbox 起動（初回は数分かかります）
npx ampx sandbox

# ターミナル 2: 開発サーバー起動
npm run dev
```

`http://localhost:3000` を開き、Cognito でサインアップ/サインインすると、
「新規チャット」から利用可能なロールを選んでチャットを開始できます
（ロール自体は後述の手順で登録が必要です）。

`http://localhost:3000/sample` は Amplify Gen 2 テンプレートの参考実装（Todo リスト）です。
自分のプロジェクトを始める際は削除して構いません（詳細は [サンプルの除去](#サンプルの除去) を参照）。

セットアップの詳細は [docs/setup.md](docs/setup.md) を参照してください。

---

## エージェントを動かす（デプロイが必要）

エージェント機能（AgentCore Runtime / Memory）は **Amplify バックエンドスタックの一部**
としてデプロイされます。別のデプロイコマンドはありません。`AGENT_ENABLED=true` を設定して
通常どおりデプロイすれば、AgentCore のリソースが一緒に作られます。

同一スタックに載っているため、テーブル名・アカウント ID・Runtime ARN・Memory ID はすべて
synth 時に解決されます。**手動で ARN を調べてコンソールに貼る作業はありません。**

ローカルではエージェント単体の起動確認（`uvicorn`）のみ可能で、フロントエンドとの結合
テストは Amplify Hosting のデプロイ環境で行います（SigV4 署名に中継 Lambda 専用の実行
ロールが必要なため）。

### 1. 配布用パッケージをビルドする

AgentCore Runtime へは
[direct code deployment（CodeZip）](https://aws.amazon.com/blogs/machine-learning/iterate-faster-with-amazon-bedrock-agentcore-runtime-direct-code-deployment/)
でデプロイします。CDK はディレクトリを zip して S3 に上げるだけなので、Linux arm64 向けに
依存を展開したディレクトリを事前に作ります。

```bash
./scripts/build-agent-package.sh
```

- Docker は不要です（クロス解決なので macOS や x86 のマシンでも実行できます）
- 依存は `agents/app/AWS_MCP_Agent/uv.lock` から解決されるため再現可能です
- 出力は `agents/app/AWS_MCP_Agent/.build/`（約 130MB、`.gitignore` 対象）
- Amplify Hosting のビルド中は `amplify.yml` の `preBuild` が自動実行します

### 2. `AGENT_ENABLED` を有効にしてデプロイする

Amplify Hosting の場合は、コンソール →「ホスティング」→「環境変数」で
`AGENT_ENABLED=true` を設定して Git push します。

ローカルの sandbox で試す場合はこうします。

```bash
AGENT_ENABLED=true npx ampx sandbox
```

デプロイ後、作られたリソースの識別子は `amplify_outputs.json` に出力されます。

```bash
cat amplify_outputs.json | jq .custom
{
  "copilotkitRelayUrl": "https://xxxxxxxx.lambda-url.us-west-2.on.aws/",
  "roleConfigTableName": "RoleConfig-xxxxxxxxxxxxxxxxxxxxxxxxxx-NONE",
  "agentCoreRuntimeArn": "arn:aws:bedrock-agentcore:...:runtime/AWS_MCP_Agent_main_branch-xxxxxxxxxx",
  "agentCoreMemoryId": "AWS_MCP_AgentMemory_main_branch-xxxxxxxxxx"
}
```

`agentCoreRuntimeArn` と `agentCoreMemoryId` は確認用です。中継 Lambda には CDK が直接
配線するため、環境変数として設定する必要はありません。

Runtime 名 / Memory 名は Amplify のバックエンド識別子から作られるので（`AWS_MCP_Agent_main_branch`
など）、同一アカウントに複数のブランチ環境を共存させられます。詳細は
[docs/environments.md](docs/environments.md#リソース名の付き方) を参照してください。

> **Memory の削除保護**: AgentCore Memory は会話履歴（発言本文の唯一の正）を保持するため
> `RemovalPolicy.RETAIN` を設定しています。Amplify アプリを削除しても Memory は残ります。
> 不要になったら手動で削除してください。

### 3. AssumeRole 対象の IAM ロールを準備する

エージェントが `AssumeRole` する対象の IAM ロールを、操作スコープ別に用意します
（例: 読み取り専用ロールに `ReadOnlyAccess`、管理者ロールに必要な権限をアタッチ）。
これらは CDK の管理外です（既存の運用ロールを流用できるようにするため）。

既定では次の 2 つのロール名を前提にしています（`amplify/agent/resource.ts` の
`ASSUMABLE_ROLE_NAMES`）。名前を変える場合はこの定数を書き換えてください。アカウント ID は
`Stack` から解決されるため指定不要です。

| ロール名 | 想定する権限 |
|---------|-------------|
| `AgentMCPReadOnlyRole` | `ReadOnlyAccess` |
| `AgentMCPAdminRole` | `AdministratorAccess` など、必要な範囲 |

> **この権限設計が操作の実効的な境界です。** 読み取り専用で使わせたいロールには、必ず
> 読み取り専用の権限だけを付けてください（理由は
> [操作の境界を実際に守っているのは IAM ロールの権限です](#操作の境界を実際に守っているのは-iam-ロールの権限です)）。

#### Runtime の実行ロールを確認する

信頼ポリシーに指定する Principal は、デプロイ時に作られる Runtime の実行ロールです。
手順 2 のデプロイ後に確認します。

```bash
aws iam list-roles \
  --query "Roles[?contains(RoleName, 'AwsMcpAgentRuntimeRole')].Arn" \
  --output text
```

複数の環境をデプロイしている場合は複数出るので、対象のスタック名（`amplify-<namespace>-<name>-<type>-`）
で見分けてください。以下、この ARN を `<RUNTIME_EXECUTION_ROLE_ARN>`、ロール名部分を
`<RUNTIME_EXECUTION_ROLE_NAME>` として説明します。

#### 3-A. 同一アカウントの場合（追加のコード変更・再デプロイ不要）

追加したいロールが Runtime と同じ AWS アカウントにある場合、**そのロールの信頼ポリシー
（Trust Policy）に実行ロールを Principal として追加するだけ**で有効になります。
`ASSUMABLE_ROLE_NAMES` に名前が入っていれば、CDK 側の変更も再デプロイも不要です。

これは AWS IAM の仕様によるものです。同一アカウント内であれば、ターゲットロールの
信頼ポリシー（リソースベースポリシー）が Principal を明示的に許可していれば、
呼び出し元（実行ロール）側のアイデンティティベースポリシーに `sts:AssumeRole` の許可が
なくても `AssumeRole` は成功します（[IAM ロールを引き受ける（AWS ドキュメント）](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use.html)）。

手順:

1. IAM コンソールでロールを新規作成する（または、このアプリ用に用意済みの既存ロールを開く）
2. 「信頼関係」タブ →「信頼ポリシーを編集」を開き、以下を設定する
   （`<ACCOUNT_ID>` と `<RUNTIME_EXECUTION_ROLE_NAME>` を実際の値に置き換える）

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "AWS": "arn:aws:iam::<ACCOUNT_ID>:role/<RUNTIME_EXECUTION_ROLE_NAME>"
         },
         "Action": "sts:AssumeRole"
       }
     ]
   }
   ```

3. ロールに必要な権限をアタッチする（例: 読み取り専用なら `ReadOnlyAccess`）
4. ロール名が `ASSUMABLE_ROLE_NAMES` に含まれていない場合は、`amplify/agent/resource.ts` に
   追記して再デプロイする
5. 後述の「5. ロールを登録する」に進み、画面からこのロールの ARN・表示名・操作スコープを登録する

#### 3-B. クロスアカウントの場合（コードの変更 + 再デプロイが必要）

追加したいロールが Runtime とは**別の AWS アカウント**にある場合、3-A の信頼ポリシー
だけでは不十分です。AWS STS の `AssumeRole` は、呼び出し元（実行ロール）の
アイデンティティベースポリシーと、ターゲットロールの信頼ポリシーの**両方**が許可して
いる必要があり、この「両方必須」の原則はクロスアカウントでは省略されません
（3-A で説明した同一アカウント内の暗黙的な許可の仕組みが働かないためです）。

手順:

1. **ターゲットアカウント側**: ロールを作成し、信頼ポリシーで実行ロールを Principal として
   許可する（内容は 3-A の手順 2 と同じ）

2. **Runtime 側（このリポジトリ）**: `amplify/agent/resource.ts` の実行ロールに、
   クロスアカウントのロール ARN への `sts:AssumeRole` を追加する。
   `ASSUMABLE_ROLE_NAMES` はアカウント内のロール名を前提にしているため、別アカウントの
   ARN はフルパスで指定する必要がある

   ```ts
   executionRole.addToPolicy(
     new iam.PolicyStatement({
       actions: ["sts:AssumeRole"],
       resources: ["arn:aws:iam::<クロスアカウントID>:role/<ロール名>"],
     })
   );
   ```

3. バックエンドを再デプロイする（`git push` または `AGENT_ENABLED=true npx ampx sandbox`）

4. 後述の「5. ロールを登録する」に進み、画面からこのロールの ARN・表示名・操作スコープを登録する

> **3-A と 3-B で手順が違う理由**: `sts:AssumeRole` の許可判定は、原則として呼び出し元の
> アイデンティティベースポリシーとターゲット側の信頼ポリシーの両方が必要です。ただし
> 同一アカウント内に限り、信頼ポリシーがアカウント内の Principal を明示的に許可していれば、
> 呼び出し元側の許可は暗黙的に不要とみなされます。クロスアカウントではこの暗黙的な許可が
> 働かないため、実行ロール側のポリシーへの追記と再デプロイが必須になります。

### 4. 環境変数を設定して再デプロイする

手動設定が必要な環境変数は 3 つだけです。うち 2 つはデプロイ後に値が確定するため、
**初回はデプロイ → 値を確認 → 設定 → 再デプロイ**の順になります。

Amplify コンソール →「ホスティング」→「環境変数」:

| キー | 値 |
|------|-----|
| `AGENT_ENABLED` | `true`（手順 2 で設定済み） |
| `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` | `amplify_outputs.json` の `custom.copilotkitRelayUrl` |
| `ROLE_CONFIG_TABLE_NAME` | `amplify_outputs.json` の `custom.roleConfigTableName` |

`ROLE_CONFIG_TABLE_NAME` は `GET /api/roles`（`src/app/api/roles/route.ts`）が DynamoDB を
`Scan` する際に読むテーブル名です。`NEXT_PUBLIC_` プレフィックスを付けないでください
（サーバーサイドの Route Handler でのみ使用するため、ブラウザに露出させる必要がありません）。
エージェント（Runtime）側の同名の環境変数は CDK が同じテーブルから自動設定するため、
**両者がずれることはありません**。

あわせて、コンピューティングロール（`AmplifySSRComputeRole`）に `dynamodb:Scan` を追加する
必要があります（下記を参照）。

> **重要**: Amplify Hosting は、Next.js のサーバーサイド（Route Handler を含む）に対して、
> コンソールで設定した環境変数をデフォルトでは渡しません（ビルド時のシークレット漏洩を
> 防ぐための仕様。
> [AWS 公式ドキュメント](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-environment-variables.html)）。
> `NEXT_PUBLIC_` プレフィックス付きの変数はビルド時に自動的にバンドルへ埋め込まれるため
> 問題になりませんが、`ROLE_CONFIG_TABLE_NAME` はサーバーサイド専用のため、`amplify.yml` の
> ビルドコマンドで明示的に `.env.production` へ書き出す必要があります（このリポジトリの
> `amplify.yml` には既に対応する行が入っています）。この設定が抜けると、コンソールで
> 環境変数を設定していても `GET /api/roles` は `process.env.ROLE_CONFIG_TABLE_NAME` が
> `undefined` のまま DynamoDB `Scan` を呼び出して失敗します（画面上は「新規チャット」
> ダイアログが一瞬開いてすぐ閉じる、という分かりにくい症状になります）。
#### コンピューティングロールへの権限追加について

「コンピューティングロール」は Amplify Hosting がアプリ単位で自動作成する IAM ロール
（デフォルト名 `AmplifySSRComputeRole`）で、SSR Lambda（Next.js の Route Handler、
現在は `/api/roles` のみ）が実行時に使う実行ロールです。これは **`amplify/backend.ts` の
CDK スタック（Cognito / AppSync / DynamoDB / `copilotkitStreamingRelay` を定義する
バックエンドスタック）には含まれません**。Amplify Hosting サービス側が管理するアプリ
レベルのリソースであり、CDK からは参照・変更できないため、権限の追加は AWS コンソール
または AWS CLI で直接行う必要があります。

> **`bedrock-agentcore:InvokeAgentRuntime` はここには追加しないでください**:
> この権限は `copilotkitStreamingRelay` 専用の Lambda 実行ロールが持ち、
> Amplify バックエンドのデプロイ時に CDK が自動的に付与します（次の
> [新しい Lambda 関数（`copilotkitStreamingRelay`）について](#新しい-lambda-関数copilotkitstreamingrelayについて) を参照）。
> コンピューティングロールが必要とする権限は `dynamodb:Scan`（`/api/roles` 用）のみです。

> **`npx ampx sandbox` との違い**: sandbox はローカルマシンの AWS 認証情報
> （`aws configure` で設定した IAM ユーザー）でバックエンド（Cognito / AppSync /
> DynamoDB / `copilotkitStreamingRelay`）だけをデプロイする仕組みで、コンピューティング
> ロールは関与しません。そのため sandbox 環境ではこの権限不足に気づきにくく、
> Amplify Hosting にデプロイして初めて表面化することがあります。

権限を追加する手順（AWS コンソールの場合）:

1. Amplify コンソール → アプリ →「アプリケーションの設定」→「IAM ロール」を開く
2. 「コンピューティングロール」の ARN（例: `AmplifySSRComputeRole`）を確認し、
   IAM コンソールでそのロールを開く
3. 「許可を追加」→「インラインポリシーを作成」で、以下の権限を追加する

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "dynamodb:Scan",
         "Resource": "arn:aws:dynamodb:<リージョン>:<ACCOUNT_ID>:table/<ROLE_CONFIG_TABLE_NAME の値>"
       }
     ]
   }
   ```

   AWS CLI の場合:

   ```bash
   aws iam put-role-policy \
     --role-name AmplifySSRComputeRole \
     --policy-name RoleConfigScanAccess \
     --policy-document '{
       "Version": "2012-10-17",
       "Statement": [{
         "Effect": "Allow",
         "Action": "dynamodb:Scan",
         "Resource": "arn:aws:dynamodb:<リージョン>:<ACCOUNT_ID>:table/<ROLE_CONFIG_TABLE_NAME の値>"
       }]
     }'
   ```

`dynamodb:Scan` 権限がない場合、`GET /api/roles` は DynamoDB の `AccessDeniedException` を
サーバー側で捕捉し空配列 `{ roles: [] }` を返す実装のため、画面にはエラーが表示されず、
「新規チャット」ダイアログが一瞬開いてすぐ閉じるという分かりにくい症状になります
（原因調査は Amplify Hosting のサーバーログ、または CloudWatch Logs を確認してください）。

### 新しい Lambda 関数（`copilotkitStreamingRelay`）について

CopilotKit Runtime の中継処理（認証ゲート・SigV4 署名・セッションヘッダー伝播・AgentCore
Runtime への転送）は、Next.js の Route Handler ではなく、`amplify/functions/copilotkitStreamingRelay/`
に定義された独立の Lambda 関数（Amplify Gen 2 の `defineFunction` カスタム CDK オーバーライド）
として実装されています。

- **目的**: Amplify Hosting の SSR Compute（Next.js の Route Handler を実行する Lambda 統合）は
  AWS Lambda のレスポンスストリーミング（`awslambda.streamifyResponse()`）を有効化しないため、
  AgentCore Runtime からの `text/event-stream` レスポンスが本番環境でのみバッファリングされ、
  完了後に一括で返される問題がありました。この Lambda は Node.js マネージドランタイム上で
  ネイティブに `awslambda.streamifyResponse()` を使い、**Lambda 関数 URL**
  （`InvokeMode: RESPONSE_STREAM`）として公開することで、この制約を回避します。
- **デプロイフロー**: 既存の Amplify Hosting のデプロイフロー（Git push → 自動ビルド、
  `npx ampx pipeline-deploy`）にそのまま統合されています。`amplify/backend.ts` の
  `defineBackend({ auth, data, copilotkitStreamingRelay })` に含まれるため、新しい CDK スタックや
  別のデプロイコマンドは不要です。ローカル開発では `npx ampx sandbox` でこの Lambda も
  一緒にデプロイされます。
- **環境変数**: 手動設定が必要なのは
  `NEXT_PUBLIC_COPILOTKIT_RELAY_URL`（`CopilotProvider.tsx` の `runtimeUrl` が参照する
  この Lambda の関数 URL、フロントエンドのビルド時に読まれる）だけです。

  | 変数 | 供給元 |
  |------|--------|
  | `AGENTCORE_RUNTIME_ARN` | `amplify/agent/resource.ts` が作成した Runtime の ARN（`backend.ts` で配線） |
  | `AGENTCORE_MEMORY_ID` | 同 Memory の ID（同上） |
  | `CHAT_SESSION_TABLE_NAME` | `backend.data.resources.tables["ChatSession"]` |
  | `COGNITO_USER_POOL_ID` / `COGNITO_USER_POOL_CLIENT_ID` | `backend.auth.resources.userPool` / `userPoolClient` |

  いずれも `defineBackend({...})` 実行後にしか揃わないリソースなので、`resource.ts` の
  `defineFunction((scope) => ...)` コールバックではなく `backend.ts` で配線しています。
  Cognito の 2 つは Memory 読み出しエンドポイントの JWT 署名検証（後述）に使います。

  `copilotkitStreamingRelay` の関数 URL は `npx ampx sandbox` / `pipeline-deploy` の実行後、
  `amplify_outputs.json` の `custom.copilotkitRelayUrl` で確認できます。この値を
  `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` にコピーしてください（`.env.example` を参照）。

  > **CORS について**: `copilotkitStreamingRelay` の CORS は Lambda 関数 URL の
  > 設定（`resource.ts` の `cors: { allowedOrigins: ["*"] }`）が唯一の源泉として
  > 処理しています。AWS が OPTIONS プリフライトを自動応答し、全ての実レスポンスにも
  > 自動で `Access-Control-Allow-Origin: *` ヘッダーを付与します。CopilotKit_Runtime
  > 側の CORS ヘッダー付与は完全に無効化してあります（`cors: { origin: [] }`）。
  > これにより、以前発生していた「CopilotKit_Runtime と関数 URL の両方が CORS ヘッダーを
  > 付与し、ブラウザが重複ヘッダーで CORS エラーにする」不具合が解消されます。
  > `allowedOrigins: ["*"]` を使う理由は、認証が Bearer トークン（Cognito JWT）で
  > 行われており、CORS のオリジン制限に依存した認可設計ではないためです。
  > ローカル開発（localhost:3000）・本番 Amplify Hosting・preview 環境など
  > 全てのオリジンが追加設定なしで動作します。
- **新規に必要な IAM 権限**: `copilotkitStreamingRelay` 専用の Lambda 実行ロール（CDK が自動作成）に、
  `bedrock-agentcore:InvokeAgentRuntime` を許可するインラインポリシーが付与されます
  （`Resource` は作成した Runtime の ARN に限定されます。`AGENT_ENABLED` が有効でない場合は
  Runtime が存在しないため、ポリシー自体が付与されません）。
  これは以前 `AmplifySSRComputeRole` に付与していた同名の権限を引き継いだものです。
  **`AmplifySSRComputeRole` に `bedrock-agentcore:InvokeAgentRuntime` を追加する必要はありません**
  （前述の「コンピューティングロールへの権限追加について」を参照）。

  さらに、AgentCore Memory ベースの会話履歴復元（後述）のために、同じ Lambda 実行ロールに
  以下の2つの読み取り専用権限が追加で付与されます（いずれも書き込み系アクションを含みません）。

  - `bedrock-agentcore:ListEvents`（Memory から過去の会話イベントを読み出す。`Resource` は
    作成した Memory の ARN に限定されます）
  - `ChatSession` DynamoDB テーブルへの `grantReadData`（読み取り専用）。Memory 読み出し前の
    actor_id 所有権チェックのために `ChatSession.ownerUserId` を `GetItem` で参照します
    （`amplify/backend.ts` で配線）
- **`src/app/api/copilotkit/route.ts` の削除について**: この Route Handler は削除済みです。
  中継ロジック（`extractBearerToken` / `extractCognitoSub` / `sigv4Fetch` / セッションヘッダー構築）は
  変更せずに `copilotkitStreamingRelay` に移植されており、フロントエンド（`CopilotProvider.tsx`）は
  `runtimeUrl` をこの関数 URL に向けて接続します。削除の理由は上記の「目的」で説明した
  Amplify Hosting の SSR Compute のストリーミング制約です。

### AgentCore Memory ベースの会話履歴について

チャットの**発言本文**（ユーザー発言・アシスタント応答）の正のデータソースは、DynamoDB の
`ChatMessage` から AgentCore Memory に一本化されています。以前は CopilotKit の `onNewMessage`
購読でメッセージを DynamoDB に事後書き込みしていましたが、この経路は重複書き込みの温床だった
ため廃止しました。`ChatSession`（セッション名・更新日時・選択したロール等のメタデータ）は
従来どおり DynamoDB に保持します。

- **`ChatMessage` への読み書きの廃止**: 発言本文を DynamoDB に書き込む経路・DynamoDB から
  読み出して履歴を復元する経路は、いずれも使用を終了しました。発言本文の唯一の正は
  AgentCore Memory（`actor_id` = Cognito `sub` と `session_id` = `ChatSession.id` でスコープ）です。
- **Memory 読み出しエンドポイント**: 過去セッションの履歴は、`copilotkitStreamingRelay` に
  追加した専用経路 `GET {functionUrl}/memory/events?sessionId=...` から読み出します。この経路は
  `bedrock-agentcore:ListEvents` を呼び出し、`ListEvents` の `nextToken` を全ページ辿って
  （API のデフォルト `maxResults` は 20 件のため）セッションの完全なトランスクリプトを取得し、
  イベントを古い順（`eventTimestamp` 昇順）に整列して `{ messages }` として1回で返します。
  フロントエンド（`src/lib/agent/useSessionMemoryRestore.ts`）はセッション選択時にそのセッション
  分のみを遅延取得します（全セッションを一括取得しません）。ツール呼び出し（`toolUse`）・
  実行結果（`toolResult`）を含むイベントからはツールカードも再構築されます。
- **新規に必要な IAM 権限**: `bedrock-agentcore:ListEvents`（読み取り専用）。上記
  [新しい Lambda 関数（`copilotkitStreamingRelay`）について](#新しい-lambda-関数copilotkitstreamingrelayについて)
  の IAM 権限の説明を参照してください。
- **Memory 読み出しの認可（actor_id なりすまし対策）**: このエンドポイントは、Bearer トークンの
  `sub`（actor_id）を信頼する前に、`aws-jwt-verify` で Cognito JWT の**署名を実際に検証**します
  （以前は署名検証なしで JWT を base64 デコードしていました）。関数 URL の認証タイプが `NONE`
  であるため、この署名検証が、攻撃者が偽造トークンで他ユーザーの `actor_id` を主張して会話履歴を
  読み出すことを防ぐ要となります。検証に必要な `COGNITO_USER_POOL_ID` /
  `COGNITO_USER_POOL_CLIENT_ID` は `amplify/backend.ts` が Cognito リソースから自動配線します。
  加えて、Memory を読み出す前に `ChatSession.ownerUserId`（DynamoDB、`grantReadData` で付与された
  読み取り権限で取得）と認証済みユーザーの `actor_id` を照合し、不一致の場合は `ListEvents` 自体を
  発行せず 403 を返します。
- **長期記憶（Semantic）の有効化・保持期間 365 日**: `amplify/agent/resource.ts` が定義する
  Memory リソース（環境ごとに 1 つ、例 `AWS_MCP_AgentMemory_main_branch`）に対して、
  長期記憶戦略（`semantic_facts`、SEMANTIC、名前空間
  `/strategy/{memoryStrategyId}/actor/{actorId}/`）を有効化し、`actor_id` 単位でセッションを
  またいだ記憶抽出を可能にしました。あわせて短期記憶の保持期間（`eventExpiryDuration`）を
  従来の 30 日から **365 日**に変更しています。

関連ファイル: `amplify/functions/copilotkitStreamingRelay/handler.ts`（ルーティング分岐・
全ページ取得・認可ブロック）、同 `memoryRestore.ts`（Memory イベント → AG-UI メッセージの変換）、
`amplify/agent/resource.ts`（Memory の定義）、`amplify/backend.ts`
（Cognito / `ChatSession` 読み取り / Memory 読み出し権限の配線）、`src/lib/agent/useSessionMemoryRestore.ts`
（セッション選択時の遅延復元）。

> **`ChatMessage` モデルは削除済み**: 発言内容の正のデータソースは AgentCore Memory に
> 一本化されており、`ChatMessage` への読み書きコードパスは廃止済みでした。これを受けて、運用者
> タスク O4 として `amplify/data/resource.ts` の `ChatMessage` モデル定義を**削除しました**。
> あわせて、モデル削除でビルドが壊れないよう次の変更を同時に行っています。
> - `src/lib/agent/useChatSessions.ts` の `deleteSession` から `ChatMessage` クリーンアップ処理
>   （`client.models.ChatMessage.list` / `client.models.ChatMessage.delete`）を除去し、
>   `ChatSession` レコードを直接削除する実装に変更しました。
> - 上記に伴い不要となった純粋関数（`sessionSort.ts` の `selectMessageIdsForSessionDeletion`・
>   `sortMessagesByCreatedAt`）を削除しました。
>
> **破壊的なインフラ影響**: Amplify Data のモデル削除は背後の DynamoDB テーブルの削除を伴います。
> 次回のデプロイ（`npx ampx sandbox` / `npx ampx pipeline-deploy`）時に `ChatMessage` テーブルが
> **ドロップ**され、この移行より前に作成されたセッションに残っていた過去の `ChatMessage`
> レコードは**恒久的に失われます**（運用者が了承済み）。

### 5. ロールを登録する

デプロイ後、Cognito の `ADMINS` グループに属するユーザーでログインし、画面右上の
「ロール設定管理」から、手順 3 で用意した IAM ロールの ARN・表示名・操作スコープを登録します。
登録が完了すると、一般ユーザーが「新規チャット」でそのロールを選択できるようになります。

デプロイ手順の詳細（IAM ポリシーの具体例、トラブルシューティングを含む）は
[docs/deployment.md](docs/deployment.md) を参照してください。

---

## コスト確認用タグ

Amplify バックエンドスタック（`amplify/backend.ts` の `Tags.of(backend.stack)`）に
`Project` / `Environment` タグを設定しています。AgentCore の Runtime / Memory も
同じスタックに含まれるため、このタグが伝播します。
コスト配分レポート（AWS Billing → コスト配分タグ）で
`Project=aws-operation-agent` で絞り込むと、このアプリに関連する
AWS リソース（Cognito・AppSync・DynamoDB・SSR Lambda・AgentCore Runtime 等）の
コストをまとめて確認できます。

- **Amplify 側**（`amplify/backend.ts`、CDK の `Tags.of(backend.stack)`）:
  `Environment` の値は Amplify Hosting のビルド時に自動設定される
  `AWS_BRANCH` 環境変数（デプロイ先ブランチ名、例: `main`）を使います。
  ローカルの `npx ampx sandbox` 実行時は `AWS_BRANCH` が存在しないため
  `sandbox` にフォールバックします。
- **AgentCore のリソース**: Runtime / Memory / 実行ロールも同じスタックに含まれるため、
  タグ設定は不要です（`Tags.of(backend.stack)` が伝播します）。以前は AgentCore CLI 側の
  `agentcore.json` に別途タグを書き、2 箇所を一致させる必要がありました。

自分のプロジェクトとして使う場合は、`amplify/backend.ts` の
`backendTags.add('Project', ...)` の値を実際のプロジェクト名に変更してください。
変更後は次回の `npx ampx pipeline-deploy` でタグが差し替わります。

## セキュリティに関する注意事項

### 操作の境界を実際に守っているのは IAM ロールの権限です

**これは本テンプレートを使う際にもっとも重要な理解です。**

エージェントは AWS 操作を `aws___call_aws` という単一の汎用ツール（`mcp-proxy-for-aws`
が公開する AWS CLI 相当のツール）経由で実行します。読み取りも書き込みも削除も、すべて
同じツール名で、コマンド文字列が違うだけです。

そのため、エージェント内の操作スコープ強制（`scope/enforcement.py` の
`BeforeToolCallEvent` フック）は**ツール名からは操作の危険度を判別できません**。
readonly スコープのセッションで「バケットを作って」と依頼すると、フックはツール呼び出しを
通し、実際に拒否するのは AssumeRole 先の IAM ロールに付いた権限です。

```
TOOL_CALL_START   aws___call_aws          ← スコープフックは通過する
TOOL_CALL_RESULT  AccessDenied: assumed-role/AgentMCPReadOnlyRole/mcp-agent-readonly
                  is not authorized to perform: s3:CreateBucket
```

つまり層はこうなっています。

| 層 | 何を防ぐか | 実効性 |
|----|-----------|--------|
| 画面のロール選択 | セッションで使えるロールの限定 | ユーザーの選択に依存 |
| スコープ強制フック | ツール名で判別できる範囲の抑止、ロール未選択時の拒否 | 汎用ツールの内部操作は判別不能 |
| **AssumeRole 先の IAM ロールの権限** | **実際の AWS API 呼び出しの許否** | **唯一の確実な境界** |

**読み取り専用で使わせたいロールには、必ず読み取り専用の IAM 権限だけを付けてください。**
スコープの登録値を `readonly` にすることは、UI 上の表示とフックによる補助的な抑止であって、
権限の制限そのものではありません。逆に、管理者ロールに `AdministratorAccess` を付けると、
エージェントはそのセッションで任意の AWS 操作を実行できます。

### その他

- ロールの ARN・AWS アカウント ID は、`/api/roles` のレスポンスおよびエージェントの
  システムプロンプトから常に除外されます。一般ユーザーに見えるのは表示名・アカウントラベル・
  操作スコープのみです。
- ロールの登録・編集・無効化は Cognito の `ADMINS` グループに属するユーザーのみ行えます。
- `.env.local` や Amplify コンソールの環境変数に、AWS 認証情報やシークレットを直接
  書き込まないでください。ロールの IAM 権限設計（最小権限の原則）は利用者自身の責任で
  行ってください。
- 本リポジトリを Fork・公開する場合は、`.env.local` と `amplify_outputs.json` に実際の AWS
  アカウント ID・ARN・エンドポイント URL が書き込まれていないか確認してください
  （`.gitignore` で主要なファイルは除外済みですが、コミット履歴に既に含まれている
  場合は別途、履歴からの除去が必要です）。

---

## 更新時のデプロイ

```bash
# エージェントのコードを変更した場合は、先に配布用パッケージを作り直す
./scripts/build-agent-package.sh   # ローカルからデプロイする場合のみ

git push origin <ブランチ名>   # Amplify Hosting が自動デプロイ
```

フロントエンド・バックエンド・エージェントのどれを変更した場合も同じ手順です。
Amplify Hosting のビルドでは `amplify.yml` の `preBuild` がパッケージのビルドを行うため、
push だけで完結します。

## お片付け（リソース削除）

```bash
# 1. Amplify Hosting の削除（AWS コンソール → Amplify → アプリを削除）

# 2. sandbox の停止（ローカルで使っていた場合）
npx ampx sandbox delete
```

AgentCore Runtime・中継 Lambda・Runtime 実行ロールはバックエンドスタックの一部なので
自動的に削除されます。

**AgentCore Memory は `RemovalPolicy.RETAIN` のため残ります**（会話履歴を守るため）。
手動で作成した `AgentMCPAdminRole` / `AgentMCPReadOnlyRole` も CDK 管理外です。
いずれも不要になったら手動で削除してください
（[docs/environments.md](docs/environments.md#リソースの削除)）。

---

## ブランチ戦略と CI/CD

| ブランチ | 用途 |
|---------|------|
| `main` | 本番向け |
| `develop` | 統合ブランチ |
| `feature/*` | 実装作業用 |

各ブランチがどの AWS リソース（Cognito・RoleConfig テーブル・AgentCore Runtime）に対応するかは
[docs/environments.md](docs/environments.md) にまとめています。

| 対象 | 品質ゲート（GitHub Actions） | デプロイ |
|------|------------------------------|---------|
| Web アプリ | `.github/workflows/ci.yml` — lint（ESLint）、型チェック（`tsc --noEmit`） | Amplify Hosting（Git push で自動） |
| エージェント | なし（CI 未設定）。ローカルで `pytest` と `ruff` を実行する | Amplify Hosting（Git push で自動、`AGENT_ENABLED=true` のブランチ） |

`ci.yml` は `agents/**` / `docs/**` / `.kiro/**` / `*.md` を `paths-ignore` しているため、
エージェントコードのみの変更では CI が起動しません。エージェント側の検証は
`agents/app/AWS_MCP_Agent/` で手元から実行してください。

```bash
cd agents/app/AWS_MCP_Agent
uv sync --group dev --python 3.13
uv run pytest                      # 単体テスト（dev 依存グループに含まれる）
uvx ruff check --select F .         # lint（ruff は依存に含めていないため uvx / pipx 経由で実行）
```

> **ruff の設定について**: `pyproject.toml` の `[tool.ruff]` には除外パス
> （`.build` / `.venv`）のみを設定しており、**適用するルールセットは指定していません**。
> そのため `uvx ruff check .`（ルール無指定）は ruff のバージョンによって選択される
> ルールが変わり、既存コードに対してスタイル系の指摘（`UP` / `RUF` / `TRY` / `E501` など）が
> 数十件出ます。いずれも動作に影響しないため未対応です。回帰の検出には未定義名・未使用
> import を見る `--select F` を使ってください。ルールセットを固定したい場合は
> `[tool.ruff.lint]` の `select` を追加してください。

## サンプルの除去

自分のプロジェクトとして使い始める際:

1. `src/app/sample/` を削除する
2. `amplify/data/resource.ts` の `Todo` モデルを自分のモデルに置き換える
3. エージェント機能を使わない場合は、まず `AGENT_ENABLED` を設定しないでください。それだけで
   AgentCore のリソースは一切作られません（生成される CloudFormation テンプレートも
   エージェント無しの構成と同一になります）。コードごと取り除くなら `agents/`、`scripts/`、
   `amplify/agent/`、`amplify/functions/copilotkitStreamingRelay/`、`src/app/api/roles/`、
   `src/components/agent/`、`src/lib/agent/` を削除し、`amplify/backend.ts` の
   `copilotkitStreamingRelay` / `createAgentCoreResources` 関連のインポート・配線・
   `backend.addOutput` の呼び出しも取り除く

## 詳細ドキュメント

| ドキュメント | 内容 |
|-------------|------|
| [docs/setup.md](docs/setup.md) | セットアップ詳細・前提条件・配布用パッケージのビルド・ローカル開発の制限事項 |
| [docs/environments.md](docs/environments.md) | 環境と運用（sandbox / ステージング / 本番の対応関係、環境変数の設定場所、環境を作り直したときの更新手順） |
| [docs/deployment.md](docs/deployment.md) | デプロイ手順の詳細（Amplify + AgentCore + IAM 権限） |
| [docs/architecture-aws-mcp.md](docs/architecture-aws-mcp.md) | AWS MCP エージェント接続アーキテクチャ、既知の制約 |
| [docs/kiro-usage.md](docs/kiro-usage.md) | Kiro（IDE）の steering/skills の使い方 |
| [agents/README.md](agents/README.md) | エージェントコードの構成・ローカル実行・実行環境の仕様 |

## ライセンス

[LICENSE](LICENSE) を参照してください（MIT No Attribution）。コントリビュートについては
[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。
