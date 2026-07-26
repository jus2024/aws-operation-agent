# デプロイガイド

Amplify Hosting（フロントエンド + Cognito）と AgentCore Runtime（エージェント）は別々にデプロイします。
エージェントとの接続には、Amplify Hosting のコンピューティングロールに IAM 権限を追加する必要があります。

## 全体像

> **Note**: CopilotKit Runtime の中継処理は、以前は Amplify Hosting の SSR Lambda
> （Next.js Route Handler `/api/copilotkit`）が担っていましたが、Amplify Hosting の
> SSR Compute はレスポンスストリーミング（`awslambda.streamifyResponse()`）を
> サポートしないため、本番環境でのみ応答がバッファリングされる問題がありました。
> 現在は `amplify/functions/copilotkitStreamingRelay/` に定義された独立の Lambda 関数
> （Amplify Gen 2 の `defineFunction` カスタム CDK、Lambda 関数 URL・
> `InvokeMode: RESPONSE_STREAM`）が中継処理を行います。`route.ts` は削除済みです。

```
┌─────────────────────────────────────────────────────────────┐
│ Amplify Hosting                                             │
│                                                             │
│  Cognito User Pool (ユーザー認証)                             │
│  AppSync + DynamoDB (データ)                                 │
│  Next.js SSR Lambda (コンピューティングロール、/api/roles のみ)   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Amplify Gen 2 バックエンド（amplify/backend.ts で配線）         │
│                                                             │
│  copilotkitStreamingRelay Lambda（専用実行ロール）              │
│    Lambda 関数 URL (RESPONSE_STREAM)                        │
│    └─ 認証ゲート → SigV4 署名 → AgentCore Runtime            │
└─────────────────────────────────────────────────────────────┘
          │ SigV4 (IAM)
          ▼
┌─────────────────────────────────────────────────────────────┐
│ AgentCore Runtime                                           │
│                                                             │
│  AWS_MCP_Agent / AWS_MCP_Agent_Prod (AG-UI プロトコル)         │
│    └─ Strands Agent + ag-ui-strands                         │
└─────────────────────────────────────────────────────────────┘
```

**認証フロー:**
1. ブラウザ → Cognito 認証 → JWT トークン取得
2. ブラウザ → `copilotkitStreamingRelay` の Lambda 関数 URL に Bearer トークン付きリクエスト
3. Lambda → Cognito トークンの存在を確認（ユーザー認証ゲート）
4. Lambda → 専用実行ロールの IAM 権限で SigV4 署名
5. Lambda → AgentCore Runtime に署名済みリクエスト送信、応答をストリーミングでブラウザに逐次転送

---

## 1. Amplify Hosting（フロントエンド）

### 初回接続

1. AWS コンソールで Amplify を開く
2. 「新しいアプリ」→「GitHub」を選択
3. リポジトリとブランチを選択
4. ビルド設定を確認（`amplify.yml` が自動検出されます）
5. デプロイ

デプロイ完了後、以下のリソースが自動作成されます:
- Cognito User Pool（ユーザー認証）
- AppSync API + DynamoDB（データ）
- SSR Lambda + コンピューティングロール（Next.js サーバーサイド実行）

### ブランチ別デプロイ

| ブランチ | 環境 | 対応する AgentCore Runtime |
|---------|------|---------------------------|
| `main` | 本番 | `AWS_MCP_Agent_Prod` |
| `develop` | ステージング（任意） | 既定では未割り当て（[environments.md](environments.md#環境の一覧) を参照） |

各環境が指す Cognito ユーザープール・RoleConfig テーブル・Runtime の対応関係は
[environments.md](environments.md) にまとめています。

### CI/CD の流れ

```
Push → GitHub Actions（lint / 型チェック）→ Amplify Hosting（ビルド / デプロイ）
```

---

## 2. AgentCore Runtime（エージェント、任意）

エージェント機能を使う場合のみ必要です。

### 前提条件

- AgentCore CLI がインストール済み
  ```bash
  npm install -g @aws/agentcore
  ```
- AWS 認証情報が設定済み
- Docker が起動している（Container ビルドのため）
- **プレースホルダ（`<YOUR_AWS_ACCOUNT_ID>` / `<SANDBOX_APPSYNC_API_ID>` /
  `<PROD_APPSYNC_API_ID>` / `<YOUR_REGION>`）を自分の環境の値に置き換え済み**
  — 埋める値と取得方法は
  [setup.md のプレースホルダと ID の埋め方](setup.md#プレースホルダと-id-の埋め方エージェント機能を使う場合)
  を参照。`<SANDBOX_APPSYNC_API_ID>` / `<PROD_APPSYNC_API_ID>` は RoleConfig テーブル名の
  一部で、**手順 1（Amplify のデプロイ）を先に済ませないと値が分かりません**。
  未置換のまま `agentcore deploy` すると、存在しない ARN を参照した IAM ポリシーが作られ、
  実行時に `AccessDenied` になります

### 2-1. デプロイ

```bash
cd agents
agentcore deploy
```

初回は CDK の bootstrap とインフラ構築で数分かかります。

### 2-2. Runtime ARN の確認

デプロイ完了後、`agentcore status` で Runtime ARN を確認します:

```bash
agentcore status
```

出力例:

```
AgentCore Status (target: default, us-west-2)
Agents
  MyAgent: Deployed - Runtime: READY (arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/agents_MyAgent-xxxxxxxxxx)
  URL: https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/...
```

`arn:aws:bedrock-agentcore:...` の部分が Runtime ARN です。手順 4 で環境変数に設定するので控えてください。

### 2-3. 動作確認

```bash
agentcore invoke
```

対話 UI でエージェントを選択し、テストメッセージを送信して動作確認します。

---

## 3. AgentCore 呼び出し権限（copilotkitStreamingRelay、手動設定不要）

`bedrock-agentcore:InvokeAgentRuntime` の権限は、Amplify Hosting のコンピューティングロールでは
**なく**、`amplify/functions/copilotkitStreamingRelay/resource.ts` が定義する専用の Lambda 実行ロールに
付与されます。この実行ロールは Amplify バックエンドのデプロイ（`npx ampx sandbox` /
`npx ampx pipeline-deploy`、後述の手順1に含まれる）時に CDK が自動的に作成し、
インラインポリシーとして権限を付与するため、本セクションの手動設定は不要です。

- ポリシーの `Resource` は、後述の環境変数 `AGENTCORE_RUNTIME_ARN` から
  `[<ARN>, "<ARN>/*"]` の形で自動導出されます（`resource.ts` 参照）。
- `AGENTCORE_RUNTIME_ARN` が未設定の場合、`'*'` へのフォールバックはせず、
  ポリシー自体を付与しません（新規クローン直後にエージェント機能なしで
  Amplify バックエンド全体を synth/deploy できるようにするため）。

> Amplify Hosting のコンピューティングロールに必要な権限は `dynamodb:Scan`
> （`/api/roles` 用）のみです。`bedrock-agentcore:InvokeAgentRuntime` を
> コンピューティングロールに追加する必要はありません。

---

## 4. 環境変数の設定

Amplify コンソール → アプリ → ホスティング → 環境変数:

| キー | 値 | 説明 |
|------|-----|------|
| `AGENTCORE_RUNTIME_ARN` | 手順 2-2 で取得した ARN（本番は `AWS_MCP_Agent_Prod`） | `copilotkitStreamingRelay` Lambda の環境変数、および IAM ポリシーの `Resource` の両方に使われる（`NEXT_PUBLIC_` プレフィックスは不要。サーバーサイド専用） |
| `AGENTCORE_MEMORY_ID` | `agentcore status` に表示される Memory ID（例: `agents_AWS_MCP_AgentMemory-XXXXXXXXXX`） | 会話履歴の読み出し（`bedrock-agentcore:ListEvents`）の呼び出しと IAM ポリシーの `Resource` に使われる。未設定だとポリシー自体が付与されず、過去セッションの履歴復元が 500 になる |
| `NEXT_PUBLIC_COPILOTKIT_RELAY_URL` | `copilotkitStreamingRelay` の関数 URL | デプロイ後、`amplify_outputs.json` の `custom.copilotkitRelayUrl` で確認できる。`CopilotProvider.tsx` の `runtimeUrl` が参照する |
| `ROLE_CONFIG_TABLE_NAME` | RoleConfig テーブル名（例: `RoleConfig-xxxxxxxx-NONE`） | `GET /api/roles` が DynamoDB を `Scan` する対象。`agents/agentcore/agentcore.json` の同名の値と同じテーブルを指すこと |

設定後、再デプロイ（Amplify コンソールで「再ビルド」をトリガー、または Git push）が必要です。
`AGENTCORE_RUNTIME_ARN` と `AGENTCORE_MEMORY_ID` はバックエンドビルド
（`npx ampx pipeline-deploy`）の CDK synth 時に読まれるため、値を変更した場合は
バックエンドの再デプロイも必要です。

---

## 5. 動作確認

再デプロイ完了後:

1. Amplify Hosting の URL にアクセス
2. Cognito でログイン
3. トップページで新規チャットを作成し、利用するロールを選んでメッセージを送信
   （ロールが一覧に出ない場合は `ROLE_CONFIG_TABLE_NAME` と、管理者による
   ロール登録が済んでいるかを確認）
4. AG-UI ストリーミングで応答が表示されれば成功

### トラブルシューティング

| 症状 | 原因 | 対処 |
|------|------|------|
| 「AgentCore Runtime が設定されていません」 | `AGENTCORE_RUNTIME_ARN` 未設定 | 手順 4 を確認し、バックエンドを再デプロイ |
| 401 Unauthorized | Cognito 未ログイン | ログイン画面でサインイン |
| 500 Internal Server Error | `copilotkitStreamingRelay` の実行ロールの権限不足、または `AGENTCORE_RUNTIME_ARN` 未設定 | 手順 3・4 を確認 |
| タイムアウト | AgentCore Runtime 未デプロイ | 手順 2 を確認 |
| `SignatureDoesNotMatch` | リージョン不一致 | `copilotkitStreamingRelay/handler.ts`（または `relay.ts`）の `REGION` 定数と Runtime のリージョンを確認 |
| 過去セッションを開くと履歴が復元されず 500 | `AGENTCORE_MEMORY_ID` 未設定（`ListEvents` の IAM ポリシーが付与されていない） | 手順 4 で `AGENTCORE_MEMORY_ID` を設定し、バックエンドを再デプロイ |
| ロール一覧が空 / 新規チャットのダイアログがすぐ閉じる | `ROLE_CONFIG_TABLE_NAME` 未設定または誤り、または `agentcore.json` 側と値が不一致 | 手順 4 と `agents/agentcore/agentcore.json` の `ROLE_CONFIG_TABLE_NAME` を突き合わせる |
| エージェントのツール呼び出しが `AccessDenied` | `cdk-stack.ts` のプレースホルダが未置換（存在しないロール/テーブル ARN を参照） | [setup.md のプレースホルダと ID の埋め方](setup.md#プレースホルダと-id-の埋め方エージェント機能を使う場合) を確認し、`agentcore deploy` を再実行 |

CloudWatch Logs で詳細を確認:
- `copilotkitStreamingRelay` Lambda のログ: `/aws/lambda/<関数名>`（Lambda 関数名は CloudFormation スタックの出力、または Lambda コンソールで確認）
- Amplify SSR Lambda（`/api/roles` 用）のログ: `/aws/amplify/<app-id>/<branch>/compute`
- AgentCore Runtime のログ: `agentcore logs`

---

## 6. プログラム更新時のデプロイ

### フロントエンドの更新

```bash
git push origin <ブランチ名>
```

Amplify Hosting が Git push を検知して自動ビルド・デプロイします。

### エージェントの更新

```bash
cd agents
agentcore deploy
```

### 両方を更新する場合

エージェント側を先にデプロイしてください。

1. `cd agents && agentcore deploy`
2. `git push` でフロントエンドをデプロイ

---

## 7. エージェントの追加

新しいエージェントを追加する場合:

```bash
cd agents
agentcore add agent
```

追加後、`agentcore.json` に新しい Runtime エントリが追加されます。`copilotkitStreamingRelay/handler.ts` の `agents` オブジェクトにも対応する HttpAgent を追加してください。

---

## 8. お片付け（リソース削除）

### 削除順序

1. **AgentCore Runtime** → 2. **Amplify Hosting** → 3. **sandbox**

### AgentCore Runtime の削除

```bash
cd agents
agentcore remove all --yes && agentcore deploy
```

### Amplify Hosting の削除

1. AWS コンソール → Amplify → アプリを選択
2. 「アプリの設定」→「全般」→「アプリを削除」

`copilotkitStreamingRelay` の Lambda・関数 URL・専用の実行ロールとインラインポリシーは
Amplify バックエンドの CDK スタックの一部としてデプロイされているため、Amplify アプリの
削除に伴って自動的に削除されます（手動での IAM ポリシー削除は不要です）。

### sandbox の停止

```bash
npx ampx sandbox delete
```

---

## 注意事項

- 環境変数は Amplify コンソールで設定してください（シークレットをリポジトリにコミットしない）
- Amplify のビルド環境は Docker 非対応のため、AgentCore Runtime を Amplify の CDK スタックに含めない
- sandbox の Cognito と Amplify Hosting の Cognito は異なるため、sandbox 環境でのエージェント結合テストは不可
  （結合テストは Amplify Hosting のデプロイ環境、`develop` ブランチ推奨。詳細は
  [environments.md](environments.md#ローカルでできることできないこと)）
- コンピューティングロールは Amplify が管理するため、ロール自体を削除しないこと
- `copilotkitStreamingRelay`（CopilotKit Runtime の中継処理を行う Lambda 関数、`amplify/functions/copilotkitStreamingRelay/`）は
  Amplify Gen 2 のバックエンド定義の一部としてデプロイされるため、`agentcore deploy` の対象ではない
  （エージェント自体は `agents/` 配下、中継用 Lambda は `amplify/` 配下、という責務分離を維持している）
