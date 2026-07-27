# 環境と運用

Web アプリとエージェントは同じ Amplify バックエンドスタックに載っているため、
**環境の単位は Amplify のブランチ（と sandbox）だけ**です。エージェント側に別の
環境概念はありません。

- 初回セットアップ: [setup.md](setup.md)
- デプロイ手順: [deployment.md](deployment.md)
- 接続アーキテクチャの詳細: [architecture-aws-mcp.md](architecture-aws-mcp.md)

## 環境の一覧

| 環境 | フロントエンド | バックエンド（Cognito / AppSync / DynamoDB / 中継 Lambda / AgentCore） | 主な用途 |
|------|---------------|--------------------------------------------------|---------|
| ローカル（エージェント単体） | — | — | エージェントのロジック確認（`uvicorn`） |
| ローカル + sandbox | `npm run dev`（localhost:3000） | `npx ampx sandbox`（開発者ごとに独立） | UI・バックエンドの反復開発 |
| ステージング（任意） | Amplify Hosting `develop` | `develop` ブランチのスタック | 結合テスト |
| 本番 | Amplify Hosting `main` | `main` ブランチのスタック | 本番運用 |

環境を増やすには Amplify Hosting にブランチを追加するだけです。AgentCore の設定を
別途足す作業はありません。

## リソース名の付き方

AgentCore の Runtime 名 / Memory 名はアカウント・リージョン単位で一意である必要が
あるため、Amplify のバックエンド識別子（CDK コンテキストの `amplify-backend-name` /
`amplify-backend-type`）からサフィックスを作っています。

| 環境 | Runtime 名 | Memory 名 |
|------|-----------|----------|
| `main` ブランチ | `AWS_MCP_Agent_main_branch` | `AWS_MCP_AgentMemory_main_branch` |
| `develop` ブランチ | `AWS_MCP_Agent_develop_branch` | `AWS_MCP_AgentMemory_develop_branch` |
| sandbox（`alice`） | `AWS_MCP_Agent_alice_sandbox` | `AWS_MCP_AgentMemory_alice_sandbox` |

CloudWatch Logs のロググループ名やコスト分析で、どの環境のものか読み取れます。

> **重要**: このサフィックスが変わると Runtime と Memory は「別のリソース」になり
> 置き換えが発生します。**Memory の置き換えは会話履歴の断絶を意味します。**
> ブランチ名の変更や命名規則の見直しは、本番の初回デプロイより前に済ませてください。

## ローカルでできること・できないこと

| 機能 | ローカル | 備考 |
|------|:-------:|------|
| Todo リスト・認証 | ✅ | `npx ampx sandbox` の Cognito / AppSync を使用 |
| エージェント単体（`/ping`・`/invocations`） | ✅ | `uvicorn`。AWS リソースは作らない |
| フロントエンド + エージェントの結合 | ❌ | 中継 Lambda 専用の実行ロールによる SigV4 署名が必要 |

sandbox の Cognito ユーザープールは Amplify Hosting のものとは別実体です。sandbox で
作ったユーザーで Hosting 環境にログインすることはできません。結合テストは Amplify
Hosting のデプロイ環境で行ってください。本番に影響を与えずに検証したいなら
`develop` ブランチを用意します。

## 環境変数の設定場所

| 変数 | ローカル + sandbox | Amplify Hosting |
|------|-------------------|-----------------|
| `AGENT_ENABLED` | シェルの環境変数（`AGENT_ENABLED=true npx ampx sandbox`） | コンソール →「ホスティング」→「環境変数」 |
| `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` | `.env.local` | 同上 |
| `ROLE_CONFIG_TABLE_NAME` | `.env.local` | 同上（`amplify.yml` が `.env.production` に書き出す） |

**手動設定が必要なのはこの 3 つだけです。** 以下は CDK が synth 時に解決するため、
設定する必要がありません。

| 値 | 供給元 |
|----|--------|
| Runtime の `ROLE_CONFIG_TABLE_NAME` | RoleConfig テーブルの L2 から解決 |
| Runtime 実行ロールの `dynamodb:Scan` の対象 | 同テーブルの ARN |
| Runtime 実行ロールの `sts:AssumeRole` の対象 | ロール名 + `AWS::AccountId` |
| 中継 Lambda の `AGENTCORE_RUNTIME_ARN` | 作成した Runtime の ARN |
| 中継 Lambda の `AGENTCORE_MEMORY_ID` | 作成した Memory の ID |
| 中継 Lambda の `CHAT_SESSION_TABLE_NAME` | ChatSession テーブルの L2 から解決 |
| 中継 Lambda の `COGNITO_USER_POOL_ID` / `..._CLIENT_ID` | Cognito リソースから解決 |

`NEXT_PUBLIC_COPILOTKIT_RELAY_URL` と `ROLE_CONFIG_TABLE_NAME` が手動なのは、どちらも
Next.js のビルド時 / SSR 実行時に読まれる値で、CDK からフロントエンドのビルド環境へ
値を渡す経路がないためです。値自体は `amplify_outputs.json` の `custom` に出力されます。

```bash
cat amplify_outputs.json | jq .custom
```

## コスト配分タグ

| 設定箇所 | `Project` | `Environment` |
|---------|-----------|---------------|
| `amplify/backend.ts`（`Tags.of(backend.stack)`） | `aws-operation-agent` | `AWS_BRANCH`（例: `main`）。sandbox 実行時は `sandbox` |

AgentCore のリソースも同じスタックに含まれるため、このタグが伝播します。以前は
AgentCore CLI 側で別途タグを設定する必要がありましたが、統合により 1 箇所になりました。

`Project` の値を変える場合は `amplify/backend.ts` の `backendTags.add('Project', ...)`
を書き換えてください（詳細は
[README のコスト確認用タグ](../README.md#コスト確認用タグ)）。

## 環境を作り直したとき

`npx ampx sandbox delete` の後に再作成した場合や、新しい Amplify アプリに貼り替えた
場合、DynamoDB テーブル名などは変わりますが、**Runtime / Memory / IAM の参照は
CDK が解決し直すため手作業は不要**です（統合前は 3 箇所を手で合わせる必要がありました）。

手作業が必要なのは次の 3 点だけです。

1. `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` と `ROLE_CONFIG_TABLE_NAME` を新しい値に更新する
   （`amplify_outputs.json` の `custom` から）
2. Cognito ユーザープールも作り直されているため、管理者ユーザーと `ADMINS` グループ、
   および画面からのロール登録をやり直す
3. Runtime 実行ロールも作り直されるため、`AgentMCPReadOnlyRole` /
   `AgentMCPAdminRole` の信頼ポリシーを新しい実行ロールの ARN に更新する

3 番目を忘れると、ツール呼び出しが `sts:AssumeRole` の `AccessDenied` になります。

## リソースの削除

```bash
# 1. AWS コンソール → Amplify → アプリを削除
# 2. sandbox を使っていた場合
npx ampx sandbox delete
```

AgentCore Memory は `RemovalPolicy.RETAIN` のため残ります（会話履歴を守るため）。
不要なら手動で削除してください。

```bash
aws bedrock-agentcore-control list-memories
aws bedrock-agentcore-control delete-memory --memory-id <ID>
```

手動で作成した `AgentMCPReadOnlyRole` / `AgentMCPAdminRole` も CDK 管理外のため、
不要になったら手動で削除してください。Amplify Hosting のコンピューティングロールは
Amplify が管理するため、ロール自体は削除しないでください。

> **初回デプロイが失敗したときの Memory**: `RemovalPolicy.RETAIN` のため、失敗した
> スタックがロールバックしても Memory は残ります。同じ環境名で作り直すと名前が衝突
> するので、再試行の前に孤児を削除してください（上記のコマンド）。
