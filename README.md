# AWS 運用アシスタント（AWS Amplify Gen 2 + AgentCore）

[![CI - Web App](https://github.com/jus2024/aws-operation-agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jus2024/aws-operation-agent/actions/workflows/ci.yml)
[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-blue.svg)](LICENSE)

AWS Amplify Gen 2 で構築した業務 Web アプリケーションに、AWS リソースを操作できる
AI エージェントを組み込んだサンプルアプリケーションです。ユーザーはブラウザのチャット
画面から自然言語で AWS リソース（S3、EC2、CloudFormation など）を問い合わせ・操作でき、
エージェントは AWS MCP Server 経由で、ユーザーが選択した IAM ロールの権限内でのみ動作します。

フロントエンド・バックエンド・エージェントがすべて 1 つの Amplify バックエンドスタックに
入っているため、**デプロイは `git push` の 1 系統だけ**です。ARN やテーブル名を手で調べて
環境変数に貼る作業はありません。

> **Note**: これはテンプレート/サンプル実装です。本番環境に導入する前に、IAM ロールの
> 権限設計・監査ログ・エラーハンドリングを自身のセキュリティ要件に合わせて見直してください。

## できること

- チャット画面から自然言語で AWS リソースを問い合わせ・操作する（例:「昨日作った S3 バケットを教えて」）
- セッションごとに、利用する IAM ロールを複数選択できる（例: 読み取り専用ロールと管理者ロールを同時に選び、エージェントが呼び出しごとに適切なロールを選ぶ）
- ロールごとに操作スコープ（読み取り専用 / 読み書き / 管理者）を持つ。ただし操作を実際に拒否するのは AssumeRole 先の IAM ロールの権限です（[詳細](#操作の境界を実際に守っているのは-iam-ロールの権限です)）
- チャットの履歴が保存され、サイドバーから過去のセッションを再開できる
- 管理者（Cognito の `ADMINS` グループ）は、利用可能なロールを画面から追加・編集・無効化できる

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Next.js（App Router） + TypeScript |
| バックエンド | AWS Amplify Gen 2（Cognito / AppSync / DynamoDB） |
| エージェント UI | CopilotKit（`@copilotkit/react-core/v2`） + AG-UI プロトコル |
| エージェント | Python 3.12〜3.13 / Strands Agents SDK + `ag-ui-strands` |
| エージェント実行基盤 | Amazon Bedrock AgentCore Runtime / Memory |
| AWS 操作 | AWS MCP Server（Model Context Protocol） |
| ホスティング | Amplify Hosting |

## アーキテクチャ概要

```
ブラウザ (CopilotKit + Cognito 認証)
  → copilotkitStreamingRelay Lambda 関数 URL
    (Amplify Gen 2 カスタム関数、InvokeMode: RESPONSE_STREAM)
    → SigV4 署名（この Lambda 専用の実行ロール）
      → AgentCore Runtime (AG-UI プロトコル、text/event-stream)
        → 選択されたロールに sts:AssumeRole
          → AWS MCP Server 経由で AWS サービスを操作
```

- ブラウザは Cognito で認証し、中継 Lambda（`copilotkitStreamingRelay`）を経由してのみ
  エージェントにアクセスします。AgentCore Runtime に直接アクセスすることはありません。
  SigV4 署名と Cognito トークンの署名検証はこの Lambda 内だけで行われます
  （[なぜ独立した Lambda なのか](#中継-lambdacopilotkitstreamingrelayについて)）
- AgentCore Runtime と Memory は Amplify バックエンドスタックの一部です
  （`amplify/agent/resource.ts`、`AGENT_ENABLED=true` のときのみ作成）。同一スタックに
  載っているため、RoleConfig テーブル名・Runtime ARN・Memory ID・IAM ポリシーの Resource が
  すべて synth 時に解決されます
- Runtime へは Docker 不要の
  [direct code deployment（CodeZip）](https://aws.amazon.com/blogs/machine-learning/iterate-faster-with-amazon-bedrock-agentcore-runtime-direct-code-deployment/)
  で配布します
- ロールの ARN や AWS アカウント ID は、API のレスポンスにもエージェントへの入力にも
  一切露出しません

## ディレクトリ構成

```
src/                          # フロントエンド（Next.js App Router）
  app/page.tsx                # メイン画面（サイドバー + チャット）
  app/api/roles/              # ロール一覧 API Route（RoleConfig を認証済みユーザーに返す）
  app/sample/                 # Amplify Gen 2 テンプレートの参考実装（Todo リスト）
  components/agent/           # ロール選択ダイアログ、チャット UI、ロール管理画面
  lib/agent/                  # セッション管理・ロール解決・永続化などのモジュール
amplify/                      # Amplify Gen 2 バックエンド定義
  auth/ data/                 # Cognito / AppSync + DynamoDB
  functions/copilotkitStreamingRelay/  # 中継 Lambda（関数 URL、ストリーミング対応）
  agent/resource.ts           # AgentCore Runtime / Memory / 実行ロールの定義
  backend.ts                  # 全体の配線（AGENT_ENABLED の分岐を含む）
agents/                       # エージェント本体（Web アプリ層は含まない）
  app/AWS_MCP_Agent/          # Strands Agent + AG-UI サーバー
scripts/                      # 配布用パッケージのビルドスクリプト
docs/                         # 詳細ドキュメント
.kiro/                        # Kiro ワークスペース設定（steering / specs / skills）
.github/                      # CI ワークフロー
```

---

# セットアップ

クローンしたリポジトリを Amplify Hosting につないでデプロイする手順です。
ローカルでの開発環境（sandbox）は、コードを改修するときだけ必要になります
（後半の [システムを改修する場合](#システムを改修する場合) を参照）。

## 全体の流れ

| 手順 | 内容 | 所要 |
|------|------|------|
| [1](#1-amplify-hosting-に接続してデプロイする) | Amplify Hosting にリポジトリを接続し、`AGENT_ENABLED=true` でデプロイ | 15〜20 分（ビルド） |
| [2](#2-デプロイ後に確定する環境変数を設定して再デプロイする) | デプロイ後に確定する 2 つの環境変数を設定して再デプロイ | 10 分 |
| [3](#3-コンピューティングロールを設定する) | コンピューティングロールを作成し、アプリに割り当てて権限を付与 | 5 分 |
| [4](#4-assumerole-先の-iam-ロールを用意する) | エージェントが引き受ける IAM ロールを作成し、信頼ポリシーに Runtime 実行ロールを追加 | 10 分 |
| [5](#5-管理者ユーザーを作る) | Cognito の `ADMINS` グループにユーザーを追加 | 5 分 |
| [6](#6-ロールを登録して動作確認する) | 画面からロールを登録し、チャットを試す | 5 分 |

手順 2 が「デプロイ → 値を確認 → 設定 → 再デプロイ」になるのは、中継 Lambda の関数 URL と
DynamoDB のテーブル名が、1 回目のデプロイが完了して初めて確定するためです。

## 前提条件

- AWS アカウント
- GitHub 上のこのリポジトリ（Fork またはクローンして自分のリポジトリに push したもの）
- ローカルに Node.js 20 以上と AWS CLI（手順 2 で値を確認するために使います）
- デプロイ先リージョンで **Amazon Bedrock AgentCore が利用可能**であること
  （`us-east-1` / `us-west-2` / `ap-northeast-1` / `ap-southeast-2` / `eu-central-1` /
  `eu-west-1` などで利用可能）
- 同リージョンで **Bedrock のモデルアクセスが有効**であること（既定は Claude Sonnet 5）

エージェント機能を使わない場合は、`AGENT_ENABLED` を設定しないでください。それだけで
AgentCore のリソースは一切作られず、手順 4 以降も不要になります。

ローカルに Python や uv を用意する必要はありません。エージェントの配布用パッケージは
Amplify のビルド中に `amplify.yml` の `preBuild` が uv を取得して作ります。Docker も不要です。

## 1. Amplify Hosting に接続してデプロイする

1. AWS コンソール → Amplify → 「新しいアプリを作成」
2. GitHub を選択してリポジトリと `main` ブランチを指定する
3. ビルド設定はリポジトリの `amplify.yml` が使われます（変更不要）
4. 「環境変数」に次を追加する

   | キー | 値 |
   |------|-----|
   | `AGENT_ENABLED` | `true` |

5. デプロイを開始する

デプロイに必要なサービスロールは、コンソールの案内に従って作成すれば足ります。
バックエンド（Cognito / AppSync / DynamoDB / 中継 Lambda / AgentCore）は
`npx ampx pipeline-deploy` がビルドの一部として作成します。

初回は 15〜20 分ほどかかります（エージェントの依存 161 パッケージの解決と、
CDK による AgentCore Runtime の作成を含みます）。

> **ビルドが `Your artifact contains Python cache files...` で失敗する場合**:
> `agents/app/AWS_MCP_Agent/` に `__pycache__` が残ったまま push されています。
> `.gitignore` の対象なので、追跡されていないか確認してください。

## 2. デプロイ後に確定する環境変数を設定して再デプロイする

手動設定が必要な環境変数は、手順 1 の `AGENT_ENABLED` を含めて**全部で 3 つだけ**です。
残り 2 つの値を、デプロイ済みのバックエンドから取得します。

```bash
# <APP_ID> は Amplify コンソールのアプリ ARN / URL に含まれる文字列（例: d1a2b3c4d5e6f7）
npx ampx generate outputs --app-id <APP_ID> --branch main
cat amplify_outputs.json | jq .custom
```

```json
{
  "copilotkitRelayUrl": "https://xxxxxxxx.lambda-url.<リージョン>.on.aws/",
  "roleConfigTableName": "RoleConfig-xxxxxxxxxxxxxxxxxxxxxxxxxx-NONE",
  "agentCoreRuntimeArn": "arn:aws:bedrock-agentcore:...:runtime/AWS_MCP_Agent_main_branch-xxxxxxxxxx",
  "agentCoreMemoryId": "AWS_MCP_AgentMemory_main_branch-xxxxxxxxxx"
}
```

Amplify コンソール →「ホスティング」→「環境変数」に、次の 2 つを追加します。

| キー | 値 |
|------|-----|
| `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` | `custom.copilotkitRelayUrl` の値 |
| `ROLE_CONFIG_TABLE_NAME` | `custom.roleConfigTableName` の値 |

設定したら再デプロイします（コンソールの「このバージョンを再デプロイ」でも構いません）。
どちらもビルド時に読まれる値なので、再ビルドしないと反映されません。

`agentCoreRuntimeArn` と `agentCoreMemoryId` は確認用の出力です。中継 Lambda と Runtime には
CDK が直接配線するため、**環境変数として設定する必要はありません**。

> **`ROLE_CONFIG_TABLE_NAME` に `NEXT_PUBLIC_` を付けないでください**。サーバーサイドの
> Route Handler（`/api/roles`）でのみ使う値で、ブラウザに露出させる必要がありません。
> なお Amplify Hosting は、コンソールで設定した環境変数を Next.js のサーバーサイドには
> 既定で渡しません（[AWS 公式ドキュメント](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-environment-variables.html)）。
> このリポジトリの `amplify.yml` は、この値をビルド時に `.env.production` へ書き出す行を
> 含んでいるため追加の作業は不要です。

## 3. コンピューティングロールを設定する

Next.js の SSR Lambda（`/api/roles` のみ）が実行時に使う IAM ロールです。Amplify Hosting が
アプリ単位で持つリソースで、**`amplify/backend.ts` の CDK スタックには含まれません**。
そのため作成と権限付与は手作業になります。新規に作成したアプリでは未設定のことがあります。

必要な権限は `dynamodb:Scan`（`/api/roles` 用）**のみ**です。

```bash
# 1. ロールを作成する（<ACCOUNT_ID> / <リージョン> / <APP_ID> を置き換える）
aws iam create-role \
  --role-name AmplifySSRComputeRole-my-app \
  --description "Compute role for Amplify Hosting SSR" \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Sid": "AmplifyComputeAssumeRole",
      "Effect": "Allow",
      "Principal": { "Service": "amplify.amazonaws.com" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "<ACCOUNT_ID>" },
        "ArnLike": { "aws:SourceArn": "arn:aws:amplify:<リージョン>:<ACCOUNT_ID>:apps/<APP_ID>/*" }
      }
    }]
  }'

# 2. RoleConfig テーブルへの Scan を許可する
aws iam put-role-policy \
  --role-name AmplifySSRComputeRole-my-app \
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

作成したら Amplify コンソール → アプリ →「アプリケーションの設定」→「IAM ロール」で
「コンピューティングロール」に割り当てます。反映には再デプロイが必要です。

- IAM の `description` に日本語（非 ASCII）は使えません
- `aws:SourceArn` 条件は confused deputy 対策です。条件付きでも Amplify は引き受けできます
- **`bedrock-agentcore:InvokeAgentRuntime` はここに追加しないでください**。この権限は
  中継 Lambda 専用の実行ロールが持ち、CDK が自動で付与します

> **なぜ sandbox では気づかないのか**: `npx ampx sandbox` はローカルの AWS 認証情報で
> バックエンドだけをデプロイする仕組みで、コンピューティングロールは関与しません。
> この権限不足は Amplify Hosting にデプロイして初めて表面化します。

## 4. AssumeRole 先の IAM ロールを用意する

エージェントが実際に AWS を操作するときに引き受けるロールです。CDK の管理外にしています
（既存の運用ロールを流用できるようにするため）。既定では次の 2 つのロール名を前提にします
（`amplify/agent/resource.ts` の `ASSUMABLE_ROLE_NAMES`）。

| ロール名 | 想定する権限 |
|---------|-------------|
| `AgentMCPReadOnlyRole` | `ReadOnlyAccess` |
| `AgentMCPAdminRole` | `AdministratorAccess` など、必要な範囲 |

> **この権限設計が操作の実効的な境界です。** 読み取り専用で使わせたいロールには、必ず
> 読み取り専用の権限だけを付けてください（理由は
> [操作の境界を実際に守っているのは IAM ロールの権限です](#操作の境界を実際に守っているのは-iam-ロールの権限です)）。

信頼ポリシーの Principal には、デプロイ時に作られた Runtime の実行ロールを指定します。
ARN を確認します。

```bash
aws iam list-roles \
  --query "Roles[?contains(RoleName, 'AwsMcpAgentRuntimeRole')].Arn" \
  --output text
```

複数の環境をデプロイしている場合は複数出るので、スタック名
（`amplify-<namespace>-<name>-<type>-`）で見分けてください。

各ロールに次の信頼ポリシーを設定し、必要な権限をアタッチします。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<ACCOUNT_ID>:role/<Runtime 実行ロール名>"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

同一アカウントであれば、これだけで有効になります（コード変更も再デプロイも不要）。
既存ロールに追記する場合は、既存の Principal を消さないよう注意してください。
別アカウントのロールを使う場合は実行ロール側のポリシーにも追記が必要です。
どちらの手順も [docs/deployment.md](docs/deployment.md#同一アカウントのロールを追加する) に詳しくあります。

## 5. 管理者ユーザーを作る

ロールを登録できるのは Cognito の `ADMINS` グループに属するユーザーだけです。
まずアプリの画面からサインアップし、そのユーザーをグループに追加します。

```bash
# User Pool ID は amplify_outputs.json の auth.user_pool_id
jq -r .auth.user_pool_id amplify_outputs.json

aws cognito-idp admin-add-user-to-group \
  --user-pool-id <USER_POOL_ID> \
  --username <サインアップしたユーザー名> \
  --group-name ADMINS
```

グループの反映にはサインアウトとサインインが必要です（トークンにグループが入るため）。

## 6. ロールを登録して動作確認する

1. `ADMINS` のユーザーでサインインし、画面右上の「ロール設定管理」を開く
2. 手順 4 で用意したロールの ARN・表示名・操作スコープを登録する
3. 「新規チャット」でロールを選び、`S3 バケットの一覧を教えて` のように尋ねる

一覧が返ってくれば、ブラウザ → 中継 Lambda → Runtime → AssumeRole → AWS MCP の経路が
すべて通っています。

## つまずいたときは

| 症状 | 原因 | 対処 |
|------|------|------|
| 「新規チャット」ダイアログが一瞬開いてすぐ閉じる | ロール一覧が空。`ROLE_CONFIG_TABLE_NAME` 未設定か、コンピューティングロールに `dynamodb:Scan` が無い | 手順 2 と 3 を確認する。`/api/roles` は `AccessDeniedException` を捕捉して空配列を返すため画面にエラーが出ない |
| チャットを送っても応答がない | `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` が未設定、または設定後に再ビルドしていない | 手順 2 を確認する。ブラウザの Network タブで関数 URL へのリクエストが出ているか見る |
| `403 ACCESS_DENIED (InvokeAgentRuntime)` | 中継 Lambda の実行ロールの権限不足 | 通常は CDK が付与する。`AGENT_ENABLED=true` でデプロイされているか確認する |
| `AccessDenied: assumed-role/... is not authorized` | AssumeRole は成功したが、引き受けたロールに権限が無い | 期待どおりの動作。必要なら手順 4 のロールに権限を足す |
| ロールを選んでも実行ロールの権限のまま動く | AssumeRole 先の信頼ポリシーに Runtime 実行ロールが入っていない | 手順 4 を確認する |
| 過去のチャットを開いても発言が出ない | 会話履歴は AgentCore Memory が正。修正前に記録された会話は復元できない | 新しい会話で確認する |

ログの確認方法は
[docs/architecture-aws-mcp.md](docs/architecture-aws-mcp.md#トラブルシューティング) にあります。

---

# システムを改修する場合

ここからはコードを変更する人向けの内容です。デプロイして使うだけなら不要です。

## sandbox で自分専用のバックエンドを立てる

`npx ampx sandbox` は、ローカルの AWS 認証情報で自分専用のバックエンド（Cognito / AppSync /
DynamoDB / 中継 Lambda）を作ります。Amplify Hosting の環境とは独立しています。

```bash
npm ci
cp .env.example .env.local

# ターミナル 1: sandbox（初回は数分かかります）
npx ampx sandbox

# ターミナル 2: 開発サーバー
npm run dev
```

`http://localhost:3000` でサインアップ/サインインできます。
`http://localhost:3000/sample` は Amplify Gen 2 テンプレートの参考実装（Todo リスト）です。

エージェントも sandbox に含めたい場合は `AGENT_ENABLED=true` を付けます。開発者ごとに
AgentCore Runtime と Memory が作られます（Runtime は消費ベース課金なので待機コストは
ありません）。

```bash
./scripts/build-agent-package.sh       # 配布用パッケージを先に作る（uv が必要）
AGENT_ENABLED=true npx ampx sandbox
```

sandbox の出力（`amplify_outputs.json` の `custom`）から、`.env.local` に
`NEXT_PUBLIC_COPILOTKIT_RELAY_URL` と `ROLE_CONFIG_TABLE_NAME` を設定します。

## ローカルでできること・できないこと

| 対象 | ローカル | 備考 |
|------|:---:|------|
| Web アプリ（認証・Todo・ロール管理画面） | できる | sandbox が必要 |
| エージェント単体（自前ツールの確認） | できる | `uvicorn`。AWS リソース不要 |
| エージェントとのチャット（結合） | できない | 中継 Lambda 専用の実行ロールによる SigV4 署名が必要 |

エージェントとの結合確認は、Amplify Hosting にデプロイした環境で行ってください。

## エージェントを単体で動かす

```bash
cd agents/app/AWS_MCP_Agent
uv sync --group dev --python 3.13
LOCAL_DEV=1 uv run uvicorn main:app --host 0.0.0.0 --port 8080
```

別のターミナルから叩きます。

```bash
curl http://localhost:8080/ping

curl -N -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{
    "threadId": "test-1", "runId": "run-1",
    "messages": [{"id": "m1", "role": "user", "content": "1+2は？"}],
    "tools": [], "context": [], "state": {}, "forwardedProps": {}
  }'
```

AWS を操作するツールはセッションのロール（`X-Role-Names` ヘッダー）が無いため使えません。
自前実装のツール（計算・日時・単位変換）までの確認になります。

## テストと lint

```bash
# Web アプリ
npm run lint
npx tsc --noEmit
npm run test

# エージェント
cd agents/app/AWS_MCP_Agent
uv sync --group dev --python 3.13
uv run pytest
uvx ruff check .
```

> **ruff の設定**: `pyproject.toml` の `[tool.ruff.lint]` で適用ルールを
> `["E4", "E7", "E9", "F", "I", "UP", "B"]` に固定しています。明示しているため、
> ruff のバージョンが上がっても指摘件数は動きません。スタイル系（`E501`、`TRY`、`SIM`、
> `RUF`）は入れていません。特に `RUF001/002/003` は日本語のコメントと docstring を
> 「曖昧な Unicode」として数百件報告するため、このリポジトリでは実質ノイズになります。

## 変更をデプロイする

```bash
git push origin <ブランチ名>   # Amplify Hosting が自動デプロイ
```

フロントエンド・バックエンド・エージェントのどれを変更した場合も同じです。
エージェントの配布用パッケージは `amplify.yml` の `preBuild` が作るため、
`./scripts/build-agent-package.sh` を手元で実行する必要があるのは sandbox にデプロイする
ときだけです。

依存を追加したときは、先に `uv.lock` を更新してください（パッケージのビルドがこの
ロックファイルを使います）。

```bash
cd agents/app/AWS_MCP_Agent
uv add <package-name>       # uv.lock も更新される
```

## リソース名と環境の対応

Runtime 名 / Memory 名は Amplify のバックエンド識別子から作られます
（`main` ブランチなら `AWS_MCP_Agent_main_branch`）。同一アカウントに複数のブランチ環境を
共存させられます。**名前を変えるとリソースが置き換わり、Memory の置き換えは会話履歴の
断絶を意味します**。詳細は
[docs/environments.md](docs/environments.md#リソース名の付き方) を参照してください。

---

# 設計の要点

## 操作の境界を実際に守っているのは IAM ロールの権限です

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

## 中継 Lambda（`copilotkitStreamingRelay`）について

CopilotKit Runtime の中継処理（認証ゲート・SigV4 署名・セッションヘッダー伝播・AgentCore
Runtime への転送）は、Next.js の Route Handler ではなく `amplify/functions/copilotkitStreamingRelay/`
の独立した Lambda 関数として実装しています。

理由は Amplify Hosting の SSR Compute がレスポンスストリーミング
（`awslambda.streamifyResponse()`）を有効化しないためです。以前は Next.js の Route Handler
（`src/app/api/copilotkit/route.ts`、削除済み）が中継していましたが、AgentCore Runtime からの
`text/event-stream` が本番環境でのみバッファリングされ、応答が完了後に一括で返る問題が
ありました。この Lambda は Node.js マネージドランタイム上でネイティブに
`awslambda.streamifyResponse()` を使い、**Lambda 関数 URL**（`InvokeMode: RESPONSE_STREAM`）
として公開することでこの制約を回避します。

デプロイは既存のフローに統合されています（`amplify/backend.ts` の `defineBackend` に含まれる
ため、別のコマンドや CDK スタックは不要）。手動設定が必要な環境変数は
`NEXT_PUBLIC_COPILOTKIT_RELAY_URL`（フロントエンドが参照する関数 URL）だけで、残りは
`backend.ts` が配線します。

| 変数 | 供給元 |
|------|--------|
| `AGENTCORE_RUNTIME_ARN` / `AGENTCORE_MEMORY_ID` | `amplify/agent/resource.ts` が作成した Runtime / Memory |
| `CHAT_SESSION_TABLE_NAME` | `backend.data.resources.tables["ChatSession"]` |
| `COGNITO_USER_POOL_ID` / `COGNITO_USER_POOL_CLIENT_ID` | `backend.auth.resources.userPool` / `userPoolClient` |

CDK がこの Lambda 専用の実行ロールを作り、`bedrock-agentcore:InvokeAgentRuntime`（Resource は
作成した Runtime の ARN に限定）と、履歴復元のための読み取り専用権限
（`bedrock-agentcore:ListEvents`、`ChatSession` テーブルの読み取り）を付与します。

> **CORS について**: CORS は Lambda 関数 URL の設定（`resource.ts` の
> `cors: { allowedOrigins: ["*"] }`）が唯一の源泉です。AWS が OPTIONS プリフライトに
> 自動応答し、実レスポンスにも `Access-Control-Allow-Origin` を付与します。CopilotKit
> Runtime 側のヘッダー付与は無効化しています（`cors: { origin: [] }`）。両方が付けると
> ブラウザが重複ヘッダーで CORS エラーにするためです。認証は Bearer トークン（Cognito JWT）
> で行っており、オリジン制限に依存した認可設計ではないため `["*"]` を使っています。

## 会話履歴は AgentCore Memory が正

発言本文（ユーザー発言・アシスタント応答）の唯一の正は AgentCore Memory です
（`actor_id` = Cognito `sub`、`session_id` = `ChatSession.id` でスコープ）。
`ChatSession`（セッション名・更新日時・選択したロール）は DynamoDB に保持します。

- 過去セッションの履歴は、中継 Lambda の専用経路
  `GET {functionUrl}/memory/events?sessionId=...` から読み出します。`ListEvents` の
  `nextToken` を全ページ辿り、古い順に整列して返します。フロントエンド
  （`src/lib/agent/useSessionMemoryRestore.ts`）は選択したセッションの分だけ遅延取得します。
  ツール呼び出し（`toolUse`）と実行結果（`toolResult`）からツールカードも再構築します
- この経路は `actor_id` を信頼する前に、`aws-jwt-verify` で Cognito JWT の**署名を検証**します。
  関数 URL の認証タイプが `NONE` であるため、この検証が偽造トークンによる他ユーザーの
  履歴読み出しを防ぐ要になります。さらに `ChatSession.ownerUserId` と認証済みユーザーの
  `actor_id` を照合し、不一致なら `ListEvents` を発行せず 403 を返します
- 長期記憶戦略（`semantic_facts`、SEMANTIC、名前空間
  `/strategy/{memoryStrategyId}/actor/{actorId}/`）を有効化しており、`actor_id` 単位で
  セッションをまたいだ記憶抽出ができます。短期記憶の保持期間は 365 日です
- Memory は `RemovalPolicy.RETAIN` です。Amplify アプリを削除しても残ります

## リージョンの扱い

リージョンはコードにハードコードしていません。Cognito / AppSync / DynamoDB / 中継 Lambda /
AgentCore Runtime / Memory / Bedrock のモデルは、すべて Amplify アプリのリージョンに揃います。
AWS MCP エンドポイントだけは `us-east-1` 固定（既定値）で、これはサービス自身の
エンドポイントでありデプロイ先とは無関係です。詳細は
[docs/architecture-aws-mcp.md](docs/architecture-aws-mcp.md#リージョンの扱い) を参照してください。

## コスト確認用タグ

Amplify バックエンドスタック（`amplify/backend.ts` の `Tags.of(backend.stack)`）に
`Project` / `Environment` タグを設定しています。AgentCore の Runtime / Memory も同じスタックに
含まれるためタグが伝播します。コスト配分レポート（AWS Billing → コスト配分タグ）で
`Project` で絞り込むと、このアプリに関連するリソースのコストをまとめて確認できます。

`Environment` の値は、Amplify Hosting のビルド時に自動設定される `AWS_BRANCH`（例: `main`）を
使い、ローカルの sandbox では `sandbox` にフォールバックします。自分のプロジェクトとして
使う場合は `backendTags.add('Project', ...)` の値を実際のプロジェクト名に変更してください。

## その他のセキュリティ上の注意

- ロールの ARN・AWS アカウント ID は、`/api/roles` のレスポンスおよびエージェントの
  システムプロンプトから常に除外されます。一般ユーザーに見えるのは表示名・アカウント
  ラベル・操作スコープのみです
- ロールの登録・編集・無効化は Cognito の `ADMINS` グループのユーザーのみ行えます
- `.env.local` や Amplify コンソールの環境変数に AWS 認証情報やシークレットを直接
  書き込まないでください
- Fork・公開する場合は、`.env.local` と `amplify_outputs.json` に実際のアカウント ID・ARN・
  エンドポイント URL が含まれていないか確認してください（`.gitignore` で主要なファイルは
  除外済みですが、既にコミット履歴に入っている場合は履歴からの除去が必要です）

---

# その他

## お片付け（リソース削除）

```bash
# 1. Amplify Hosting の削除（AWS コンソール → Amplify → アプリを削除）

# 2. sandbox の停止（ローカルで使っていた場合）
npx ampx sandbox delete
```

AgentCore Runtime・中継 Lambda・Runtime 実行ロールはバックエンドスタックの一部なので
自動的に削除されます。

手動で残るものは次のとおりです。いずれも不要になったら削除してください
（[docs/environments.md](docs/environments.md#リソースの削除)）。

- **AgentCore Memory**（`RemovalPolicy.RETAIN` のため会話履歴を守るために残ります）
- 手順 3 で作ったコンピューティングロール
- 手順 4 で作った `AgentMCPAdminRole` / `AgentMCPReadOnlyRole`

## ブランチ戦略と CI/CD

| ブランチ | 用途 |
|---------|------|
| `main` | 本番向け |
| `develop` | 統合ブランチ |
| `feature/*` | 実装作業用 |

各ブランチがどの AWS リソースに対応するかは
[docs/environments.md](docs/environments.md) にまとめています。

| 対象 | 品質ゲート（GitHub Actions） | デプロイ |
|------|------------------------------|---------|
| Web アプリ | `.github/workflows/ci.yml` — lint（ESLint）、型チェック（`tsc --noEmit`） | Amplify Hosting（Git push で自動） |
| エージェント | なし（CI 未設定）。手元で `pytest` と `ruff` を実行する | Amplify Hosting（Git push で自動、`AGENT_ENABLED=true` のブランチ） |

`ci.yml` は `agents/**` / `docs/**` / `.kiro/**` / `*.md` を `paths-ignore` しているため、
エージェントコードのみの変更では CI が起動しません。

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
| [docs/environments.md](docs/environments.md) | 環境と運用（sandbox / ブランチ環境の対応関係、環境変数の設定場所、環境を作り直したときの更新手順） |
| [docs/deployment.md](docs/deployment.md) | デプロイ手順の詳細（IAM ポリシーの具体例、クロスアカウントの AssumeRole） |
| [docs/architecture-aws-mcp.md](docs/architecture-aws-mcp.md) | 接続アーキテクチャ、リージョンの扱い、既知の制約、ログ確認 |
| [docs/kiro-usage.md](docs/kiro-usage.md) | Kiro（IDE）の steering/skills の使い方 |
| [agents/README.md](agents/README.md) | エージェントコードの構成・ローカル実行・実行環境の仕様 |

## ライセンス

[LICENSE](LICENSE) を参照してください（MIT No Attribution）。コントリビュートについては
[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。
