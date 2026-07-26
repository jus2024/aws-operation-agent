import { defineFunction } from "@aws-amplify/backend";
import { Duration, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { fileURLToPath } from "node:url";

/**
 * copilotkitStreamingRelay Lambda 関数の定義
 *
 * design.md Component 1 の低レベル CDK オーバーライドパターン
 * （`defineFunction((scope) => new lambda.Function(...))`）に従う。
 * ここでは `lambda.Function` のサブクラスである `NodejsFunction` を使うことで、
 * TypeScript ハンドラー（`handler.ts`、タスク 2.2 で作成）を esbuild で自動
 * バンドルし、事前ビルド済み JS ファイルの配置を不要にする（design.md の
 * 未確定事項「Lambda 関数のコードバンドル方式」を、Amplify Gen 2 標準の
 * `defineFunction` と同様の自動バンドル方式で解決する）。
 *
 * Requirements: 2.5, 3.1
 */
export const copilotkitStreamingRelay = defineFunction((scope) => {
  // AgentCore Runtime ARN は synth 時に一度だけ process.env から読み、Lambda の
  // 環境変数と IAM ポリシーの Resource の両方に同じ値を使う（読み取りを1箇所に
  // 集約し、環境変数とポリシーの ARN が食い違う事態を避ける。タスク 8.1 で
  // design.md の未確定事項「ブランチ環境ごとの Runtime ARN 切り替え」を確定）。
  const agentCoreRuntimeArn = process.env.AGENTCORE_RUNTIME_ARN ?? "";

  // AgentCore Memory の ID も、AGENTCORE_RUNTIME_ARN と同様に synth 時に一度だけ
  // process.env から読む（memory-based-chat-history タスク 1.1）。Runtime ARN とは
  // 別の環境変数として管理する（Memory は Runtime とは別の AgentCore リソースであり、
  // 将来的に片方だけを切り替える場合に環境変数を分離しておく必要があるため）。
  //
  // Runtime ARN とは異なり、こちらは ARN 全体ではなく Memory ID（例:
  // `agents_AWS_MCP_AgentMemory-XXXXXXXXXX`、`agents/agentcore/.cli/deployed-state.json`
  // の `memories.*.memoryId` と同じ形式）を保持する。理由は、Memory 読み取り系の API
  // （`ListEvents` 等）が Resource の指定にリクエストパラメーターとして
  // `memoryId` を要求するため（IAM ポリシーの Resource には後述の通り ARN 形式が
  // 必要だが、Lambda ハンドラー側から SDK を呼ぶ際は memoryId のみで済む）。
  // Lambda の環境変数には ID のまま渡し、IAM ポリシーの Resource は下記で
  // `Stack.of(scope).formatArn()` を使って ID から ARN を組み立てる（synth 時の
  // 読み取りをこの1箇所に集約し、環境変数とポリシーの Memory 識別子が
  // 食い違う事態を避ける）。
  const agentCoreMemoryId = process.env.AGENTCORE_MEMORY_ID ?? "";

  const fn = new NodejsFunction(scope, "copilotkit-streaming-relay", {
    // handler.ts はタスク 2.2 で作成する
    entry: fileURLToPath(new URL("./handler.ts", import.meta.url)),
    handler: "handler",
    // レスポンスストリーミング（awslambda.streamifyResponse()）対応の
    // Node.js マネージドランタイム
    runtime: lambda.Runtime.NODEJS_20_X,
    // タスク 6.1 で sandbox 環境の実機確認により実測した値に基づく（design.md の
    // 未確定事項「Lambda の適切なタイムアウト値・メモリサイズ」を確定）。
    // 実測データ: Cognito 認証済みの実際のチャットリクエスト（AgentCore Runtime
    // `AWS_MCP_Agent`、ツール呼び出しなしの単純な応答）で、TTFB（RUN_STARTED
    // イベント到着まで）約 2.6 秒、応答完了までの合計処理時間 約 4.4 秒
    // （Lambda 実行時間として計測: 3982ms、コールドスタート時の INIT は
    // 494〜1280ms で別計上）。メモリ使用量は最大 211MB（512MB 中）で、
    // 余裕を持った範囲に収まっている。
    // タイムアウトは 900秒（Lambda / Function URL RESPONSE_STREAM の上限=15分）を
    // 採用する。当初は単純な応答の実測（4.4秒）に対する暫定バッファとして 60秒に
    // していたが、AWS MCP Server 経由で複数回のツール往復（round-trip）を伴う
    // ツール多用の長い応答では、エージェントのターンが 60秒を超えてストリーミングが
    // 途中で切断される事例が起こり得る。900秒は Lambda と Function URL
    // （RESPONSE_STREAM）が許容する最大値であり、これに引き上げることでストリーム
    // 途中の早期終了を防ぐ（実測は単純応答のみで、ツール多用シナリオの上限は
    // 未計測のため、上限まで引き上げて安全側に倒す）。
    // メモリサイズ 512MB は、実測の最大使用量（211MB）に対して約2.4倍の余裕が
    // あるため、暫定値のまま確定値として採用する。
    timeout: Duration.seconds(900),
    memorySize: 512,
    // esbuild の出力フォーマットを ESM に固定する（タスク 6.1 で判明した不具合の
    // 修正）。デフォルトの CJS 出力では、`@copilotkit/runtime` がバンドルしている
    // `@oxc-project/runtime` 系の内部モジュールが `createRequire(import.meta.url)`
    // を呼んでいるが、CJS ビルドでは `import.meta` が存在せず `import.meta.url` が
    // `undefined` になり、Lambda の初回 INIT で
    // `TypeError [ERR_INVALID_ARG_VALUE]: The argument 'filename' must be a file
    // URL object...` という初期化エラーで即時失敗する（全リクエストが失敗する
    // 致命的なバグだった）。ESM 出力（`--format=esm`）にすると `import.meta.url`
    // が実際のモジュール URL に解決されるため、この経路のコードは元々 ESM 実行を
    // 前提に書かれていたことがわかる。Node.js 20.x マネージドランタイムは ESM
    // ハンドラー（`index.mjs`）をネイティブサポートしており、
    // `awslambda.streamifyResponse()` もランタイム側のグローバルなので
    // ESM/CJS のどちらでも利用できる。
    bundling: {
      format: OutputFormat.ESM,
      target: "node20",
      // ESM 出力には CJS の `require` がネイティブに存在しない。バンドル対象の
      // 依存関係（`@copilotkit/shared` が使う `chalk`/`supports-color` 等）は
      // 内部で Node.js の組み込みモジュール（`os` 等）を `require("os")` の形で
      // 呼んでおり、esbuild は ESM 出力時にこれらの external 扱いの
      // `require` 呼び出しをランタイムエラー（"Dynamic require of ... is not
      // supported"）を投げるスタブに置き換える。`createRequire(import.meta.url)`
      // で `require` を明示的に定義するのが esbuild ESM 出力の標準的な回避策
      // （esbuild/CDK NodejsFunction の既知の制約）。
      banner: "import { createRequire as topLevelCreateRequire } from 'module';const require = topLevelCreateRequire(import.meta.url);",
    },
    environment: {
      // AgentCore Runtime ARN は CDK synth 時（`npx ampx sandbox` / `npx ampx
      // pipeline-deploy` 実行時）のシェル環境変数 `AGENTCORE_RUNTIME_ARN` から読む
      // （タスク 6.1 で確定）。空文字列のハードコードではなく `process.env` 経由に
      // したのは、既存の `NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN`（route.ts、.env.local）
      // と同じ「開発者のローカル .env.local / Amplify コンソールの環境変数から
      // 値を渡す」パターンに揃えるため。ローカル sandbox 実行時は
      // `.env.local` に `AGENTCORE_RUNTIME_ARN=<Runtime ARN>` を追加し、
      // `npx dotenvx run --env-file=.env.local -- ampx sandbox` のように読み込ませる
      // 必要がある（Amplify Gen 2 公式ドキュメント推奨パターン。素の
      // `npx ampx sandbox` はシェルの環境変数のみを見るため、通常のシェルの
      // `export` でも代用可）。本番 Amplify Hosting（`main` ブランチ）では、
      // Amplify コンソールの環境変数として `AGENTCORE_RUNTIME_ARN` を設定する
      // （ビルド時に `pipeline-deploy` の実行プロセスに渡る）。
      AGENTCORE_RUNTIME_ARN: agentCoreRuntimeArn,

      // AgentCore Memory ID も同様に、CDK synth 時のシェル環境変数
      // `AGENTCORE_MEMORY_ID` から読む（memory-based-chat-history タスク 1.1）。
      // ローカル sandbox 実行時は `.env.local` に
      // `AGENTCORE_MEMORY_ID=<Memory ID>` を追加し、本番 Amplify Hosting では
      // Amplify コンソールの環境変数として設定する（AGENTCORE_RUNTIME_ARN と
      // 同じ運用パターン）。
      AGENTCORE_MEMORY_ID: agentCoreMemoryId,

    },
  });

  // 高感度（IAM）: bedrock-agentcore:InvokeAgentRuntime のみを許可する
  // インラインポリシー。タスク 8.1 で Resource を実際の Runtime ARN に絞った
  // （design.md の未確定事項を確定）。
  //
  // Resource は上で環境変数にも使った同じ agentCoreRuntimeArn から導出する
  // （環境変数の値と IAM ポリシーの Resource がずれることを避けるため、
  // process.env を2箇所で別々に読まない）。ARN 本体に加え `${arn}/*` も
  // 許可するのは、本番 AmplifySSRComputeRole に付与されていた
  // `InvokeAgentCoreRuntime` インラインポリシー（タスク 5.1 で削除済み、
  // 削除前に `aws iam get-role-policy` で確認済み）が同じ
  // `[arn, `${arn}/*`]` の2エントリー構成だったことに合わせている。
  //
  // AGENTCORE_RUNTIME_ARN が空の場合（ARN 未設定）は、'*' へのフォール
  // バックはせず、ポリシー自体を付与しない（bedrock-agentcore への権限を
  // 一切与えない = フェイルセーフ）。理由:
  // - このリポジトリはエージェント機能をオプション拡張として扱う方針
  //   （product ルール、docs/setup.md 記載）であり、AgentCore Runtime を
  //   まだデプロイしていない新規クローン直後の `npx ampx sandbox` でも
  //   Amplify バックエンド全体（auth・data・Todo アプリ）が synth/deploy
  //   できる必要がある。ARN 未設定を CDK synth のエラーにすると、
  //   エージェント機能を使わない利用者の初回セットアップまで壊してしまい、
  //   「Web アプリ本体とオプションのエージェント機能の明確な分離」という
  //   方針に反する。
  // - handler.ts はすでに `AGENTCORE_RUNTIME_ARN` 未設定を実行時に検知して
  //   500 を返す設計（runtime インスタンス自体を作らない）になっており、
  //   ポリシーを付与しなければ、たとえ実行時のガードをすり抜けても
  //   AgentCore への呼び出しは IAM レベルで AccessDenied になる
  //   （'*' へのフォールバックによる過剰権限より安全な失敗モード）。
  if (agentCoreRuntimeArn) {
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [agentCoreRuntimeArn, `${agentCoreRuntimeArn}/*`],
      })
    );
  }

  // 高感度（IAM）: bedrock-agentcore:ListEvents のみを許可するインラインポリシー
  // （memory-based-chat-history タスク 1.1）。
  //
  // 上の InvokeAgentRuntime と同じ絞り込みパターン（synth 時に一度だけ環境変数を
  // 読み、その値から導出した ARN を Resource に指定）を踏襲する。ここで許可する
  // アクションは読み取り専用の `ListEvents` のみに限定し、書き込み系アクション
  // （`CreateEvent`・`DeleteEvent`・`GetEvent` 等）は一切含めない。会話の記録
  // （書き込み）は AgentCore Runtime 側が実行時に自動で行う既存の仕組みに委ね、
  // この Lambda は Memory の内容を読み出す（Session_Restore）用途のみで
  // Memory にアクセスするため（design.md Component 1）。
  //
  // Resource は `agentCoreMemoryId`（Memory ID のみ）から、
  // `Stack.of(scope).formatArn()` で Memory の完全な ARN
  // （`arn:<partition>:bedrock-agentcore:<region>:<account>:memory/<memoryId>`）
  // を組み立てる。IAM ポリシーの Resource には ARN 形式が
  // 必要なため（AWS の service-authorization リファレンスで `memory` リソースタイプの
  // ARN 形式が `arn:${Partition}:bedrock-agentcore:${Region}:${Account}:
  // memory/${MemoryId}` と定義されている）、環境変数には ID のみを保持しつつ、
  // ARN への変換はこの1箇所に集約する。InvokeAgentRuntime と同様に `${arn}/*` も
  // 許可し、Memory 配下のサブリソース（セッション単位のイベント等）への
  // アクセスも対象にする。
  //
  // AGENTCORE_MEMORY_ID が空の場合（環境変数未設定）は、AGENTCORE_RUNTIME_ARN と
  // 同じフェイルセーフ方針に従い、'*' へのフォールバックはせずポリシー自体を
  // 付与しない。理由も同様: Memory 機能を使わない/まだ Memory ID を把握していない
  // 環境（新規クローン直後の sandbox 等）でも Amplify バックエンド全体の
  // synth/deploy を壊さないため。
  if (agentCoreMemoryId) {
    const agentCoreMemoryArn = Stack.of(scope).formatArn({
      service: "bedrock-agentcore",
      resource: "memory",
      resourceName: agentCoreMemoryId,
    });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:ListEvents"],
        resources: [agentCoreMemoryArn, `${agentCoreMemoryArn}/*`],
      })
    );
  }

  // CORS 設定（バグ修正 その3: 最終修正）
  //
  // 問題の経緯:
  // - その1: 関数 URL レベルの cors を設定 → CopilotKit_Runtime が cors 未指定で
  //   `Access-Control-Allow-Origin: *` をフォールバック付与 → 二重ヘッダーで
  //   ブラウザが CORS エラー
  // - その2: 関数 URL から cors を外し、CopilotKit_Runtime 側に一元化 →
  //   関数 URL の cors 未設定時は OPTIONS プリフライトも Lambda に届くため
  //   handler.ts で OPTIONS 分岐が必要になり複雑化。また Lambda 自身が返す
  //   CORS ヘッダーの管理が handler.ts のロジックに依存する
  //
  // 最終修正方針:
  // - 関数 URL レベルの cors を設定する（AWS が OPTIONS プリフライトを自動応答し、
  //   全ての実レスポンスにも自動で CORS ヘッダーを付与する）
  // - CopilotKit_Runtime 側の CORS ヘッダー付与を完全に無効化する
  //   （`cors: { origin: [] }` で空配列を渡すと、@copilotkit/runtime 内部の
  //   `resolveOrigin` が null を返し、`setCorsHeaders` が何もセットしない）
  // - これにより CORS ヘッダーの源泉が関数 URL の1箇所のみとなり、重複なし
  //
  // `allowedOrigins: ["*"]` にする理由:
  // - 認証は Bearer トークン（Cognito JWT）で行っており、CORS のオリジン制限に
  //   依存した認可設計ではない
  // - `*` にすることで、ローカル開発（localhost:3000）・本番 Amplify Hosting・
  //   preview 環境など全てのオリジンが単一の設定で動作する
  // - `COPILOTKIT_RELAY_ALLOWED_ORIGINS` 環境変数による追加オリジン管理が不要になり、
  //   設定の複雑さが大幅に減る
  fn.addFunctionUrl({
    authType: lambda.FunctionUrlAuthType.NONE,
    invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    cors: {
      allowedOrigins: ["*"],
      allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
      allowedHeaders: ["authorization", "content-type"],
    },
  });

  return fn;
});
