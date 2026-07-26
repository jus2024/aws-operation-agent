# 環境と運用

このアプリは「Amplify（Web + バックエンド）」と「AgentCore（エージェント実行基盤）」の
2 系統を別々にデプロイします。両者の環境の切り方が異なるため、どの環境がどのリソースを
指しているかをこのドキュメントに集約しています。

- 初回セットアップの手順: [setup.md](setup.md)
- デプロイの手順: [deployment.md](deployment.md) と [README](../README.md#エージェントを動かすデプロイが必要)
- 接続アーキテクチャの詳細: [architecture-aws-mcp.md](architecture-aws-mcp.md)

## 環境の一覧

| 環境 | フロントエンド | Amplify バックエンド（Cognito / AppSync / DynamoDB / 中継 Lambda） | AgentCore Runtime | 主な用途 |
|------|---------------|--------------------------------------------------|------------------|---------|
| ローカル（エージェント単体） | — | — | 使わない（`agentcore dev` / `uvicorn` で起動） | エージェントのロジック確認 |
| ローカル + sandbox | `npm run dev`（localhost:3000） | `npx ampx sandbox`（開発者ごとに独立） | `AWS_MCP_Agent` | UI・バックエンドの反復開発 |
| ステージング | Amplify Hosting `develop` | `develop` ブランチのバックエンド | 既定では未割り当て（後述） | 結合テスト |
| 本番 | Amplify Hosting `main` | `main` ブランチのバックエンド | `AWS_MCP_Agent_Prod` | 本番運用 |

`agents/agentcore/agentcore.json` に定義されている Runtime は `AWS_MCP_Agent`（sandbox 向け）と
`AWS_MCP_Agent_Prod`（`main` 向け）の 2 つだけです。両方が `agentcore deploy` で同じ
CloudFormation スタックに同時にデプロイされ、それぞれ独立した Runtime ARN・実行ロール・
IAM 権限を持ちます。AgentCore Memory（`AWS_MCP_AgentMemory`）はプロジェクト内の全 Runtime で
共有されます。

> **`develop` ブランチで結合テストする場合**: `develop` のバックエンドは sandbox でも `main` でも
> ない 3 つ目の RoleConfig テーブルを生成します。そのため、`develop` 用の Runtime エントリを
> `agentcore.json` に追加して（`cdk-stack.ts` の `ROLE_CONFIG_TABLE_ARN_BY_RUNTIME` にも対応する
> ARN を追加）そのテーブルを指すか、一時的に `AWS_MCP_Agent` の `ROLE_CONFIG_TABLE_NAME` を
> `develop` のテーブルに向け替える必要があります。向き先がずれていると、画面から登録した
> ロールがエージェント側の Role_Set 選択に出てきません。

## ローカルでできること・できないこと

| 機能 | ローカル | 備考 |
|------|:-------:|------|
| Todo リスト・認証 | ✅ | `npx ampx sandbox` の Cognito / AppSync を使用 |
| エージェント単体（`/ping`・`/invocations`） | ✅ | `uvicorn` または `agentcore dev`。AWS リソースは作らない |
| フロントエンド + エージェントの結合 | ❌ | 中継 Lambda（`copilotkitStreamingRelay`）専用の実行ロールによる SigV4 署名が必要 |

`npx ampx sandbox` は `copilotkitStreamingRelay` も含めてバックエンドをデプロイしますが、
sandbox の Cognito ユーザープールは Amplify Hosting のものとは別実体です。sandbox で作った
ユーザーで Hosting 環境にログインすることはできません。結合テストは Amplify Hosting の
デプロイ環境（`develop` ブランチ推奨）で行ってください。

## 環境変数の設定場所

| 変数 | ローカル + sandbox | Amplify Hosting | AgentCore Runtime |
|------|-------------------|-----------------|-------------------|
| `AGENTCORE_RUNTIME_ARN` | `.env.local` またはシェルの `export`（CDK synth 時に読まれる） | コンソール →「ホスティング」→「環境変数」 | — |
| `AGENTCORE_MEMORY_ID` | 同上 | 同上 | — |
| `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` | `.env.local`（`amplify_outputs.json` の `custom.copilotkitRelayUrl`） | 同上（環境ごとに URL が異なる） | — |
| `ROLE_CONFIG_TABLE_NAME` | `.env.local` | 同上（`amplify.yml` が `.env.production` に書き出す） | `agentcore.json` の `envVars` |
| `AWS_MCP_ENDPOINT` / `AWS_MCP_REGION` | `.env.local`（単体起動時のみ） | — | `agentcore.json` の `envVars`（未設定時は `us-east-1` の既定値） |
| `COGNITO_USER_POOL_ID` / `COGNITO_USER_POOL_CLIENT_ID` | 自動配線 | 自動配線 | — |

- `AGENTCORE_RUNTIME_ARN` / `AGENTCORE_MEMORY_ID` は **CDK synth 時のシェル環境変数**として
  読まれます。値を変更したら、フロントエンドの再ビルドではなく**バックエンドの再デプロイ**
  （`npx ampx sandbox` / `npx ampx pipeline-deploy`）が必要です。いずれも未設定の場合は
  対応する IAM ポリシーを `'*'` にフォールバックさせず、ポリシー自体を付与しません。
- `ROLE_CONFIG_TABLE_NAME` はサーバーサイド専用のため、Amplify Hosting では
  `amplify.yml` のビルドコマンドで `.env.production` に書き出す必要があります
  （このリポジトリでは対応済み）。詳細は
  [README の手順 3](../README.md#3-amplify-hosting-をデプロイし接続する) を参照。
- `COGNITO_USER_POOL_ID` / `COGNITO_USER_POOL_CLIENT_ID` は `amplify/backend.ts` が
  Cognito リソースから synth 時に自動設定するため、手動設定は不要です。

各変数の値の取得方法は
[setup.md のプレースホルダと ID の埋め方](setup.md#プレースホルダと-id-の埋め方エージェント機能を使う場合)
にまとめています。

## RoleConfig テーブルの見分け方

Amplify Gen 2 が生成する DynamoDB テーブル名は
`<モデル名>-<AppSync API の ID>-<Amplify API 環境名>` という形式です。現在の Amplify Gen 2 は
この「Amplify API 環境名」を sandbox・ブランチデプロイのいずれでも固定文字列 `NONE` にするため、
**どの環境のテーブルも末尾は `-NONE` になります**（ブランチ名はテーブル名に現れません）。
中央の AppSync API ID が異なる別実体です。

どのテーブルがどの環境のものかは、AWS コンソール → DynamoDB → 対象テーブル →「タグ」タブの
`amplify:branch-name` タグで判別してください。

対応関係が崩れやすいのは次の 3 箇所です。**同じ環境では 3 つがすべて同じテーブルを指す**
必要があります。

1. `agents/agentcore/agentcore.json` の該当 Runtime の `ROLE_CONFIG_TABLE_NAME`
2. `agents/agentcore/cdk/lib/cdk-stack.ts` の `ROLE_CONFIG_TABLE_ARN_BY_RUNTIME`（IAM 権限の対象）
3. フロントエンド側の `ROLE_CONFIG_TABLE_NAME`（`.env.local` / Amplify コンソール）

## コスト配分タグ

| 設定箇所 | `Project` | `Environment` |
|---------|-----------|---------------|
| `amplify/backend.ts`（`Tags.of(backend.stack)`） | `aws-operation-agent` | `AWS_BRANCH`（例: `main`）。sandbox 実行時は `AWS_BRANCH` が無いため `sandbox` |
| `agents/agentcore/agentcore.json` の `tags` | `aws-operation-agent` | 固定値 `default`（AgentCore CLI にブランチ＝環境の自動識別が無いため） |

AgentCore 側で環境を分けたい場合は、AgentCore CLI の複数ターゲット（`aws-targets.json`）で
分離し、それぞれの `agentcore.json` の `Environment` を変更してください。`Project` の値を
変える場合は 2 箇所を必ず揃えます（詳細は
[README のコスト確認用タグ](../README.md#コスト確認用タグ)）。

## 環境を作り直したときの更新手順

`npx ampx sandbox delete` の後に再作成した場合や、新しい Amplify アプリに貼り替えた場合、
AppSync API の ID が変わるため RoleConfig テーブル名も変わります。次の順で更新してください。

1. 新しい RoleConfig テーブル名を確認する（`amplify:branch-name` タグで環境を確認）
2. `agents/agentcore/agentcore.json` の該当 Runtime の `ROLE_CONFIG_TABLE_NAME` を更新
3. `agents/agentcore/cdk/lib/cdk-stack.ts` の `ROLE_CONFIG_TABLE_ARN_BY_RUNTIME` の該当 ARN を更新
4. `cd agents && agentcore deploy`（Runtime 実行ロールの IAM 権限を貼り替える）
5. フロントエンド側の `ROLE_CONFIG_TABLE_NAME` を更新して再デプロイ
6. Cognito ユーザープールも作り直されているため、管理者ユーザーと `ADMINS` グループ、
   および画面からのロール登録をやり直す

## 更新の順序

エージェントとフロントエンドの両方を更新する場合は、**エージェント → フロントエンド**の順に
デプロイします（新しい Runtime ARN をフロントエンド側の環境変数に反映するため）。

```bash
# エージェント
cd agents && agentcore deploy

# Web アプリ
git push origin <ブランチ名>   # Amplify Hosting が自動デプロイ
```

## リソースの削除

```bash
# 1. AgentCore Runtime / Memory / Gateway の削除
cd agents
agentcore remove all --yes
agentcore deploy

# 2. Amplify Hosting の削除（AWS コンソール → Amplify → アプリを削除）

# 3. sandbox の停止
npx ampx sandbox delete
```

`copilotkitStreamingRelay` の Lambda・関数 URL・専用の実行ロールは Amplify バックエンドの
CDK スタックの一部なので、Amplify アプリの削除に伴って自動削除されます。一方、手動で作成した
`AgentMCPAdminRole` / `AgentMCPReadOnlyRole` は CDK 管理外のため、不要になったら手動で
削除してください。Amplify Hosting のコンピューティングロールは Amplify が管理するため、
ロール自体は削除しないでください。
