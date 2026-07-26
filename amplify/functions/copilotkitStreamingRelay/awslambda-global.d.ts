import type { Context } from "aws-lambda";

/**
 * AWS Lambda の Node.js マネージドランタイムが実行時にグローバルへ注入する
 * `awslambda.streamifyResponse()` / `awslambda.HttpResponseStream` の
 * 最小限の型定義。
 *
 * このシンボルはランタイム専用のグローバルであり、npm パッケージ
 * （`@types/aws-lambda` を含む、インストール済みバージョン 8.10.145 で確認）
 * からは型定義が提供されていないため、当ファイルで宣言する。
 * 実行時の実体はローカル環境やこのリポジトリのコードでは実装されず、
 * Lambda Node.js 20.x マネージドランタイムが提供する。
 *
 * 参照: https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html
 */
declare global {
  interface AwsLambdaHttpResponseStreamMetadata {
    statusCode?: number;
    headers?: Record<string, string>;
  }

  const awslambda: {
    streamifyResponse<TEvent = unknown>(
      handler: (event: TEvent, responseStream: NodeJS.WritableStream, context: Context) => Promise<void>
    ): (event: TEvent, responseStream: NodeJS.WritableStream, context: Context) => Promise<void>;
    HttpResponseStream: {
      from(
        responseStream: NodeJS.WritableStream,
        metadata: AwsLambdaHttpResponseStreamMetadata
      ): NodeJS.WritableStream;
    };
  };
}

export {};
