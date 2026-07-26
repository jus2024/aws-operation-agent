# Implementation Plan: Amplify Streaming Response

## Overview

本実装計画は、CopilotKit_Runtime の中継処理（認証ゲート・SigV4 署名・セッションヘッダー伝播・AgentCore Runtime への転送）を、Amplify Hosting の SSR_Compute 上で動作する Next.js Route Handler（`src/app/api/copilotkit/route.ts`）から、Amplify Gen 2 のカスタム関数（`defineFunction` の低レベル CDK オーバーライド）として定義する独立した Node.js Lambda（Lambda 関数 URL、`InvokeMode: RESPONSE_STREAM`）に切り出すためのコーディングタスクである。

design.md の Component 1〜3、データフロー、未確定事項を反映している。

進め方: まず未確定事項（`@copilotkit/runtime` の低レベル API）を調査で解消し（他タスクの前提）→ 新しい Lambda 関数の骨格を作成 → `route.ts` からのロジック移植 → `amplify/backend.ts` への配線・IAM 変更 → sandbox での動作確認 → フロントエンドの向け先変更 → 旧 `route.ts` の削除 → README 更新 → 本番デプロイ、の順に進める。各タスク完了後は最も狭い範囲の検証（lint/型チェック/スモークテスト）を実施する（`testing` 方針）。フロントエンド変更は lint と型チェックを優先し、Amplify 変更はデプロイと設定への影響を必ず記載する。

### 高感度タスク（PR レビュー必須・`security` / `repo-workflow` ルール）

- **2.1** 新しい Lambda 実行ロールの IAM 権限付与（`bedrock-agentcore:InvokeAgentRuntime`）。認証・SigV4 署名を担う新規リソースへの最小権限設計
- **3.1** `route.ts` の認証ゲート・SigV4 署名・セッションヘッダー伝播ロジックの移植。認証経路の変更そのもの
- **5.1** `AmplifySSRComputeRole` からの `InvokeAgentRuntime` 権限の撤去、新しい Lambda 実行ロールへの権限移動
- **7.1** 旧 `src/app/api/copilotkit/route.ts` の削除。本番の唯一の中継経路をこのタイミングで完全に切り替える破壊的変更

---

## Tasks

- [x] 1. 調査: `@copilotkit/runtime` の低レベル呼び出し方法を確定する
  - [x] 1.1 `node_modules/@copilotkit/runtime`（または該当パッケージ）のエクスポートを直接確認する
    - `copilotRuntimeNextJSAppRouterEndpoint` の実装を読み、内部で呼ばれている Fetch API 準拠のハンドラー本体（`Request` を受け取り `Response` を返す関数）の名前・シグネチャを特定する
    - Next.js 専用アダプターに依存せず、Lambda ハンドラーから直接呼び出せる形（例: 汎用のハンドラーファクトリ、または `copilotRuntimeNodeHttpEndpoint` 等の Node.js 向けアダプター）が存在するか確認する
    - 存在しない場合は、`copilotRuntimeNextJSAppRouterEndpoint` が内部で構築している `Request`/`Response` の変換ロジックを Lambda ハンドラー側で自前実装する方針に切り替え、その方針を design.md の「未確定事項」セクションに確定内容として反映する
    - _Requirements: 3.3, 3.4_
    - 検証: 調査結果を design.md に反映し、後続タスクが参照できる状態にする（コード変更なし）

- [x] 2. Amplify カスタム関数: `copilotkitStreamingRelay` の骨格を作成する（高感度: IAM）
  - [x] 2.1 `amplify/functions/copilotkitStreamingRelay/resource.ts` を新規作成する
    - `defineFunction((scope) => new lambda.Function(...))` の低レベル CDK オーバーライドパターンで実装する（design.md Component 1 のコード例に従う）
    - `runtime: lambda.Runtime.NODEJS_20_X`（または対象 Node.js バージョン）、`handler.ts` を指すハンドラー、タイムアウト・メモリサイズを設定する（実測値が判明するまでは暫定値とし、タスク 6 で調整する）
    - `fn.addToRolePolicy` で `bedrock-agentcore:InvokeAgentRuntime` を許可するインラインポリシーを付与する。`Resource` は当面 `*` とし、Runtime ARN を環境変数から動的に絞り込む方式は未確定事項（タスク 8）で対応する
    - `fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE, invokeMode: lambda.InvokeMode.RESPONSE_STREAM })` で関数 URL を作成する
    - _Requirements: 2.5, 3.1_
    - **高感度（IAM）**: 新規作成する実行ロールの権限は `bedrock-agentcore:InvokeAgentRuntime` のみに限定し、他の AWS サービスへの権限を含めないことを PR で確認する
    - 検証: `npx tsc --noEmit`（Amplify バックエンドの型チェック）

  - [x] 2.2 `amplify/functions/copilotkitStreamingRelay/handler.ts` の骨格を作成する
    - `awslambda.streamifyResponse()` でラップしたハンドラー関数の骨格を作成する（design.md Component 1 のコード例に従う）。この時点では Lambda 関数 URL イベントの受信と `responseStream` への最小限の書き込み（プレースホルダーレスポンス）のみを実装し、実際の中継ロジックはタスク 3 で実装する
    - _Requirements: 1.1, 1.2_
    - 検証: 型チェック。ローカルで最小限のテストイベントを使った単体呼び出しができることを確認する（Amplify sandbox デプロイ前の疎通確認）

- [x] 3. `route.ts` の中継ロジックを新しい Lambda ハンドラーに移植する（高感度: 認証経路）
  - [x] 3.1 `amplify/functions/copilotkitStreamingRelay/handler.ts` にロジックを移植する
    - `route.ts` の `extractBearerToken` / `extractCognitoSub` / `sigv4Fetch` / セッションヘッダー構築ロジック（`X-Role-Names` / `X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId`）を、ロジックを変更せずそのまま移植する
    - Lambda 関数 URL イベント（`LambdaFunctionURLEvent`）を Fetch API の `Request` オブジェクトに変換する処理を実装する（Authorization ヘッダー、リクエストボディ、メソッドを保持する）
    - 認証ゲート（Bearer トークンなし/無効）は、CopilotKit_Runtime に処理を委譲する前に判定し、401 を `responseStream` に直接書き込んで終了する
    - タスク 1 で確定した方法で CopilotKit_Runtime（`CopilotRuntime` + `ExperimentalEmptyAdapter` + `HttpAgent`）を呼び出し、返された `Response` の本文（`ReadableStream`）を `responseStream` に逐次書き込む（pipe）処理を実装する
    - AgentCore Runtime の Runtime ARN は環境変数（`AGENTCORE_RUNTIME_ARN`、名称は実装時に確定）から読む
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4_
    - **高感度（認証経路）**: 認証ゲート・SigV4 署名・ヘッダー伝播の移植で、ロジックの意図的変更がないことを PR で `route.ts` との diff ベースで確認する
    - 検証: 型チェック。Amplify sandbox 環境にデプロイし、関数 URL への直接リクエスト（`curl` 等）で認証ゲート（トークンなしで 401、正しいトークンで疎通）を確認する

  - [ ]* 3.2 移植した純粋関数のユニットテストを作成する
    - `extractBearerToken` / `extractCognitoSub` / セッションヘッダー構築ロジックについて、既存の `route.ts` 用テスト（存在する場合）と同等のテストケースを、移植後のモジュールに対して実行する
    - _Requirements: 2.1, 2.3_

- [x] 4. `amplify/backend.ts` に新しい関数を配線する
  - [x] 4.1 `amplify/backend.ts` を更新する
    - `defineBackend({ auth, data, copilotkitStreamingRelay })` に新しい関数を追加する
    - 関数 URL のエンドポイントを、フロントエンドが参照できる形で Amplify の出力（`amplify_outputs.json` へのカスタム出力、または他の確立された方式）として公開する方法を実装する
    - _Requirements: 3.1_
    - 検証: 型チェック。`npx ampx sandbox` でのデプロイが成功し、関数 URL が作成されることを確認する

- [x] 5. IAM 権限の移動（高感度）
  - [x] 5.1 `AmplifySSRComputeRole` から `InvokeAgentRuntime` 権限（`InvokeAgentCoreRuntime` インラインポリシー）を削除する
    - Route Handler（`/api/copilotkit`）が撤去されるため、`AmplifySSRComputeRole` に付与していた `bedrock-agentcore:InvokeAgentRuntime` 権限は不要になる
    - `RoleConfigScanAccess`（`dynamodb:Scan`、`/api/roles` 用）は変更しない
    - _Requirements: 2.5_
    - **高感度（IAM）**: 権限削除がタスク 7（`route.ts` 削除）より前に行われないよう、実行順序を PR で確認する（削除の順序を誤ると本番の既存中継経路が壊れる）
    - 検証: 本番 Amplify Hosting の IAM ロールに対する変更のため、AWS コンソールまたは CLI での確認結果を PR に記載する

- [x] 6. sandbox 環境でのストリーミング動作確認
  - [x] 6.1 sandbox 環境で新しい Lambda 関数 URL への直接リクエストによる動作確認を行う
    - `npx ampx sandbox` でデプロイした関数 URL に対し、AgentCore Runtime（開発用、`AWS_MCP_Agent`）への実際のチャットリクエストを送信し、レスポンスがチャンク単位で逐次到着することを確認する（`curl --no-buffer` 等でチャンクの到着タイミングを目視確認する）
    - Lambda のタイムアウト・メモリサイズを実測に基づいて調整する（design.md の未確定事項を確定する）
    - _Requirements: 1.1, 1.2, 4.1_
    - 検証: 実機確認結果（レスポンスの分割到着ログ、TTFB の実測値）を記録する

- [x] 7. フロントエンドの向け先変更と旧 Route Handler の削除（高感度: 破壊的切り替え）
  - [x] 7.1 `src/lib/agent/CopilotProvider.tsx` の `runtimeUrl` を新しい関数 URL に変更する
    - `runtimeUrl="/api/copilotkit"` を、タスク 4 で公開した関数 URL を参照する値（`NEXT_PUBLIC_` プレフィックス付き環境変数、または Amplify の出力から取得する値）に変更する（design.md Component 2 の方針に従う）
    - _Requirements: 1.1, 3.3_
    - 検証: 型チェック。sandbox 環境（フロントエンド + 新しい関数 URL）でブラウザから実際にチャットし、ストリーミング表示を目視確認する

  - [x] 7.2 `src/app/api/copilotkit/route.ts` を削除する
    - ファイル自体を削除する。この Route Handler を import している他のモジュールがないことを確認する
    - _Requirements: 3.3_
    - **高感度（破壊的切り替え）**: 本番の唯一の中継経路をこのコミットで完全に切り替える。タスク 7.1（フロントエンドの向け先変更）と同一 PR・同一デプロイタイミングで行い、両者が食い違う期間を作らないこと
    - 検証: 型チェック・lint。削除後にビルド（`npm run build`）が成功することを確認する

- [x] 8. Runtime ARN を絞った IAM 権限への変更（残タスク）
  - [x] 8.1 タスク 2.1 で `Resource: '*'` としていた IAM ポリシーを、実際の AgentCore Runtime ARN に絞る
    - 開発用（sandbox、`AWS_MCP_Agent`）と本番用（Amplify Hosting `main`、`AWS_MCP_Agent_Prod`）で異なる Runtime ARN を参照する必要があるため、Amplify のブランチ環境（`AWS_BRANCH` 等）に応じて適切な ARN を選択する方式を実装する（design.md の未確定事項を確定する）
    - _Requirements: 2.5_
    - **高感度（IAM）**: 最小権限への絞り込みが正しく機能し、誤って権限を失う（本番で AgentCore Runtime を呼べなくなる）リスクがないことを sandbox での事前確認で PR に記載する

- [x]* 9. README・ドキュメント更新
  - [x] 9.1 README に新しい Lambda 関数・関数 URL・デプロイフローへの影響を追記する
    - `copilotkitStreamingRelay` の目的、Amplify Hosting の既存デプロイフロー（Git push）にどう統合されるか、新規に必要な環境変数・IAM 権限を記載する
    - `src/app/api/copilotkit/route.ts` が削除されたことと、その理由（Amplify Hosting の SSR_Compute のストリーミング制約）を記載する
    - _Requirements: 3.1, 3.2_

## 運用者タスク（Kiro からは実行不可、手動対応が必要）

- **O1**: `agentcore deploy` は不要（本仕様は AgentCore Runtime 側を変更しないため）。Amplify Hosting へのデプロイは通常の Git push で自動的に行われる
- **O2**: 本番 Amplify Hosting（`main` ブランチ）へのデプロイ前に、タスク 6 の sandbox 確認結果と、タスク 7 のフロントエンド向け先変更・旧 Route Handler 削除が同一コミットに含まれていることを確認し、本番デプロイを承認する
- **O3**: 本番デプロイ後、実際のブラウザ操作でストリーミング表示（トークン単位の逐次表示）を目視確認する
