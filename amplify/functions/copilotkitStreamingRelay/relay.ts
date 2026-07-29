import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { AsyncLocalStorage } from "node:async_hooks";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { LambdaFunctionURLEvent } from "aws-lambda";

/**
 * copilotkitStreamingRelay の純粋関数・ヘルパー群。
 *
 * `src/app/api/copilotkit/route.ts` から移植した認証ゲート・SigV4 署名・
 * セッションヘッダー構築ロジック（ロジック自体は変更しない）と、
 * Lambda 関数 URL イベント ⇔ Fetch API の変換・レスポンスの pipe を行う
 * ヘルパーをまとめたモジュール。`handler.ts`（Lambda エントリーポイント）から
 * import して使う。ユニットテスト（タスク 3.2）はこのモジュールに対して行う。
 *
 * 高感度（認証経路）: `extractBearerToken` / `sigv4Fetch` /
 * `buildSessionHeaders` は route.ts の対応する関数と意図的な差分がないこと
 * （署名確認・ヘッダー伝播ロジックが同一であること）を前提にしている。
 * 変更する場合は route.ts との diff ベースで確認すること。
 *
 * `extractCognitoSub` は例外: route.ts はもともと JWT の署名検証を行わず
 * base64url デコードのみで `sub` クレームを読んでいたが、これは Lambda 関数
 * URL の認証タイプが `NONE`（`resource.ts` の `fn.addFunctionUrl(...)`）である
 * ため、署名検証なしでは任意の攻撃者が `sub` を偽装できる脆弱性だった
 * （高感度セキュリティ修正で発見・修正）。現在は `aws-jwt-verify` の
 * `CognitoJwtVerifier` で Cognito User Pool の JWKS に対する実際の署名検証を
 * 行っており、route.ts の旧ロジックとは意図的に差分がある。
 *
 * Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4
 */

/**
 * この Lambda が動いているリージョン。Lambda 実行環境が必ず設定する
 * `AWS_REGION` から読む（Amplify Hosting のデプロイ先リージョンと一致する）。
 *
 * 以前は `"us-west-2"` をハードコードしていたため、他のリージョンに
 * デプロイすると次の2つが壊れた。
 * - AgentCore への SigV4 署名リージョンが呼び出し先ホストと食い違う
 * - DynamoDB / AgentCore Memory の SDK クライアントが存在しない
 *   リージョンを向く
 *
 * `undefined` になり得る（ローカルのユニットテスト等、Lambda 外での読み込み）。
 * SDK クライアントに `region: undefined` を渡した場合は SDK 既定の
 * リージョン解決チェーンにフォールバックするため、`src/app/api/roles/route.ts`
 * の `new DynamoDBClient({})` と同じ挙動になる。
 */
export const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

/**
 * セッションコンテキストヘッダー（X-Role-Names /
 * X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId）をリクエストごとの
 * 非同期コンテキストに保持する。
 *
 * route.ts と同じ理由（モジュールスコープの可変変数だと並行リクエスト間で
 * ヘッダーが混ざるバグを防ぐ）で AsyncLocalStorage を使う。Lambda も
 * プロビジョニングされた同時実行やコンテナ再利用によりモジュールスコープを
 * 複数リクエストで共有し得るため、この対策は Lambda でも引き続き有効。
 */
export const sessionHeadersStorage = new AsyncLocalStorage<Record<string, string>>();

/**
 * AgentCore Runtime の Invocation URL を Runtime ARN から組み立てる。
 *
 * リージョンは ARN の 4 番目のフィールドから取る。ARN にリージョンが
 * 含まれない場合は、この Lambda 自身のリージョンにフォールバックする
 * （Runtime は同一スタックに作られるため通常は一致する）。どちらも
 * 解決できない場合は、`bedrock-agentcore.undefined.amazonaws.com` という
 * 不正なホストで署名・送信して分かりにくい失敗になるのを避けるため、
 * その場で例外を投げる。
 */
export function buildInvocationUrl(runtimeArn: string): string {
  const parts = runtimeArn.split(":");
  const region = parts[3] || REGION;
  if (!region) {
    throw new Error(
      `Cannot resolve region for AgentCore Runtime ARN: ${runtimeArn} (AWS_REGION is also unset)`
    );
  }
  const encodedArn = encodeURIComponent(runtimeArn);
  return `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodedArn}/invocations?qualifier=DEFAULT`;
}

/**
 * AgentCore のエンドポイントホスト名から SigV4 の署名リージョンを取り出す。
 *
 * 署名リージョンは、実際に送信するホスト
 * （`bedrock-agentcore.<region>.amazonaws.com`）と一致していなければ
 * `SignatureDoesNotMatch` になる。URL は `buildInvocationUrl` が Runtime ARN
 * から組み立てるため、ホスト名から取り出すのが最も確実に一致する。
 *
 * 想定外のホスト形式だった場合は、この Lambda 自身のリージョンを返す。
 */
export function resolveSigningRegion(hostname: string): string | undefined {
  const match = /^bedrock-agentcore\.([a-z0-9-]+)\.amazonaws\.com$/.exec(hostname);
  return match?.[1] ?? REGION;
}

/**
 * AgentCore Runtime への SigV4 署名付き fetch。route.ts の sigv4Fetch と
 * ロジック変更なし（`sessionHeadersStorage` からセッションヘッダーを読み取り、
 * リクエストに付与してから署名する）。
 */
export async function sigv4Fetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const targetUrl = new URL(typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url);
  const body = init?.body ? String(init.body) : "";

  const httpRequest = new HttpRequest({
    method: "POST",
    protocol: targetUrl.protocol.replace(":", ""),
    hostname: targetUrl.hostname,
    path: targetUrl.pathname,
    query: Object.fromEntries(targetUrl.searchParams),
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      host: targetUrl.hostname,
      ...(sessionHeadersStorage.getStore() ?? {}),
    },
    body,
  });

  // 署名リージョンは送信先ホストから導出する（ハードコードしない）。
  // ホストは buildInvocationUrl が Runtime ARN から作るため、ARN のリージョンと
  // 署名リージョンが常に一致する。
  const signingRegion = resolveSigningRegion(targetUrl.hostname);
  if (!signingRegion) {
    throw new Error(
      `Cannot resolve SigV4 signing region for host: ${targetUrl.hostname} (AWS_REGION is also unset)`
    );
  }

  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    region: signingRegion,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  const signed = await signer.sign(httpRequest);

  return fetch(targetUrl.toString(), {
    method: "POST",
    headers: signed.headers as Record<string, string>,
    body,
    signal: init?.signal,
  });
}

/**
 * Authorization ヘッダーから Bearer トークンを抽出する。
 *
 * route.ts の extractBearerToken とロジック変更なし。シグネチャのみ
 * `NextRequest` から Fetch API の `Headers` に変更した（`Headers.get()` は
 * 仕様上大文字小文字を区別しないため、追加のケース処理は不要）。
 */
export function extractBearerToken(headers: Headers): string | null {
  const authHeader = headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

// Cognito Access トークンの署名検証用verifier（モジュールスコープのシングルトン、
// `sigv4Fetch` の SignatureV4 クライアントと同じパターン）。
//
// `COGNITO_USER_POOL_ID` が未設定の場合は verifier を作らない（`null`）。
// `extractCognitoSub` はこの場合すべてのトークンを無効として扱う（フェイル
// クローズ、下記参照）。
//
// tokenUse: "access" — フロントエンド（`CopilotProvider.tsx`）は
// `session.tokens?.accessToken?.toString()`（ID トークンではなく Access
// トークン）を Bearer ヘッダーとして送信するため、Access トークン
// （`token_use: "access"` クレーム）として検証する。ID トークンが誤って
// 送られてきた場合は `token_use` 不一致で検証エラーになり `null` を返す
// （fail-closed）。
//
// clientId: 未設定の場合は `null` を渡し、audience/client_id の検証を
// スキップする（`COGNITO_USER_POOL_CLIENT_ID` が未設定でも、User Pool ID が
// 設定されていれば署名検証自体は行う。ただし本番運用では両方を設定する
// 想定 — `backend.ts` で同時に配線する）。
const cognitoUserPoolId = process.env.COGNITO_USER_POOL_ID;
const cognitoUserPoolClientId = process.env.COGNITO_USER_POOL_CLIENT_ID;

const cognitoJwtVerifier = cognitoUserPoolId
  ? CognitoJwtVerifier.create({
      userPoolId: cognitoUserPoolId,
      tokenUse: "access",
      clientId: cognitoUserPoolClientId ?? null,
    })
  : null;

/**
 * Cognito Access トークン（JWT）の署名を検証し、payload の sub クレームを
 * 取り出す。
 *
 * 高感度セキュリティ修正: 以前は JWT の署名検証を一切行わず、base64url
 * デコードのみで `sub` クレームを読んでいた。Lambda 関数 URL の認証タイプが
 * `NONE`（`resource.ts`）であるため、署名検証なしでは3セグメントの
 * 任意の文字列（有効な署名を持たない偽造トークン）を送るだけで任意の
 * `sub` を主張でき、他ユーザーの ChatSession/AgentCore Memory への
 * なりすましアクセスが可能だった。
 *
 * `aws-jwt-verify` の `CognitoJwtVerifier.verify()` は Cognito User Pool の
 * JWKS（公開鍵）に対して実際の署名検証・`exp`（期限切れ）・`token_use`・
 * `client_id`（audience）の検証を行う。JWKS は初回のみ HTTPS で取得し、
 * それ以降はライブラリ内部でキャッシュされる（AWS の認証情報・IAM 権限は
 * 不要 — 公開鍵の取得は認証不要な HTTPS GET リクエストのため）。
 *
 * 契約は変更前と同一に保つ: 常に `null` を返すか（無効・検証不可・期限切れ・
 * audience/token_use 不一致のいずれか）、検証済みの `sub` クレーム文字列を
 * 返す。例外は投げない（既存の呼び出し元 — `handleMemoryRestoreRequest` の
 * 401 判定、POST ハンドラーの `buildSessionHeaders` 呼び出し — の try/catch
 * なしの呼び出しパターンを壊さないため、他のこのファイル内の関数と同じ
 * try/catch-return-null スタイルを踏襲する）。
 *
 * フェイルクローズ: `COGNITO_USER_POOL_ID`（または `cognitoJwtVerifier` が
 * 生成できない状態）の場合、いかなるトークンも無効として扱い `null` を返す
 * （検証をスキップして通す・生の `sub` にフォールバックする、のどちらも
 * 行わない）。これは `resource.ts` の IAM ポリシーが「環境変数未設定 ⇒
 * ポリシーを付与しない」というフェイルセーフ方針を採るのと同じ考え方を、
 * 認可グラント側ではなく認証ゲート側に適用したものである
 * （環境変数未設定 ⇒ 未認証として扱う）。
 */
export async function extractCognitoSub(bearerToken: string): Promise<string | null> {
  const parts = bearerToken.split(".");
  if (parts.length !== 3) return null;

  if (!cognitoJwtVerifier) return null;

  try {
    const payload = await cognitoJwtVerifier.verify(bearerToken);
    return typeof payload?.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * リクエストボディ（JSON パース済み）から Role_Set（roleNames）を抽出する。
 * route.ts の POST ハンドラー内のロジック（
 * `body?.body?.forwardedProps ?? body?.properties ?? {}` →
 * `Array.isArray(props.roleNames) ? props.roleNames : []`）とロジック変更なし。
 */
export function extractRoleNames(parsedBody: unknown): string[] {
  const body = parsedBody as { body?: { forwardedProps?: unknown }; properties?: unknown } | null | undefined;
  const props = (body?.body?.forwardedProps ?? body?.properties ?? {}) as { roleNames?: unknown };
  return Array.isArray(props.roleNames) ? (props.roleNames as string[]) : [];
}

/**
 * セッションヘッダー（X-Role-Names / X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId）
 * を構築する。route.ts の POST ハンドラー内のロジックとロジック変更なし。
 */
export function buildSessionHeaders(roleNames: string[], cognitoSub: string | null): Record<string, string> {
  const sessionHeaders: Record<string, string> = {};
  if (roleNames.length > 0) {
    sessionHeaders["X-Role-Names"] = JSON.stringify(roleNames);
  }
  if (cognitoSub) {
    sessionHeaders["X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId"] = cognitoSub;
  }
  return sessionHeaders;
}

/**
 * Lambda 関数 URL イベント（`LambdaFunctionURLEvent`、
 * `APIGatewayProxyEventV2` 形式のペイロード）を Fetch API の `Request`
 * オブジェクトに変換する。
 *
 * - URL: Function URL は常に HTTPS。ホストは `headers.host`（大文字小文字を
 *   区別せず検索、Function URL のペイロードは通常小文字キーだが念のため）→
 *   フォールバックで `requestContext.domainName` から組み立てる。パスは
 *   `rawPath`、クエリは `rawQueryString` をそのまま使う。
 * - メソッド: `requestContext.http.method` を保持する。
 * - ヘッダー: `event.headers` をそのまま `Headers` に詰める
 *   （Authorization ヘッダーを含む）。HTTP API Payload Format v2.0 は
 *   マルチバリューヘッダーをカンマ結合済みの単一ヘッダーとして渡すため
 *   `multiValueHeaders` は存在しないが、`cookies`（配列）は個別フィールドの
 *   ため `Cookie` ヘッダーに結合して補う。
 * - ボディ: `isBase64Encoded` が true の場合は base64 デコードしてから
 *   `Request` に渡す。GET/HEAD メソッドは body を持てないため付与しない。
 */
export function buildFetchRequestFromLambdaEvent(event: LambdaFunctionURLEvent): Request {
  const method = event.requestContext.http.method;

  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value === undefined) continue;
    headers.set(key, value);
  }
  if (event.cookies && event.cookies.length > 0) {
    headers.set("cookie", event.cookies.join("; "));
  }

  const host =
    findHeaderCaseInsensitive(event.headers, "host") ?? event.requestContext.domainName;
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${host}${event.rawPath}${query}`;

  const hasBody = method !== "GET" && method !== "HEAD" && event.body !== undefined;
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body as string, "base64")
      : (event.body as string)
    : undefined;

  return new Request(url, {
    method,
    headers,
    body,
  });
}

function findHeaderCaseInsensitive(
  headers: Record<string, string | undefined> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

/**
 * 指定した statusCode/headers/body で JSON レスポンスを `responseStream`
 * に直接書き込んで終了する（CopilotKit_Runtime を経由しない即時応答用。
 * 認証ゲートの 401、環境変数未設定の 500 で使う）。
 */
export function writeJsonResponse(
  responseStream: NodeJS.WritableStream,
  statusCode: number,
  body: Record<string, unknown>
): void {
  const httpResponseStream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: { "Content-Type": "application/json" },
  });
  httpResponseStream.write(JSON.stringify(body));
  httpResponseStream.end();
}

/**
 * CopilotKit_Runtime（`copilotRuntimeNodeHttpEndpoint`）が返した `Response`
 * の status/headers/body（`ReadableStream`）を Lambda の `responseStream`
 * に逐次書き込む（pipe）。`response.body` が null の場合は空ボディで
 * ステータスコード・ヘッダーのみを反映して終了する。
 */
export async function pipeResponseToStream(
  response: Response,
  responseStream: NodeJS.WritableStream
): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const httpResponseStream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: response.status,
    headers,
  });

  if (!response.body) {
    httpResponseStream.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        httpResponseStream.write(Buffer.from(value));
      }
    }
  } finally {
    httpResponseStream.end();
  }
}
