import { CopilotRuntime, ExperimentalEmptyAdapter, copilotRuntimeNodeHttpEndpoint } from "@copilotkit/runtime";
import { HttpAgent } from "@ag-ui/client";
import {
  BedrockAgentCoreClient,
  ListEventsCommand,
  type Event as BedrockAgentCoreEvent,
  type ListEventsCommandOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import {
  REGION,
  buildFetchRequestFromLambdaEvent,
  buildInvocationUrl,
  buildSessionHeaders,
  extractBearerToken,
  extractCognitoSub,
  extractRoleNames,
  pipeResponseToStream,
  sessionHeadersStorage,
  sigv4Fetch,
  writeJsonResponse,
} from "./relay";
import {
  convertMemoryEventsToAGUIMessages,
  parseEventPayload,
  type MemoryEvent,
} from "./memoryRestore";
import { isSessionOwnedByActor } from "./memoryRestoreAuthorization";

/**
 * copilotkitStreamingRelay Lambda ハンドラー
 *
 * `src/app/api/copilotkit/route.ts` の中継ロジック（認証ゲート・SigV4 署名・
 * セッションヘッダー伝播・CopilotKit_Runtime への委譲）を、Next.js の
 * Route Handler から Lambda 関数 URL（`InvokeMode: RESPONSE_STREAM`）に
 * 移植したもの。純粋関数・ヘルパーは `./relay.ts` に切り出してあり、
 * このファイルは route.ts の POST ハンドラーの処理順序をそのまま Lambda の
 * I/O 境界に合わせて書き直したものになっている。
 *
 * `awslambda` はビルド時の import を持たないランタイム注入グローバルで、
 * その型は `./awslambda-global.d.ts` で宣言している。
 *
 * 処理順序（route.ts と同一、意図的な変更なし）:
 *   1. runtime が未構成（AGENTCORE_RUNTIME_ARN 未設定）→ 500
 *   2. 認証ゲート（Bearer トークンなし/無効）→ 401
 *   3. リクエストボディから roleNames を抽出（パース失敗は無視）
 *   4. Bearer トークンから Cognito sub を抽出
 *   5. セッションヘッダー（X-Role-Names / X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId）を構築
 *   6. CopilotKit_Runtime（copilotRuntimeNodeHttpEndpoint）に委譲し、
 *      返された Response を responseStream に pipe する
 *
 * 環境変数名の変更（意図的な唯一の差分）: route.ts は
 * `NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN`（Next.js のクライアント埋め込み用
 * プレフィックス付き）を読んでいたが、この Lambda はサーバーサイド専用の
 * `AGENTCORE_RUNTIME_ARN`（`resource.ts` で定義、NEXT_PUBLIC_ プレフィックス
 * 不要）を読む。ロジック自体（`!runtime` チェックの位置、エラーメッセージの
 * スタイル）は変更していない。
 *
 * Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4
 *
 * ─── Memory 読み出し経路の追加（memory-based-chat-history タスク 3.1）─────
 * 上記の POST（AG-UI ストリーミング）経路に加え、`GET`（または専用パス
 * `/memory/events`）へのリクエストは `handleMemoryRestoreRequest` に
 * ルーティングされ、`copilotRuntimeNodeHttpEndpoint` への委譲より前に
 * 完全に別処理として応答する（Lambda 関数 URL はパスベースのルーティング
 * 機能を持たないため、`event.rawPath`/HTTP メソッドを自前で判定する）。
 * 既存の認証ゲート（Bearer トークンなし/無効 → 401）は
 * `handleMemoryRestoreRequest` 内で再利用し、`bedrock-agentcore:ListEvents`
 * を（デフォルト maxResults=20 では長い会話が切り詰められるため）返却された
 * nextToken を辿って全ページ取得し、その結果を `memoryRestore.ts` の変換
 * パイプラインに通してから `{ messages }`（選択セッションの完全なトランスクリプト）
 * の JSON レスポンスとして1回で返す（`writeJsonResponse` を使い、
 * ストリーミングは行わない）。
 *
 * Requirements: 1.1, 2.1, 2.4, 2.5
 *
 * ─── actor_id 不一致時の認可ブロック（memory-based-chat-history タスク 3.2、
 * 高感度: 認証経路）─────────────────────────────────────────
 * `handleMemoryRestoreRequest` は、`bedrock-agentcore:ListEvents` を呼び出す
 * 前に、選択された `sessionId` に対応する ChatSession レコード（DynamoDB、
 * `CHAT_SESSION_TABLE_NAME`）の `ownerUserId` を `GetItem` で取得し、Bearer
 * トークンから抽出した `actorId` と一致するかを検証する（`isSessionOwnedByActor`、
 * `./memoryRestoreAuthorization.ts` の純粋関数）。一致しない場合（ChatSession
 * レコードが存在しない場合を含む）は 403 を返し、`ListEventsCommand`/
 * `bedrockAgentCoreClient.send` を一切呼び出さない。データを取得した後に
 * 結果を拒棄する実装（fetch-then-reject）ではなく、呼び出し前検証であることは
 * `handleMemoryRestoreRequest` のコード上の制御フロー自体で保証される
 * （`return` によりこの関数の残り — ListEvents 呼び出しを含む唯一の経路 — に
 * 到達しない）。
 *
 * Requirements: 3.1, 3.2
 */

const AGENTCORE_RUNTIME_ARN = process.env.AGENTCORE_RUNTIME_ARN;

// AgentCore Memory から `ListEvents` を呼び出すための Memory ID
// （`resource.ts` の環境変数、Runtime ARN とは別管理。memory-based-chat-history
// タスク 1.1 で IAM 権限を先に付与済み）。
const AGENTCORE_MEMORY_ID = process.env.AGENTCORE_MEMORY_ID;

// ChatSession（DynamoDB）テーブル名。actor_id 不一致時の認可ブロック
// （memory-based-chat-history タスク 3.2）のための ChatSession.ownerUserId
// 読み取りに使う。`backend.ts` で `backend.data.resources.tables["ChatSession"]
// .tableName` から synth 時に設定される（`AGENTCORE_RUNTIME_ARN`/
// `AGENTCORE_MEMORY_ID` と同じ、値の読み取りを1箇所に集約する方針）。
const CHAT_SESSION_TABLE_NAME = process.env.CHAT_SESSION_TABLE_NAME;

// Memory 読み出しエンドポイントの専用パス（design.md Component 1）。
// フロントエンドは `GET {functionUrl}/memory/events?sessionId=...` の形で
// リクエストする。HTTP メソッドが GET であること自体も分岐条件に使う
// （AG-UI/CopilotKit へのリクエストは常に POST のため、GET は Memory 読み出し
// 以外に発生しない）。
export const MEMORY_RESTORE_PATH = "/memory/events";

// `bedrock-agentcore:ListEvents` 呼び出し用の SDK クライアント。
// AgentCore Runtime への SigV4 署名（`sigv4Fetch`）とは異なり、SDK クライアントは
// 実行ロールの認証情報チェーン（Lambda 実行ロール）を自動的に使うため、
// 追加の署名ロジックは不要（IAM ポリシーは `resource.ts` タスク 1.1 で
// `bedrock-agentcore:ListEvents` のみに絞って付与済み）。region は `relay.ts` の
// `REGION`（AgentCore Runtime への呼び出しと同一リージョン）を使う。
const bedrockAgentCoreClient = new BedrockAgentCoreClient({ region: REGION });

// ChatSession（DynamoDB）の `ownerUserId` を読み取るための SDK クライアント
// （memory-based-chat-history タスク 3.2）。`bedrockAgentCoreClient` と同じ
// パターンでモジュールスコープに1回だけ生成する。実行ロールの認証情報チェーンを
// 自動的に使うため追加の署名ロジックは不要（IAM 権限は `backend.ts` タスク 3.2 で
// `grantReadData`（読み取り専用）のみを付与済み）。
const dynamoDbClient = new DynamoDBClient({ region: REGION });

/**
 * ChatSession（DynamoDB）テーブルから `sessionId` に対応するレコードの
 * `ownerUserId` を取得する I/O ヘルパー。
 *
 * - レコードが存在しない場合（`GetItemCommand` の結果に `Item` がない）は
 *   `null` を返す（`isSessionOwnedByActor` 側で「所有権を確認できない ⇒
 *   ブロック」として扱う）。
 * - `ownerUserId` フィールドが文字列として存在しない場合（想定外のレコード
 *   形状）も安全側に倒して `null` を返す。
 * - DynamoDB 呼び出し自体が失敗した場合は例外をそのまま呼び出し元に伝播させる
 *   （`handleMemoryRestoreRequest` 側で捕捉し 500 として扱う。「一致しない」と
 *   混同して 403 を返すと、一時的な AWS エラーを認可拒否として誤報告して
 *   しまうため、意図的に区別する）。
 *
 * `CHAT_SESSION_TABLE_NAME` が未設定の場合は DynamoDB を呼び出さず例外を
 * 投げる（`handleMemoryRestoreRequest` 側で事前にガードするため、通常この
 * 分岐に到達することはない）。
 */
async function getChatSessionOwnerUserId(sessionId: string): Promise<string | null> {
  if (!CHAT_SESSION_TABLE_NAME) {
    throw new Error("CHAT_SESSION_TABLE_NAME is not configured");
  }

  const result = await dynamoDbClient.send(
    new GetItemCommand({
      TableName: CHAT_SESSION_TABLE_NAME,
      Key: { id: { S: sessionId } },
    })
  );

  const ownerUserId = result.Item?.ownerUserId?.S;
  return typeof ownerUserId === "string" && ownerUserId.length > 0 ? ownerUserId : null;
}

// モジュールスコープで agent と runtime を1回だけ生成（route.ts と同じパターン）
const agentUrl = AGENTCORE_RUNTIME_ARN ? buildInvocationUrl(AGENTCORE_RUNTIME_ARN) : "";

const agent = agentUrl ? new HttpAgent({ url: agentUrl, fetch: sigv4Fetch }) : null;

// @ts-expect-error — @ag-ui/client HttpAgent と @copilotkit/runtime の型定義のバージョン差異（route.ts と同じ）
const runtime = agent ? new CopilotRuntime({ agents: { sample_agent: agent } }) : null;

// copilotRuntimeNodeHttpEndpoint(...) の戻り値の関数は、Fetch API の
// Request のみを渡す（res 省略）と Promise<Response> を返す
// （design.md「調査済み・確定事項」参照）。Lambda 関数 URL はサブパスを
// 持たないため endpoint は "/" を指定する。
//
// cors オプション（バグ修正 その3: 最終修正）:
// CORS ヘッダーは Lambda 関数 URL の設定（resource.ts で `allowedOrigins: ["*"]`）
// が唯一の源泉として全レスポンスに自動付与する。CopilotKit_Runtime 側からも
// CORS ヘッダーを付与すると二重ヘッダーでブラウザが CORS エラーにするため
// （AWS 公式ドキュメント記載の既知の制約）、空配列 `[]` を渡して
// CopilotKit_Runtime 内部の CORS ヘッダー付与を完全に無効化する。
// （`@copilotkit/runtime` の `resolveOrigin` は空配列に対して null を返し、
// `setCorsHeaders` が何もセットせず return する仕組み）
const handleRequest = runtime
  ? copilotRuntimeNodeHttpEndpoint({
      runtime,
      serviceAdapter: new ExperimentalEmptyAdapter(),
      endpoint: "/",
      cors: { origin: [] },
    })
  : null;

/**
 * Memory 読み出しエンドポイント（`GET /memory/events?sessionId=...`）
 * のハンドラー分岐。ListEvents を全ページ取得し、選択セッションの完全な
 * トランスクリプトを `{ messages }` として1回で返す（クライアント側ページング
 * なし）。
 *
 * 既存の認証ゲート（Bearer トークンなし/無効 → 401）を再利用し、Bearer トークンから
 * 抽出した Cognito sub を `actorId` として使う（クライアント入力からは一切
 * 信頼しない。actor_id 不一致時の認可ブロック（Requirement 3.2）はタスク 3.2 で
 * 別途実装するため、本関数は「認証済みユーザー自身の actor_id でスコープする」
 * ことのみを担保する）。
 *
 * `bedrock-agentcore:ListEvents` の呼び出しが失敗した場合は例外を伝播させず、
 * `{ error: string }` の JSON レスポンス（500）を返す。
 *
 * 独立してユニットテスト可能にするため、`handler.ts` の POST/AG-UI ストリーミング
 * 経路とは完全に分離した関数としてエクスポートする。
 *
 * Requirements: 1.1, 2.1, 2.4, 2.5
 */
export async function handleMemoryRestoreRequest(
  request: Request,
  responseStream: NodeJS.WritableStream
): Promise<void> {
  // ─── 認証ゲート（401）── 既存の AG-UI 経路と同一のゲートを再利用 ───────
  const bearerToken = extractBearerToken(request.headers);
  if (!bearerToken) {
    writeJsonResponse(responseStream, 401, { error: "Unauthorized" });
    return;
  }

  // ─── actor_id（Cognito sub）の抽出 ── サーバー側で導出、クライアント入力は使わない ───
  // `extractCognitoSub` は Cognito JWKS に対する署名検証を行うため非同期
  // （高感度セキュリティ修正、relay.ts 参照）。
  const actorId = await extractCognitoSub(bearerToken);
  if (!actorId) {
    writeJsonResponse(responseStream, 401, { error: "Unauthorized" });
    return;
  }

  if (!AGENTCORE_MEMORY_ID) {
    writeJsonResponse(responseStream, 500, { error: "AGENTCORE_MEMORY_ID is not configured" });
    return;
  }

  if (!CHAT_SESSION_TABLE_NAME) {
    writeJsonResponse(responseStream, 500, { error: "CHAT_SESSION_TABLE_NAME is not configured" });
    return;
  }

  // ─── クエリパラメータ（sessionId 必須）の取得 ──────────────────────
  // サーバー側で全ページを取得する方式（下記のページングループ）に変更したため、
  // クライアントから nextToken を受け取る経路は廃止した（クライアント側ページング
  // は行わない）。ページングを駆動する nextToken は ListEvents が返すもの
  // （サーバー側ページング）のみを使う。
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    writeJsonResponse(responseStream, 400, { error: "sessionId query parameter is required" });
    return;
  }

  // ─── actor_id 不一致時の認可ブロック（呼び出し前検証、高感度: 認証経路）──────
  // `bedrock-agentcore:ListEvents` を呼び出す前に、選択された sessionId に
  // 対応する ChatSession レコードの ownerUserId（DynamoDB）を取得し、
  // 認証済みユーザーの actorId と一致するかを検証する（Requirements 3.1, 3.2）。
  // 一致しない場合（ChatSession レコードが存在しない場合を含む）は 403 を
  // 返し、この時点で return するため、この関数内で ListEvents を呼び出す
  // 経路（下記の bedrockAgentCoreClient.send 呼び出し）には到達しない。
  // データを取得した後に結果を拒棄する実装（fetch-then-reject）ではなく、
  // 呼び出し前検証であることは、この関数の制御フロー自体（early return）が
  // 保証する。
  //
  // getChatSessionOwnerUserId 自体が失敗した場合（DynamoDB 呼び出しエラー、
  // AccessDenied 等）は、一致しないと混同せず 500 として扱う（一時的な AWS
  // エラーを認可拒否として誤報告しないため）。
  let sessionOwnerUserId: string | null;
  try {
    sessionOwnerUserId = await getChatSessionOwnerUserId(sessionId);
  } catch (err) {
    console.error("[copilotkitStreamingRelay] ChatSession lookup failed:", err);
    writeJsonResponse(responseStream, 500, { error: "Failed to verify Chat_Session ownership" });
    return;
  }

  if (!isSessionOwnedByActor(sessionOwnerUserId, actorId)) {
    writeJsonResponse(responseStream, 403, { error: "Forbidden" });
    return;
  }

  // ─── bedrock-agentcore:ListEvents の全ページ取得（サーバー側ページング）──────
  // `bedrock-agentcore:ListEvents` は maxResults を明示しない場合デフォルト 20 件
  // でイベントを打ち切る（API リファレンス記載のデフォルト）。20 件を超える長い
  // 会話は最新 20 件だけに切り詰められてしまうため、`result.nextToken`（ListEvents
  // が返すサーバー側ページングトークン、クライアント入力ではない）が null/undefined に
  // なるまでループしてすべてのページを取得し、各ページの `events` を1つの配列に
  // 連結する。これにより、選択された単一セッションの会話履歴を「全件」返す
  // （このエンドポイントはアクティブな1セッション分の履歴のみを取得するため、
  // 全件取得の対象は常に1セッションに閉じている）。
  //
  // maxResults はデフォルトの 20 より大きい 100 をページごとに明示し、往復回数を
  // 抑える（API リファレンスはデフォルト 20 のみ記載で明示的な上限を規定して
  // いないため、慣例的に安全なページサイズとして 100 を採用。ページサイズの値に
  // 関わらずループの正しさ自体は変わらない）。
  //
  // 防御的な安全上限（暴走防止）: 不正・終端しない nextToken による無限ループを
  // 防ぐため、総ページ数（MAX_PAGES）と累積イベント数（MAX_EVENTS）に上限を設ける。
  // 上限に達した場合はループを打ち切り、console.warn で警告するのみで、例外を投げず
  // エラーも返さない（それまでに取得できたイベントをそのまま返す）。30 日の
  // eventExpiryDuration・1セッションあたりの現実的な会話量から、これらの上限に
  // 通常到達することはなく、あくまで malformed なページング応答に対する保険。
  const MAX_RESULTS_PER_PAGE = 100;
  const MAX_PAGES = 50;
  const MAX_EVENTS = 5000;

  let events: BedrockAgentCoreEvent[];
  try {
    const accumulated: BedrockAgentCoreEvent[] = [];
    let pageToken: string | undefined = undefined;
    let pageCount = 0;
    do {
      const result: ListEventsCommandOutput = await bedrockAgentCoreClient.send(
        new ListEventsCommand({
          memoryId: AGENTCORE_MEMORY_ID,
          actorId,
          sessionId,
          includePayloads: true,
          maxResults: MAX_RESULTS_PER_PAGE,
          nextToken: pageToken,
        })
      );
      accumulated.push(...(result.events ?? []));
      pageToken = result.nextToken;
      pageCount += 1;

      if (pageCount >= MAX_PAGES || accumulated.length >= MAX_EVENTS) {
        if (pageToken) {
          console.warn(
            `[copilotkitStreamingRelay] ListEvents pagination safety cap reached ` +
              `(pages=${pageCount}, events=${accumulated.length}); returning accumulated events without following further nextToken.`
          );
        }
        break;
      }
    } while (pageToken);

    events = accumulated;
  } catch (err) {
    console.error("[copilotkitStreamingRelay] ListEvents failed:", err);
    writeJsonResponse(responseStream, 500, { error: "Failed to retrieve Memory events" });
    return;
  }

  // ─── ListEvents レスポンス → memoryRestore.ts の変換パイプライン ─────────
  // filterConversationalEvents → parseConversationalEventPayload → 変換不可分は
  // 除外 → convertMemoryEventsToAGUIMessages。
  const memoryEvents: MemoryEvent[] = events.map((event) => ({
    eventId: event.eventId ?? "",
    eventTimestamp:
      event.eventTimestamp instanceof Date ? event.eventTimestamp.toISOString() : String(event.eventTimestamp ?? ""),
    payload: (event.payload ?? []).map((item) =>
      item.conversational
        ? {
            conversational: {
              role: item.conversational.role ?? "",
              content: { text: item.conversational.content?.text ?? "" },
            },
          }
        : { blob: item.blob }
    ),
  }));

  // ─── eventTimestamp 昇順（古い順）への並べ替え ── I/O 境界での順序前提の確立 ──
  // 上記のページングループで全ページを連結した「累積済みの MemoryEvent 配列全体」に
  // 対して、ここで1回だけ昇順ソートを行う（ページごとの部分ソートは行わない）。
  // `bedrock-agentcore:ListEvents` は eventTimestamp の降順（新しい順）で
  // イベントを返し（ライブデータで確認済み。先頭要素が最新メッセージ、末尾が
  // 最古メッセージ）、かつ sort/order パラメータを一切持たない（API リファレンス
  // 上のパラメータは actorId / filter / includePayloads / maxResults / memoryId /
  // nextToken / sessionId のみ）。ページ境界をまたいでも降順（page 1 が最新群、
  // page 2 以降が古い群）のため、全ページ連結後に一括で昇順ソートする必要がある。
  // 一方、チャットトランスクリプトは古い順（上が最古・
  // 下が最新）で描画する必要があり、`memoryRestore.ts` の変換パイプライン
  // （filterConversationalEvents → parseConversationalEventPayload →
  // convertMemoryEventsToAGUIMessages）は入力の相対順序をそのまま保存する契約
  // （design.md Property 4 の前提 =「eventTimestamp の昇順で並んだ MemoryEvent の
  // リスト」）を持つ。したがって、降順のまま渡すと出力も降順になり新しい順に
  // 描画されてしまう。ここで昇順に並べ替えて design.md Property 4 が前提とする
  // 入力順序を確立し、パイプラインの順序保存保証によって古い順の AGUIMessage[] を
  // 得る。
  //
  // `.reverse()` ではなく eventTimestamp をパースした明示的な昇順ソートを使う:
  // 現状のライブデータは厳密な降順のため `.reverse()` でも今日は動作するが、
  // 将来的な API の順序変更やページング境界に対して頑健であり、意図する不変条件
  // （昇順 = Property 4 の前提）をコード上で明示できる。JS の Array.prototype.sort
  // は modern Node で安定ソートのため、同一 eventTimestamp の要素は元の相対順序を
  // 保つ。
  //
  // 二次ソートキー（eventId）による順序の安定化: `eventTimestamp` は 1 秒解像度
  // （ミリ秒未満は保持されない）のため、同一秒内に記録された複数イベントは
  // `Date.parse` の結果が同値になり、リロードのたびに相対順が入れ替わり得る
  // （画像ターンの断続的な消失・並び乱れを増幅する要因）。`eventId`
  // （例 `"0000001756147154000#ffa53e54"`）は先頭が固定桁数のゼロ埋めタイムスタンプで
  // 辞書順ソート可能なため、タイムスタンプが同値の場合の決定的な二次キーとして使う。
  const sortedMemoryEvents = [...memoryEvents].sort(
    (a, b) =>
      Date.parse(a.eventTimestamp) - Date.parse(b.eventTimestamp) ||
      a.eventId.localeCompare(b.eventId)
  );

  // blob イベントを事前に落とさず、conversational / blob の双方を
  // `parseEventPayload` で会話メッセージへデコードする（上限超過で blob 化された
  // 画像ターンを復元するため。従来は filterConversationalEvents が blob を除外し、
  // テキスト＋画像が丸ごと消えていた）。変換不可（会話メッセージでない blob 等）は
  // null を返し、ここで除外する。
  // 各パース済みメッセージに、その復元元イベントの `eventTimestamp` を添えて
  // convert に渡す（convert はこれを `Date.parse` して各メッセージの `createdAt`
  // として付与する。フロントエンドが記録時刻 HH:MM を表示するため）。parse* 関数
  // 自体は従来どおり `{ role, content }` を返し、ここで元イベントの eventTimestamp を
  // 合成する（parse 関数のシグネチャ・既存テストを変えない）。
  const parsedEvents = sortedMemoryEvents
    .map((event) => {
      const parsed = parseEventPayload(event);
      return parsed ? { ...parsed, eventTimestamp: event.eventTimestamp } : null;
    })
    .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null);

  const messages = convertMemoryEventsToAGUIMessages(parsedEvents);

  // サーバー側で全ページを取得し完全なトランスクリプトを1回で返すため、
  // レスポンスに nextToken は含めない（クライアント側ページングは行わない）。
  writeJsonResponse(responseStream, 200, { messages });
}

export const handler = awslambda.streamifyResponse(
  async (event: LambdaFunctionURLEvent, responseStream: NodeJS.WritableStream) => {
    // ─── Memory 読み出しエンドポイントへのルーティング分岐 ──────────────
    // AG-UI/CopilotKit へのリクエストは常に POST のため、GET または専用パス
    // `/memory/events` へのリクエストは、既存の copilotRuntimeNodeHttpEndpoint
    // への委譲より前に別処理へルーティングする（memory-based-chat-history
    // タスク 3.1）。Lambda 関数 URL はパスベースのルーティング機能を持たないため
    // `event.rawPath`/HTTP メソッドを自前で判定する。
    const httpMethod = event.requestContext.http.method;
    if (httpMethod === "GET" || event.rawPath === MEMORY_RESTORE_PATH) {
      const request = buildFetchRequestFromLambdaEvent(event);
      await handleMemoryRestoreRequest(request, responseStream);
      return;
    }

    if (!runtime || !handleRequest) {
      writeJsonResponse(responseStream, 500, { error: "AGENTCORE_RUNTIME_ARN is not configured" });
      return;
    }

    const request = buildFetchRequestFromLambdaEvent(event);

    // ─── 認証ゲート（401）──────────────────────────────────────
    // 有効な Cognito Bearer トークンがない場合は CopilotKit_Runtime に
    // 処理を委譲せず即 401。
    const bearerToken = extractBearerToken(request.headers);
    if (!bearerToken) {
      writeJsonResponse(responseStream, 401, { error: "Unauthorized" });
      return;
    }

    // ─── Role_Set（roleNames）の抽出 ────────────────────────────
    // ボディを clone して解析する（パース失敗はフローを止めない、route.ts と同じ）。
    let roleNames: string[] = [];
    try {
      const clonedBody = await request.clone().json();
      roleNames = extractRoleNames(clonedBody);
    } catch {
      // ボディの JSON パースに失敗してもフローを止めない（CopilotKit の内部リクエストもある）
    }

    console.log("[copilotkitStreamingRelay] properties received:", { roleNames });

    // ─── actor_id（Cognito sub）の抽出 ──────────────────────────
    // `extractCognitoSub` は Cognito JWKS に対する署名検証を行うため非同期
    // （高感度セキュリティ修正、relay.ts 参照）。
    const cognitoSub = await extractCognitoSub(bearerToken);

    const sessionHeaders = buildSessionHeaders(roleNames, cognitoSub);
    console.log("[copilotkitStreamingRelay] session headers:", sessionHeaders);

    // ─── CopilotKit_Runtime に委譲し、Response を responseStream に pipe ───
    // sigv4Fetch は handleRequest の内部で非同期に呼び出される。
    // sessionHeadersStorage.run() でこのリクエストの非同期コンテキスト内に
    // sessionHeaders を閉じ込めることで、並行する他リクエストの値と
    // 混ざらないようにする（route.ts と同じ）。
    const response = await sessionHeadersStorage.run(sessionHeaders, () => handleRequest(request));
    await pipeResponseToStream(response as Response, responseStream);
  }
);
