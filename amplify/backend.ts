import { Tags } from 'aws-cdk-lib';
import { defineBackend } from '@aws-amplify/backend';
import type { Function as LambdaFunction, FunctionUrl } from 'aws-cdk-lib/aws-lambda';
import { auth } from './auth/resource.js';
import { data } from './data/resource.js';
import { copilotkitStreamingRelay } from './functions/copilotkitStreamingRelay/resource.js';

const backend = defineBackend({
  auth,
  data,
  copilotkitStreamingRelay,
});

// 高感度変更（認証変更 / F2）: セルフサインアップを無効化
// 管理者のみがユーザーを作成可能になる
// Requirements: 9.1
const { cfnUserPool } = backend.auth.resources.cfnResources;
cfnUserPool.adminCreateUserConfig = {
  allowAdminCreateUserOnly: true,
};

// copilotkitStreamingRelay の関数 URL をフロントエンドが参照できる形で公開する
// (design.md Component 3 / Requirements 3.1)
//
// resource.ts の defineFunction((scope) => new NodejsFunction(...)) コールバック内で
// すでに fn.addFunctionUrl(...) を呼んでおり、CDK の Function#addFunctionUrl は常に
// 固定の子コンストラクト ID 'FunctionUrl' で FunctionUrl を作成する（aws-cdk-lib の
// FunctionBase#addFunctionUrl 実装を確認済み）。そのため、ここで新たに
// addFunctionUrl を呼び直す（二重作成でエラーになる）のではなく、
// backend.copilotkitStreamingRelay.resources.lambda（IFunction、= resource.ts が
// 返した fn そのもの）の construct tree からその子を検索して取得する。
//
// 取得した URL は backend.addOutput({ custom: {...} }) で amplify_outputs.json の
// custom セクションに書き込まれる（ampx sandbox / pipeline-deploy 実行時に生成）。
// フロントエンド（CopilotProvider.tsx、タスク 7.1）はビルド時環境変数
// NEXT_PUBLIC_COPILOTKIT_RELAY_URL を読む設計のため、この custom output は
// 「デプロイ後に値を確認できる場所」として機能する。ローカル開発・sandbox 環境では
// この値を .env.local の NEXT_PUBLIC_COPILOTKIT_RELAY_URL にコピーする必要がある
// （NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN と同じ、README 記載の手動設定パターンに
// 合わせている。本番 Amplify Hosting では Amplify コンソールの環境変数として
// 同様に手動設定する。詳細はタスク 9 の README 更新で追記する）。
const copilotkitRelayFunctionUrl = backend.copilotkitStreamingRelay.resources.lambda.node.findChild(
  'FunctionUrl'
) as FunctionUrl;

backend.addOutput({
  custom: {
    copilotkitRelayUrl: copilotkitRelayFunctionUrl.url,
  },
});

// 高感度（IAM・認証経路）: Memory 読み出しハンドラーの actor_id 事前検証
// （memory-based-chat-history タスク 3.2）が、選択された sessionId に対応する
// ChatSession レコードの ownerUserId を読み取るための DynamoDB 読み取り権限付与。
//
// なぜ resource.ts 単体ではなく backend.ts で行うか:
// `backend.data`（ChatSession テーブルの L2 Table 構築物、
// `backend.data.resources.tables["ChatSession"]`）と
// `backend.copilotkitStreamingRelay`（Lambda 実行ロール）の両方が揃うのは
// `defineBackend({...})` 実行後のみであり、`resource.ts` の
// `defineFunction((scope) => ...)` コールバックは `scope`（Stack 相当）しか
// 受け取らず `backend.data` を参照できない（design.md Component 1 の
// 依存関係の方向）。
//
// grantReadData を選ぶ理由（read-only の最小権限）:
// - この Lambda は ChatSession の `ownerUserId` を読み取って actor_id
//   比較を行うだけであり、ChatSession への書き込みは一切行わない
//   （書き込みは既存の Amplify Data クライアント経由の GraphQL 変更処理が
//   専任のまま）。`grantReadData`（`dynamodb:GetItem`/`Query`/`Scan`/
//   `BatchGetItem`/`ConditionCheckItem`/`DescribeTable` を許可する CDK の
//   標準メソッド）は、書き込み系アクション（`PutItem`・`UpdateItem`・
//   `DeleteItem` 等）を一切含まないため、resource.ts の
//   `bedrock-agentcore:ListEvents` と同じ「読み取り専用アクションのみに
//   限定する」方針と一致する。
// - GSI（`chatSessionsByOwnerUserIdAndUpdatedAt`）へのアクセスはこの
//   Lambda では使わない（`sessionId` = ChatSession.id によるプライマリキー
//   の GetItem のみ）が、`grantReadData` は GSI を含むテーブル全体への
//   読み取りを許可する（CDK の標準的な粒度であり、テーブル単位より細かい
//   IAM 条件は DynamoDB の仕様上できない）。
//
// 環境変数 CHAT_SESSION_TABLE_NAME:
// Lambda ハンドラー側（handler.ts）は Amplify の GraphQL クライアントでは
// なく `@aws-sdk/client-dynamodb`（GetItemCommand）で直接 ChatSession を
// 読むため（Lambda から GraphQL クライアントを使うのは実行時のオーバー
// ヘッド・認証コンテキストの不整合の観点で不適切）、テーブル名を
// 環境変数として渡す必要がある。値は
// `backend.data.resources.tables["ChatSession"].tableName`
// （synth 時に CDK が解決する Token 文字列、CloudFormation デプロイ時に
// 実際のテーブル名に解決される）を使い、`AGENTCORE_RUNTIME_ARN`/
// `AGENTCORE_MEMORY_ID` と同じ「synth 時に一度だけ値を確定し、環境変数と
// IAM ポリシーの対象がずれないようにする」方針に揃える。
const chatSessionTable = backend.data.resources.tables["ChatSession"];

chatSessionTable.grantReadData(backend.copilotkitStreamingRelay.resources.lambda);

// `resources.lambda` は `IFunction`（L2 インターフェース）として型付けられているが、
// `addEnvironment` は具象クラス `lambda.Function`（`resource.ts` の
// `new NodejsFunction(...)` が実際に返しているインスタンス）にのみ存在する
// メソッドであり、`IFunction` インターフェースには含まれない。`resource.ts` の
// `defineFunction((scope) => new NodejsFunction(...))` パターンにより
// 実体は常に `lambda.Function` のサブクラスであることが保証されているため、
// この型アサーションは安全（実行時エラーの可能性なし）。
(backend.copilotkitStreamingRelay.resources.lambda as LambdaFunction).addEnvironment(
  "CHAT_SESSION_TABLE_NAME",
  chatSessionTable.tableName
);

// 高感度（認証経路）: Cognito JWT 署名検証（`relay.ts` の `extractCognitoSub`、
// 脆弱性修正）のための User Pool ID / User Pool Client ID の環境変数配線。
//
// 背景: `extractCognitoSub` は以前、JWT の署名検証を一切行わず base64url
// デコードのみで `sub` クレームを読んでいた。Lambda 関数 URL の認証タイプが
// `NONE`（`resource.ts`）であるため、これは任意の攻撃者が偽造トークンで
// 他ユーザーの `sub` を主張できる脆弱性だった。`aws-jwt-verify` の
// `CognitoJwtVerifier` で実際の署名検証を行うよう修正し、検証対象の
// User Pool を Lambda に伝える必要がある。
//
// `CHAT_SESSION_TABLE_NAME` と同じ理由・同じパターンで backend.ts に置く:
// `backend.auth`（User Pool の L2 リソース）と `backend.copilotkitStreamingRelay`
// （Lambda 実行ロール）の両方が揃うのは `defineBackend({...})` 実行後のみであり、
// `resource.ts` の `defineFunction((scope) => ...)` コールバックは `scope`
// （Stack 相当）しか受け取らず `backend.auth` を参照できないため。
//
// IAM 権限: 追加の IAM グラントは不要（`aws-jwt-verify`/`CognitoJwtVerifier` は
// Cognito の公開 JWKS エンドポイントへの認証不要な HTTPS フェッチで検証鍵を
// 取得・キャッシュする実装であり、AWS SDK の認証情報や IAM ポリシーを一切
// 経由しない。AWS API 呼び出しではないため付与すべき IAM ポリシーが存在しない）。
//
// `userPoolId`/`userPoolClientId` プロパティ名は
// `@aws-amplify/plugin-types` の `AuthResources`（`IUserPool`/
// `IUserPoolClient`、aws-cdk-lib の `aws-cognito` 型定義）で確認済み。
//
// `resources.lambda` は `IFunction`（L2 インターフェース）として型付けられて
// いるが、`addEnvironment` は具象クラス `lambda.Function` にのみ存在する
// メソッドであり `IFunction` インターフェースには含まれない（上の
// `CHAT_SESSION_TABLE_NAME` の配線と同じ型アサーションの理由）。
(backend.copilotkitStreamingRelay.resources.lambda as LambdaFunction).addEnvironment(
  "COGNITO_USER_POOL_ID",
  backend.auth.resources.userPool.userPoolId
);
(backend.copilotkitStreamingRelay.resources.lambda as LambdaFunction).addEnvironment(
  "COGNITO_USER_POOL_CLIENT_ID",
  backend.auth.resources.userPoolClient.userPoolClientId
);

// コスト確認用タグ（CDK の Tags.of によりスタック配下の全リソースに伝播する）
// - Project: プロジェクト識別用。自分のプロジェクトに合わせて値を変更してよい
// - Environment: デプロイ環境識別用。Amplify Hosting のブランチデプロイでは
//   ビルド時に自動設定される AWS_BRANCH 環境変数（例: "main"、"develop"）を
//   そのまま使う。Amplify Hosting は各ブランチのリソースに
//   `amplify:branch-name` タグを自動付与するのと同様の考え方で、ここでも
//   ブランチ名を Environment の値として使う。sandbox 実行時は AWS_BRANCH が
//   存在しないため "sandbox" にフォールバックする。
//   注意: DynamoDB テーブル名末尾の "-NONE" はこの仕組みとは無関係。
//   Amplify Gen 2 は現在の実装では sandbox・ブランチデプロイのいずれでも
//   テーブル名末尾を固定文字列 "NONE" にする（ブランチ名は反映されない）。
//   ブランチの識別は上記の `amplify:branch-name` タグで行う。
const backendTags = Tags.of(backend.stack);
backendTags.add('Project', 'agent-for-aws-mcp-server');
backendTags.add('Environment', process.env.AWS_BRANCH ?? 'sandbox');
