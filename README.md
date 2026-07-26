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
- ロールごとに操作スコープ（読み取り専用 / 読み書き / 管理者）を持ち、スコープを超える操作は拒否される
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
| エージェント管理 | AgentCore CLI (`@aws/agentcore`) |
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
agents/                       # AgentCore CLI プロジェクト
  agentcore/                  # AgentCore CLI 設定・CDK インフラ定義
  app/AWS_MCP_Agent/           # エージェント本体（Strands Agent + AG-UI サーバー）
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
- エージェント機能を試す場合: Python 3.12〜3.13、Docker、AgentCore CLI

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

エージェント機能の完全な動作確認には、AWS 側の IAM ロール準備と AgentCore Runtime への
デプロイが必要です。ローカルではエージェント単体の起動確認（`agentcore dev` / `uvicorn`）
のみ可能で、フロントエンドとの結合テストは Amplify Hosting のデプロイ環境で行います
（SigV4 署名にコンピューティングロールが必要なため）。

> **最初に**: このリポジトリは公開用に、AWS アカウント ID やリソース ID を
> `<YOUR_AWS_ACCOUNT_ID>` などのプレースホルダに置き換えてあります。埋める値・取得方法・
> 埋める順序は [docs/setup.md のプレースホルダと ID の埋め方](docs/setup.md#プレースホルダと-id-の埋め方エージェント機能を使う場合)
> にまとめてあります。以下の手順の前に一読してください。

### 1. AWS 側でロール用の IAM ロールを準備する

エージェントが `AssumeRole` する対象の IAM ロールを、操作スコープ別に用意します
（例: 読み取り専用ロールに `ReadOnlyAccess`、管理者ロールに必要な権限をアタッチ）。

ロールを AgentCore Runtime の実行ロールに引き受けさせる（`sts:AssumeRole` を許可する）方法は、
そのロールが **AgentCore Runtime と同一の AWS アカウント内にあるか**、
**別の AWS アカウントにあるか**で手順が異なります。以下、順に説明します。

#### AgentCore Runtime の実行ロールを確認する

どちらの手順でも、まず AgentCore Runtime の実行ロールの ARN を確認しておく必要があります。

- `agentcore status` の実行結果、または AWS コンソールの Bedrock AgentCore の Runtime 詳細画面で確認する
- あるいは IAM コンソールのロール一覧で、`AgentCore-agents-default-Application<エージェント名>-` から始まる名前のロールを検索する

以下、この実行ロールの ARN を `<RUNTIME_EXECUTION_ROLE_ARN>`、ロール名部分を
`<RUNTIME_EXECUTION_ROLE_NAME>` として説明します。

#### 1-A. 同一アカウントの場合（追加のコード変更・再デプロイ不要）

追加したいロールが AgentCore Runtime と同じ AWS アカウントにある場合、**そのロールの
信頼ポリシー（Trust Policy）に実行ロールを Principal として追加するだけ**で有効になります。
CDK コード（後述の `MCP_AGENT_ASSUMABLE_ROLE_ARNS`）の変更も `agentcore deploy` の再実行も
不要です。

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

3. ロールに必要な権限をアタッチする（例: 読み取り専用なら `ReadOnlyAccess`、管理者ロールなら
   必要な操作を許可するカスタムポリシー）
4. 後述の「4. ロールを登録する」に進み、画面からこのロールの ARN・表示名・操作スコープを登録する

これでロールが有効になります。CDK の変更や `agentcore deploy` は不要です。

#### 1-B. クロスアカウントの場合（CDK の変更 + 再デプロイが必要）

追加したいロールが AgentCore Runtime とは**別の AWS アカウント**にある場合、
1-A の信頼ポリシーだけでは不十分です。AWS STS の `AssumeRole` は、呼び出し元
（実行ロール）のアイデンティティベースポリシーと、ターゲットロールのリソースベース
ポリシー（信頼ポリシー）の**両方**が許可している必要があり、この「両方必須」の
原則はクロスアカウントでは省略されません（1-A で説明した同一アカウント内の
暗黙的な許可の仕組みが働かないためです）。

手順:

1. **ターゲットアカウント側**: ロールを作成し、信頼ポリシーで実行ロールを Principal として
   許可する（内容は 1-A の手順2と同じ）

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "AWS": "arn:aws:iam::<AgentCore Runtime が動いているアカウントID>:role/<RUNTIME_EXECUTION_ROLE_NAME>"
         },
         "Action": "sts:AssumeRole"
       }
     ]
   }
   ```

2. **AgentCore Runtime 側（このリポジトリの CDK）**: `agents/agentcore/cdk/lib/cdk-stack.ts`
   の `MCP_AGENT_ASSUMABLE_ROLE_ARNS` に、追加するロールの ARN を追記する

   ```ts
   const MCP_AGENT_ASSUMABLE_ROLE_ARNS = [
     'arn:aws:iam::<既存アカウントID>:role/AgentMCPReadOnlyRole',
     'arn:aws:iam::<既存アカウントID>:role/AgentMCPAdminRole',
     'arn:aws:iam::<クロスアカウントID>:role/<新しいロール名>', // 追加
   ];
   ```

3. CDK を再デプロイする

   ```bash
   cd agents
   agentcore deploy
   ```

4. 後述の「4. ロールを登録する」に進み、画面からこのロールの ARN・表示名・操作スコープを登録する

> **1-A と 1-B で手順が違う理由**: `sts:AssumeRole` の許可判定は、原則として呼び出し元の
> アイデンティティベースポリシーとターゲット側の信頼ポリシーの両方が必要です。ただし
> 同一アカウント内に限り、信頼ポリシーがアカウント内の Principal を明示的に許可していれば、
> 呼び出し元側の許可は暗黙的に不要とみなされます。クロスアカウントではこの暗黙的な許可が
> 働かないため、実行ロール側のポリシー（`MCP_AGENT_ASSUMABLE_ROLE_ARNS`）への追記と
> 再デプロイが必須になります。

### 2. エージェントをデプロイする

```bash
cd agents
agentcore deploy
```

初回は CDK の bootstrap を含むため数分かかります。デプロイ後、`agentcore status` で
Runtime ARN を確認してください。

取得した Runtime ARN は `AGENTCORE_RUNTIME_ARN`（`copilotkitStreamingRelay` の環境変数、
`NEXT_PUBLIC_` プレフィックスなし）に設定します。ローカルで sandbox を使う場合は
`.env.local` に記載するかシェルで `export` した状態で `npx ampx sandbox` を実行してください
（詳細は [新しい Lambda 関数（`copilotkitStreamingRelay`）について](#新しい-lambda-関数copilotkitstreamingrelayについて) を参照）。

#### 環境を増やす場合の Runtime 追加について

初期状態の `agents/agentcore/agentcore.json` には Runtime が **1 つ**（`AWS_MCP_Agent`）だけ
定義されています。`agentcore deploy` には Runtime を選んでデプロイするオプションがなく、
`runtimes` 配列の全エントリが同じ CloudFormation スタックにまとめてデプロイされるため、
エントリ数がそのまま作られる Runtime の数になります。まずは 1 つで動かし、環境を分ける
必要が出てから増やす構成にしています。

ステージング環境を追加する典型的な流れは次のとおりです。

1. Amplify Hosting に `develop` ブランチを接続してデプロイする
2. `develop` のバックエンドが生成した RoleConfig テーブル名を確認する
   （`amplify:branch-name` タグで判別）
3. `agentcore.json` の `runtimes` に `AWS_MCP_Agent_Dev` エントリを追加する
   （`AWS_MCP_Agent` をコピーし、`name` と `ROLE_CONFIG_TABLE_NAME` を差し替える）
4. `agents/agentcore/cdk/lib/cdk-stack.ts` の `ROLE_CONFIG_TABLE_ARN_BY_RUNTIME` に
   対応するテーブル ARN を追加する
5. `cd agents && agentcore deploy`
6. `develop` ブランチの Amplify 環境変数 `AGENTCORE_RUNTIME_ARN` に、追加した Runtime の
   ARN を設定する

追加した Runtime は独立した Runtime ARN・実行ロール・IAM 権限（自分の
`ROLE_CONFIG_TABLE_NAME` に対応するテーブルへの `dynamodb:Scan` のみ）を持つため、
ステージング側の変更が本番用 Runtime に影響することはありません。IAM 権限を付与する
CDK 側のループは `AWS_MCP_Agent` というプレフィックスで対象を判定しているので、
`AWS_MCP_Agent_Dev` という命名にしておけばコードの変更は不要です。

AgentCore Memory（`AWS_MCP_AgentMemory`）はプロジェクト内の全 Runtime に自動でワイヤリング
される仕組みのため、**追加した Runtime とも共有されます**。会話履歴を環境ごとに分けたい
場合は、`agentcore.json` の `memories` に別の Memory を定義する必要があります。

> **コスト**: AgentCore Runtime は消費ベース課金（セッション中に消費した CPU とピークメモリ、
> 秒単位）なので、呼ばれていない Runtime の待機コストは発生しません。Runtime を増やしたときに
> 常時かかるのはコンテナイメージの ECR ストレージ（Runtime ごとに別リポジトリ）です。

### 3. Amplify Hosting をデプロイし、接続する

1. Amplify コンソールでリポジトリを接続し、Web アプリをデプロイする
2. コンピューティングロール（`AmplifySSRComputeRole`）に以下の権限を追加する（下記を参照）
   - `dynamodb:Scan`（`main` ブランチ用の RoleConfig テーブルの読み取り用）

   > `bedrock-agentcore:InvokeAgentRuntime` は **コンピューティングロールには不要**です。
   > この権限は `copilotkitStreamingRelay`（Amplify Gen 2 のカスタム関数、後述）専用の
   > Lambda 実行ロールが持ち、Amplify バックエンドのデプロイ（`npx ampx pipeline-deploy`、
   > 手順1の Amplify コンソールでのデプロイに含まれる）時に自動的に作成・設定されます。
3. Amplify コンソール →「ホスティング」→「環境変数」で、以下を設定する

   | キー | 値 |
   |------|-----|
   | `AGENTCORE_RUNTIME_ARN` | 手順2で取得した Runtime ARN。バックエンドビルド（`pipeline-deploy`）時に `copilotkitStreamingRelay` の環境変数・IAM ポリシーの `Resource` に反映される |
   | `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` | `copilotkitStreamingRelay` の関数 URL（手順3のデプロイ後に確認、後述） |
   | `ROLE_CONFIG_TABLE_NAME` | RoleConfig テーブル名（後述） |

   `ROLE_CONFIG_TABLE_NAME` は `GET /api/roles`（`src/app/api/roles/route.ts`）が
   DynamoDB を `Scan` する際に読むテーブル名です。`NEXT_PUBLIC_` プレフィックスを
   付けないでください（サーバーサイドの Route Handler でのみ使用するため、
   ブラウザに露出させる必要がありません）。テーブル名は次のいずれかの方法で確認できます:
   - AWS コンソール → DynamoDB → テーブル一覧で `RoleConfig-xxxxxxxxxxxxxxxxxxxxxxxxxx-NONE`
     という名前のテーブルを探す
   - Amplify コンソール → アプリ →（対象ブランチ）→「バックエンド」→ 該当の
     データリソースから確認する

   > **`-NONE` という接尾辞について**: Amplify Gen 2 が生成する DynamoDB テーブル名は
   > `<モデル名>-<AppSync API の ID>-<Amplify API 環境名>` という形式ですが、
   > 現在の Amplify Gen 2 の実装ではこの「Amplify API 環境名」部分は
   > sandbox・ブランチデプロイのいずれでも常に固定文字列 `NONE` になります
   > （ブランチ名がテーブル名に反映されることはありません）。そのため
   > sandbox 用と各ブランチ用のテーブルは、どちらも末尾が `-NONE` になりますが、
   > 中間の AppSync API ID 部分が異なる別々の実体です。どのテーブルがどの
   > ブランチのものかを区別する場合は、テーブルに付与されている
   > `amplify:branch-name` タグ（AWS コンソール → DynamoDB → 対象テーブル →
   > 「タグ」タブ）で確認してください。

   `agents/agentcore/agentcore.json` の `ROLE_CONFIG_TABLE_NAME`（Agent 側が同じ
   テーブルを読む設定）と必ず同じ値にしてください。両者の値が異なると、画面から
   登録したロールがエージェント側の Role_Set 選択に反映されません。

   > **重要**: Amplify Hosting は、Next.js のサーバーサイド（Route Handler
   > を含む）に対して、コンソールで設定した環境変数をデフォルトでは
   > 渡しません（ビルド時のシークレット漏洩を防ぐための仕様。
   > [AWS 公式ドキュメント](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-environment-variables.html)）。
   > `NEXT_PUBLIC_` プレフィックス付きの変数はビルド時に自動的にバンドルへ
   > 埋め込まれるため問題になりませんが、`ROLE_CONFIG_TABLE_NAME` は
   > サーバーサイド専用の環境変数のため、`amplify.yml` のビルドコマンドで
   > 明示的に `.env.production` へ書き出す必要があります（このリポジトリの
   > `amplify.yml` には既に対応する行が入っています）。この設定が抜けると、
   > コンソールで環境変数を設定していても `GET /api/roles` は
   > `process.env.ROLE_CONFIG_TABLE_NAME` が `undefined` のまま DynamoDB
   > `Scan` を呼び出し、`ValidationException: Value null at 'tableName'`
   > で失敗します（画面上は「新規チャット」ダイアログが一瞬開いてすぐ
   > 閉じる、という分かりにくい症状になります）。
4. 再デプロイする

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
  `agentcore deploy` の追加実行は不要です。ローカル開発では `npx ampx sandbox` でこの Lambda も
  一緒にデプロイされます。
- **新規に必要な環境変数**:

  | 変数 | 設定場所 | 説明 |
  |------|---------|------|
  | `AGENTCORE_RUNTIME_ARN` | CDK synth 時のシェル環境変数（ローカルは `.env.local` / シェルの `export`、本番は Amplify コンソールの環境変数） | `copilotkitStreamingRelay` の Lambda 環境変数、および IAM ポリシーの `Resource` の両方に反映される。旧 `NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN`（Route Handler 用）はこの Lambda では読まれない |
  | `AGENTCORE_MEMORY_ID` | CDK synth 時のシェル環境変数（`AGENTCORE_RUNTIME_ARN` と同じ運用パターン） | AgentCore Memory の ID（例: `agents_AWS_MCP_AgentMemory-XXXXXXXXXX`）。Memory 読み出し（`ListEvents`）の呼び出しと IAM ポリシーの `Resource` の絞り込みに使う。**未設定の場合は `bedrock-agentcore:ListEvents` のポリシー自体を付与しない**（`AGENTCORE_RUNTIME_ARN` と同じフェイルセーフ方針） |
  | `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` | フロントエンドのビルド時環境変数（`.env.local` または Amplify コンソール） | `CopilotProvider.tsx` の `runtimeUrl` が参照する、`copilotkitStreamingRelay` の関数 URL |

  > **`COGNITO_USER_POOL_ID` / `COGNITO_USER_POOL_CLIENT_ID` について**: この2つも
  > `copilotkitStreamingRelay` の Lambda 環境変数として必要ですが、上記のように手動で
  > 設定する必要はありません。`amplify/backend.ts` が Cognito リソース
  > （`backend.auth.resources.userPool` / `userPoolClient`）から synth 時に自動配線します。
  > Memory 読み出しエンドポイントの Cognito JWT 署名検証（後述）に使用します。

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
  （`Resource` は `AGENTCORE_RUNTIME_ARN` から導出され、未設定時は権限自体を付与しません）。
  これは以前 `AmplifySSRComputeRole` に付与していた同名の権限を引き継いだものです。
  **`AmplifySSRComputeRole` に `bedrock-agentcore:InvokeAgentRuntime` を追加する必要はありません**
  （前述の「コンピューティングロールへの権限追加について」を参照）。

  さらに、AgentCore Memory ベースの会話履歴復元（後述）のために、同じ Lambda 実行ロールに
  以下の2つの読み取り専用権限が追加で付与されます（いずれも書き込み系アクションを含みません）。

  - `bedrock-agentcore:ListEvents`（Memory から過去の会話イベントを読み出す。`Resource` は
    `AGENTCORE_MEMORY_ID` から導出され、未設定時は付与されません）
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
- **長期記憶（Semantic）の有効化・保持期間 365 日**: プロジェクト内の全 Runtime が共有する
  Memory リソース（`agents_AWS_MCP_AgentMemory-XXXXXXXXXX`）に対して、
  長期記憶戦略（`semantic_facts`、SEMANTIC、名前空間
  `/strategy/{memoryStrategyId}/actor/{actorId}/`）を有効化し、`actor_id` 単位でセッションを
  またいだ記憶抽出を可能にしました。あわせて短期記憶の保持期間（`eventExpiryDuration`）を
  従来の 30 日から **365 日**に変更しています。

関連ファイル: `amplify/functions/copilotkitStreamingRelay/handler.ts`（ルーティング分岐・
全ページ取得・認可ブロック）、同 `resource.ts`（`ListEvents` の IAM ポリシー・`AGENTCORE_MEMORY_ID`）、
同 `memoryRestore.ts`（Memory イベント → AG-UI メッセージの変換）、`amplify/backend.ts`
（Cognito / `ChatSession` 読み取りの配線）、`src/lib/agent/useSessionMemoryRestore.ts`
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

### 4. ロールを登録する

デプロイ後、Cognito の `ADMINS` グループに属するユーザーでログインし、画面右上の
「ロール設定管理」から、手順1で用意した IAM ロールの ARN・表示名・操作スコープを登録します。
登録が完了すると、一般ユーザーが「新規チャット」でそのロールを選択できるようになります。

デプロイ手順の詳細（IAM ポリシーの具体例、トラブルシューティングを含む）は
[docs/deployment.md](docs/deployment.md) を参照してください。

---

## コスト確認用タグ

Amplify バックエンド（`amplify/backend.ts`）と AgentCore CDK スタック
（`agents/agentcore/agentcore.json` の `tags`）の両方に `Project` / `Environment`
タグを設定しています。コスト配分レポート（AWS Billing → コスト配分タグ）で
`Project=aws-operation-agent` で絞り込むと、このアプリに関連する
AWS リソース（Cognito・AppSync・DynamoDB・SSR Lambda・AgentCore Runtime 等）の
コストをまとめて確認できます。

- **Amplify 側**（`amplify/backend.ts`、CDK の `Tags.of(backend.stack)`）:
  `Environment` の値は Amplify Hosting のビルド時に自動設定される
  `AWS_BRANCH` 環境変数（デプロイ先ブランチ名、例: `main`）を使います。
  ローカルの `npx ampx sandbox` 実行時は `AWS_BRANCH` が存在しないため
  `sandbox` にフォールバックします。
- **AgentCore 側**（`agents/agentcore/agentcore.json` の `tags`）:
  AgentCore CLI には Amplify のようなブランチ＝環境という自動識別の仕組みが
  ないため、`Environment` は固定値（デフォルトは `default`）を手動で設定します。
  複数の環境（例: 開発用・本番用）を AgentCore CLI の複数ターゲット
  （`aws-targets.json`）で分けて運用する場合は、それぞれの `agentcore.json` で
  値を変更してください。

自分のプロジェクトとして使う場合は、両方の `Project` の値（`amplify/backend.ts` の
`backendTags.add('Project', ...)` と `agents/agentcore/agentcore.json` の `tags.Project`）を
実際のプロジェクト名に変更してください。**2箇所は必ず同じ値に揃えてください**（片方だけ
変えるとコスト配分レポートが2つに分断されます）。値を変更した場合は、次回の
`npx ampx pipeline-deploy` / `agentcore deploy` でタグが差し替わります。

## セキュリティに関する注意事項

- ロールの ARN・AWS アカウント ID は、`/api/roles` のレスポンスおよびエージェントの
  システムプロンプトから常に除外されます。一般ユーザーに見えるのは表示名・アカウントラベル・
  操作スコープのみです。
- ロールの登録・編集・無効化は Cognito の `ADMINS` グループに属するユーザーのみ行えます。
- `.env.local` や Amplify コンソールの環境変数に、AWS 認証情報やシークレットを直接
  書き込まないでください。ロールの IAM 権限設計（最小権限の原則）は利用者自身の責任で
  行ってください。
- 本リポジトリを Fork・公開する場合は、`agents/agentcore/` 配下の CLI が生成する
  ステート/デプロイ結果ファイル、`.env.local`、`amplify_outputs.json` に実際の AWS
  アカウント ID・ARN・エンドポイント URL が書き込まれていないか確認してください
  （`.gitignore` で主要なファイルは除外済みですが、コミット履歴に既に含まれている
  場合は別途、履歴からの除去が必要です）。

---

## 更新時のデプロイ

```bash
# Web アプリ
git push origin <ブランチ名>   # Amplify Hosting が自動デプロイ

# エージェント
cd agents && agentcore deploy
```

両方を更新する場合は、エージェント → フロントエンドの順にデプロイしてください。

## お片付け（リソース削除）

```bash
# 1. AgentCore Runtime の削除
cd agents
agentcore remove all --yes
agentcore deploy

# 2. Amplify Hosting の削除（AWS コンソール → Amplify → アプリを削除）

# 3. sandbox の停止（ローカルで使っていた場合）
npx ampx sandbox delete
```

手動で作成した `AgentMCPAdminRole` / `AgentMCPReadOnlyRole` は CDK 管理外のため、
不要になったら手動で削除してください（[docs/environments.md](docs/environments.md#リソースの削除)）。

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
| エージェント | なし（CI 未設定）。ローカルで `pytest` と `ruff` を実行する | AgentCore CLI（`agentcore deploy`、手動） |

`ci.yml` は `agents/**` / `docs/**` / `.kiro/**` / `*.md` を `paths-ignore` しているため、
エージェントコードのみの変更では CI が起動しません。エージェント側の検証は
`agents/app/AWS_MCP_Agent/` で手元から実行してください。

```bash
cd agents/app/AWS_MCP_Agent
uv sync --group dev --python 3.13
uv run pytest                      # 単体テスト（dev 依存グループに含まれる）
uvx ruff check --select F .         # lint（ruff は依存に含めていないため uvx / pipx 経由で実行）
```

> **ruff の設定について**: このリポジトリには ruff の設定ファイルを置いていません。
> `uvx ruff check .`（ルール無指定）は ruff のバージョンによって選択されるルールセットが
> 変わり、既存コードに対してスタイル系の指摘（`UP` / `RUF` / `TRY` / `E501` など）が
> 数十件出ます。いずれも動作に影響しないため未対応です。回帰の検出には未定義名・未使用
> import を見る `--select F` を使ってください。ルールセットを固定したい場合は
> `pyproject.toml` に `[tool.ruff]` を追加してください。

## サンプルの除去

自分のプロジェクトとして使い始める際:

1. `src/app/sample/` を削除する
2. `amplify/data/resource.ts` の `Todo` モデルを自分のモデルに置き換える
3. エージェント機能を使わない場合は `agents/`、`amplify/functions/copilotkitStreamingRelay/`、
   `src/app/api/roles/`、`src/components/agent/`、`src/lib/agent/` を削除し、
   `amplify/backend.ts` の `copilotkitStreamingRelay` 関連のインポート・配線・`backend.addOutput`
   の呼び出しも取り除く

## 詳細ドキュメント

| ドキュメント | 内容 |
|-------------|------|
| [docs/setup.md](docs/setup.md) | セットアップ詳細・前提条件・プレースホルダの埋め方・ローカル開発の制限事項 |
| [docs/environments.md](docs/environments.md) | 環境と運用（sandbox / ステージング / 本番の対応関係、環境変数の設定場所、環境を作り直したときの更新手順） |
| [docs/deployment.md](docs/deployment.md) | デプロイ手順の詳細（Amplify + AgentCore + IAM 権限） |
| [docs/architecture-aws-mcp.md](docs/architecture-aws-mcp.md) | AWS MCP エージェント接続アーキテクチャ、既知の制約 |
| [docs/kiro-usage.md](docs/kiro-usage.md) | Kiro（IDE）の steering/skills の使い方 |
| [agents/app/AWS_MCP_Agent/README.md](agents/app/AWS_MCP_Agent/README.md) | エージェント開発の詳細 |

## ライセンス

[LICENSE](LICENSE) を参照してください（MIT No Attribution）。コントリビュートについては
[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。
