# サンプルページ

`/sample` で表示されるサンプルページのドキュメントです。

## ページ構成

サンプルページは2つのセクションで構成されています:

1. **Todo リスト** — Amplify Data（AppSync + DynamoDB）との CRUD 連携デモ
2. **エージェントチャット** — AG-UI プロトコル + CopilotKit による AgentCore Runtime 対話デモ

どちらもスターターテンプレートのサンプル実装であり、プロジェクトに合わせて置き換え・拡張することを想定しています。

## ドキュメント

| ファイル | 内容 |
|---------|------|
| [todo.md](./todo.md) | Todo リストの機能・データモデル・カスタマイズ方法 |
| [agent-chat.md](./agent-chat.md) | エージェントチャットの通信方式・ストリーミング・エラーハンドリング |

## アクセス方法

1. `npx ampx sandbox` で Amplify sandbox を起動
2. `npm run dev` で開発サーバーを起動
3. ブラウザで `http://localhost:3000/sample` にアクセス

Todo リストは sandbox 起動のみで動作します。エージェントチャットは追加で AgentCore Runtime のデプロイと、
`AGENTCORE_RUNTIME_ARN`（`copilotkitStreamingRelay` Lambda の環境変数）・
`NEXT_PUBLIC_COPILOTKIT_RELAY_URL`（フロントエンドが接続する関数 URL）の設定が必要です
（詳細はリポジトリルートの [README.md](../../README.md#新しい-lambda-関数copilotkitstreamingrelayについて) を参照）。