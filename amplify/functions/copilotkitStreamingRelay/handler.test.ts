import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { LambdaFunctionURLEvent } from "aws-lambda";

/**
 * copilotkitStreamingRelay handler.ts のテスト（タスク 3.1 で実装したロジックに対する）。
 *
 * `awslambda.streamifyResponse()` は Lambda Node.js マネージドランタイムが
 * 実行時に注入するグローバルであり、vitest（ローカル Node.js 環境）には
 * 存在しない。そのため、このテストでは `awslambda` の最小限のフェイク実装を
 * `globalThis` に設定してから `handler.ts` を動的 import する。
 *
 * `@copilotkit/runtime` / `@ag-ui/client` は実際の CopilotKit_Runtime・
 * SigV4/fetch を呼び出さず、ここではモック化して以下を検証する
 * （実際の SigV4 署名や AgentCore Runtime への通信はモジュール内部の
 * `sigv4Fetch`/`HttpAgent` の責務であり、単体テストの対象外。
 * 統合的な動作確認は sandbox デプロイ後にタスク 6 で行う）:
 *
 * (a) `AGENTCORE_RUNTIME_ARN` 未設定 → 500、CopilotKit_Runtime 未呼び出し
 * (b) Bearer トークンなし/無効 → 401、CopilotKit_Runtime 未呼び出し
 * (c) 正常系: モック化した `copilotRuntimeNodeHttpEndpoint` の戻り値の
 *     Response（ReadableStream body）が responseStream に逐次書き込まれる
 * (d) roleNames / Cognito sub からのセッションヘッダー構築が
 *     `sessionHeadersStorage` 経由で CopilotKit_Runtime 呼び出し中に
 *     参照可能であることを確認する
 *
 * `AGENTCORE_RUNTIME_ARN` は module スコープで読まれるため、テストごとに
 * 異なる値を反映させるには `vi.resetModules()` + 動的 import が必要。
 *
 * Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4
 */

let handleRequestImpl: (request: Request) => Promise<Response> = vi.fn();
const copilotRuntimeNodeHttpEndpointMock = vi.fn(() => (request: Request) => handleRequestImpl(request));

vi.mock("@copilotkit/runtime", () => ({
  CopilotRuntime: vi.fn().mockImplementation(function (this: Record<string, unknown>, opts: unknown) {
    this.opts = opts;
  }),
  ExperimentalEmptyAdapter: vi.fn().mockImplementation(() => ({})),
  copilotRuntimeNodeHttpEndpoint: copilotRuntimeNodeHttpEndpointMock,
}));

vi.mock("@ag-ui/client", () => ({
  HttpAgent: vi.fn().mockImplementation((opts: unknown) => ({ opts })),
}));

// `bedrock-agentcore:ListEvents` の呼び出し（Memory 読み出しエンドポイント、
// タスク 3.1）をモック化する。実際の AWS 呼び出しは行わず、
// `bedrockAgentCoreClientSendMock` の戻り値/例外で ListEvents の結果を制御する。
let bedrockAgentCoreClientSendMock: ReturnType<typeof vi.fn> = vi.fn();
const listEventsCommandMock = vi.fn((input: unknown) => ({ input }));

vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => bedrockAgentCoreClientSendMock(...args),
  })),
  ListEventsCommand: listEventsCommandMock,
}));

// ChatSession（DynamoDB）の GetItem 呼び出し（actor_id 不一致時の認可ブロック、
// タスク 3.2）をモック化する。実際の AWS 呼び出しは行わず、
// `dynamoDbClientSendMock` の戻り値/例外で GetItem の結果を制御する。
let dynamoDbClientSendMock: ReturnType<typeof vi.fn> = vi.fn();
const getItemCommandMock = vi.fn((input: unknown) => ({ input }));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => dynamoDbClientSendMock(...args),
  })),
  GetItemCommand: getItemCommandMock,
}));

// Cognito JWT の署名検証（`extractCognitoSub`、高感度セキュリティ修正）を
// モック化する。実際の Cognito JWKS エンドポイントへのネットワークアクセスは
// 行わず、`cognitoJwtVerifierVerifyMock` の戻り値/例外で検証結果を制御する。
// このテストファイルの `fakeJwt(sub)` は依然として3セグメントの見た目だけの
// トークンを作るが、署名検証自体は完全にモックされるため、
// `cognitoJwtVerifierVerifyMock` が「sub を含む payload を返す」ことで
// 「検証成功」を、「reject する」ことで「検証失敗」をシミュレートする。
let cognitoJwtVerifierVerifyMock: ReturnType<typeof vi.fn> = vi.fn();

vi.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: {
    create: vi.fn(() => ({
      verify: (...args: unknown[]) => cognitoJwtVerifierVerifyMock(...args),
    })),
  },
}));

beforeAll(() => {
  (globalThis as unknown as { awslambda: unknown }).awslambda = {
    streamifyResponse:
      <TEvent, TStream, TContext>(
        fn: (event: TEvent, responseStream: TStream, context: TContext) => Promise<void>
      ) =>
      (event: TEvent, responseStream: TStream, context: TContext) =>
        fn(event, responseStream, context),
    HttpResponseStream: {
      from: (
        responseStream: { metadata?: unknown },
        metadata: { statusCode: number; headers: Record<string, string> }
      ) => {
        responseStream.metadata = metadata;
        return responseStream;
      },
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  handleRequestImpl = vi.fn();
  copilotRuntimeNodeHttpEndpointMock.mockClear();
  bedrockAgentCoreClientSendMock = vi.fn();
  listEventsCommandMock.mockClear();
  dynamoDbClientSendMock = vi.fn();
  getItemCommandMock.mockClear();
  delete process.env.AGENTCORE_MEMORY_ID;
  delete process.env.CHAT_SESSION_TABLE_NAME;

  // Cognito JWT 署名検証（`extractCognitoSub`）が「有効なトークン」の場合に
  // 検証成功として振る舞うデフォルトのモック実装。`fakeJwt(sub)` が作る
  // トークンのペイロード（3セグメント目の中央）から sub を取り出して返す
  // （実際の署名検証はモックしているため、"署名が正しいふり" をする）。
  // 個別のテストで「検証失敗」（無効な署名等）を確認する場合は、この
  // モックをテストごとに reject するよう上書きする。
  process.env.COGNITO_USER_POOL_ID = "us-west-2_testpool";
  process.env.COGNITO_USER_POOL_CLIENT_ID = "test-client-id";
  cognitoJwtVerifierVerifyMock = vi.fn(async (jwt: string) => {
    const parts = jwt.split(".");
    if (parts.length !== 3) throw new Error("invalid jwt shape");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return payload;
  });
});

function createFakeResponseStream() {
  const chunks: Buffer[] = [];
  let ended = false;
  const stream: {
    write: (chunk: string | Buffer) => boolean;
    end: () => void;
    metadata?: { statusCode: number; headers: Record<string, string> };
  } = {
    write: (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      return true;
    },
    end: () => {
      ended = true;
    },
  };
  return { stream, chunks, isEnded: () => ended };
}

function createFakeEvent(overrides: Partial<LambdaFunctionURLEvent> = {}): LambdaFunctionURLEvent {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    headers: {},
    body: undefined,
    isBase64Encoded: false,
    requestContext: {
      domainName: "example.lambda-url.us-west-2.on.aws",
      http: { method: "POST", path: "/", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
    },
    ...overrides,
  } as unknown as LambdaFunctionURLEvent;
}

function base64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function fakeJwt(sub: string): string {
  return `${base64url({ alg: "none" })}.${base64url({ sub })}.signature`;
}

describe("copilotkitStreamingRelay handler", () => {
  it("(a) AGENTCORE_RUNTIME_ARN が未設定の場合、500 を返し CopilotKit_Runtime を呼び出さない", async () => {
    process.env.AGENTCORE_RUNTIME_ARN = "";
    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(createFakeEvent(), stream as never, {} as never);

    expect(stream.metadata?.statusCode).toBe(500);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(parsed.error).toContain("AGENTCORE_RUNTIME_ARN");
    expect(handleRequestImpl).not.toHaveBeenCalled();
  });

  it("(b) Bearer トークンがない場合、401 を返し CopilotKit_Runtime を呼び出さない", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(createFakeEvent({ headers: {} }), stream as never, {} as never);

    expect(stream.metadata?.statusCode).toBe(401);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(parsed.error).toBe("Unauthorized");
    expect(handleRequestImpl).not.toHaveBeenCalled();
  });

  it("(b) Bearer プレフィックスのない Authorization ヘッダーも 401 になる", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
    const { handler } = await import("./handler");
    const { stream } = createFakeResponseStream();

    await handler(
      createFakeEvent({ headers: { authorization: "Basic abc123" } }),
      stream as never,
      {} as never
    );

    expect(stream.metadata?.statusCode).toBe(401);
    expect(handleRequestImpl).not.toHaveBeenCalled();
  });

  it("(c) 正常系: CopilotKit_Runtime の Response（ReadableStream body）が responseStream に逐次書き込まれる", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";

    handleRequestImpl = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk-1"));
          controller.enqueue(new TextEncoder().encode("chunk-2"));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const { handler } = await import("./handler");
    const { stream, chunks, isEnded } = createFakeResponseStream();

    await handler(
      createFakeEvent({ headers: { authorization: `Bearer ${fakeJwt("user-123")}` } }),
      stream as never,
      {} as never
    );

    expect(handleRequestImpl).toHaveBeenCalledTimes(1);
    expect(stream.metadata?.statusCode).toBe(200);
    expect(stream.metadata?.headers["content-type"]).toBe("text/event-stream");
    expect(Buffer.concat(chunks).toString("utf-8")).toBe("chunk-1chunk-2");
    expect(isEnded()).toBe(true);
  });

  it("(d) roleNames と Cognito sub からセッションヘッダーが構築され、CopilotKit_Runtime 呼び出し中に参照できる", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";

    let observedSessionHeaders: Record<string, string> | undefined;
    handleRequestImpl = vi.fn(async () => {
      const { sessionHeadersStorage } = await import("./relay");
      observedSessionHeaders = sessionHeadersStorage.getStore();
      return new Response(null, { status: 200 });
    });

    const { handler } = await import("./handler");
    const { stream } = createFakeResponseStream();

    const requestBody = JSON.stringify({ body: { forwardedProps: { roleNames: ["viewer", "editor"] } } });

    await handler(
      createFakeEvent({
        headers: { authorization: `Bearer ${fakeJwt("cognito-sub-456")}`, "content-type": "application/json" },
        body: requestBody,
      }),
      stream as never,
      {} as never
    );

    expect(observedSessionHeaders).toEqual({
      "X-Role-Names": JSON.stringify(["viewer", "editor"]),
      "X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId": "cognito-sub-456",
    });
  });

  it("(e) copilotRuntimeNodeHttpEndpoint に cors オプション（空配列で CORS 無効化）が渡される", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";

    await import("./handler");

    expect(copilotRuntimeNodeHttpEndpointMock).toHaveBeenCalledTimes(1);
    const options = (copilotRuntimeNodeHttpEndpointMock.mock.calls[0] as unknown as [{ cors?: { origin: string[] } }])[0];
    expect(options.cors).toEqual({ origin: [] });
  });

  it("(f) JWT の形（3セグメント）はあるが署名検証に失敗する場合、Cognito sub は抽出されずセッションヘッダーに含まれない（高感度セキュリティ修正）", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";

    // 署名検証が失敗するケースをシミュレート（例: 偽造トークン、期限切れ等）。
    cognitoJwtVerifierVerifyMock = vi.fn(async () => {
      throw new Error("signature verification failed");
    });

    let observedSessionHeaders: Record<string, string> | undefined;
    handleRequestImpl = vi.fn(async () => {
      const { sessionHeadersStorage } = await import("./relay");
      observedSessionHeaders = sessionHeadersStorage.getStore();
      return new Response(null, { status: 200 });
    });

    const { handler } = await import("./handler");
    const { stream } = createFakeResponseStream();

    // fakeJwt は3セグメントの見た目を持つが、署名検証（モック）が失敗する。
    await handler(
      createFakeEvent({ headers: { authorization: `Bearer ${fakeJwt("forged-sub")}` } }),
      stream as never,
      {} as never
    );

    expect(cognitoJwtVerifierVerifyMock).toHaveBeenCalledTimes(1);
    expect(observedSessionHeaders).toEqual({});
  });

  it("(d) roleNames が空・sub がない場合、セッションヘッダーは空オブジェクトになる", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";

    let observedSessionHeaders: Record<string, string> | undefined;
    handleRequestImpl = vi.fn(async () => {
      const { sessionHeadersStorage } = await import("./relay");
      observedSessionHeaders = sessionHeadersStorage.getStore();
      return new Response(null, { status: 200 });
    });

    const { handler } = await import("./handler");
    const { stream } = createFakeResponseStream();

    // Bearer トークンは3セグメントを満たさない不正な JWT のため sub は抽出されない
    await handler(
      createFakeEvent({ headers: { authorization: "Bearer not-a-jwt" } }),
      stream as never,
      {} as never
    );

    expect(observedSessionHeaders).toEqual({});
  });
});

/**
 * Memory 読み出しエンドポイント（`GET /memory/events`）のルーティング分岐
 * テスト（タスク 3.1）。
 *
 * (a) 既存の POST/AG-UI ストリーミング経路が新しい分岐の影響を受けないこと
 * (b) GET /memory/events + 有効な Bearer トークン + ListEvents モックの正常系 →
 *     { messages } の JSON レスポンス（全ページ取得後の完全なトランスクリプト）
 * (b'') 複数ページを返却された nextToken で全件取得し、境界を越えて昇順に並べる
 * (b''') 終端しない nextToken でも安全上限でループを打ち切る
 * (c) 有効な Bearer トークンがない場合 → 401（CopilotKit_Runtime・ListEvents
 *     いずれも未呼び出し）
 * (d) ListEvents 呼び出しが失敗した場合 → { error: string } の JSON レスポンス
 *
 * Requirements: 1.1, 2.1, 2.4, 2.5
 */
describe("copilotkitStreamingRelay handler — Memory 読み出しエンドポイント（GET /memory/events）", () => {
  function createFakeGetEvent(overrides: Partial<LambdaFunctionURLEvent> = {}): LambdaFunctionURLEvent {
    return createFakeEvent({
      rawPath: "/memory/events",
      rawQueryString: "sessionId=session-123",
      requestContext: {
        domainName: "example.lambda-url.us-west-2.on.aws",
        http: { method: "GET", path: "/memory/events", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
      } as unknown as LambdaFunctionURLEvent["requestContext"],
      ...overrides,
    });
  }

  it("(a) 既存の POST/AG-UI ストリーミング経路は GET 分岐の追加による影響を受けない", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";

    handleRequestImpl = vi.fn(async () => new Response(null, { status: 200 }));

    const { handler } = await import("./handler");
    const { stream } = createFakeResponseStream();

    await handler(
      createFakeEvent({ headers: { authorization: `Bearer ${fakeJwt("user-123")}` } }),
      stream as never,
      {} as never
    );

    expect(handleRequestImpl).toHaveBeenCalledTimes(1);
    expect(bedrockAgentCoreClientSendMock).not.toHaveBeenCalled();
  });

  it("(b) GET /memory/events + 有効な Bearer トークンで ListEvents の結果を { messages, nextToken } として返す", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
    process.env.AGENTCORE_MEMORY_ID = "agents_TestMemory-abc123";
    process.env.CHAT_SESSION_TABLE_NAME = "ChatSession-test-NONE";

    // actor_id 不一致時の認可ブロック（タスク 3.2）の事前検証を通過させるため、
    // ChatSession レコードの ownerUserId が Bearer トークンの actorId
    // （"cognito-sub-456"）と一致する GetItem 結果を返す。
    dynamoDbClientSendMock = vi.fn(async () => ({
      Item: { ownerUserId: { S: "cognito-sub-456" } },
    }));

    // 単一ページ（nextToken なし）→ ページングループは1回で終了する。
    bedrockAgentCoreClientSendMock = vi.fn(async () => ({
      events: [
        {
          eventId: "event-1",
          eventTimestamp: new Date("2024-01-01T00:00:00.000Z"),
          payload: [
            {
              conversational: {
                role: "USER",
                content: { text: JSON.stringify({ message: { role: "user", content: [{ text: "こんにちは" }] } }) },
              },
            },
          ],
        },
      ],
      nextToken: undefined,
    }));

    const { handler, MEMORY_RESTORE_PATH } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("cognito-sub-456")}` } }),
      stream as never,
      {} as never
    );

    expect(MEMORY_RESTORE_PATH).toBe("/memory/events");
    expect(handleRequestImpl).not.toHaveBeenCalled();
    expect(bedrockAgentCoreClientSendMock).toHaveBeenCalledTimes(1);
    expect(listEventsCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: "agents_TestMemory-abc123",
        actorId: "cognito-sub-456",
        sessionId: "session-123",
      })
    );

    expect(stream.metadata?.statusCode).toBe(200);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    // サーバー側で全ページを取得し完全なトランスクリプトを返すため、
    // レスポンスに nextToken は含まれない（このモックは単一ページ = nextToken
    // なしのため、ページングループは1回で終了し messages のみを返す）。
    expect(parsed.nextToken).toBeUndefined();
    expect(parsed.messages).toEqual([
      {
        id: "event-0-text-0",
        role: "user",
        content: "こんにちは",
        createdAt: Date.parse("2024-01-01T00:00:00.000Z"),
      },
    ]);
  });

  it("(b') ListEvents が降順（新しい順）で返しても、messages は昇順（古い順）に並べ替えて返す", async () => {
    // `bedrock-agentcore:ListEvents` は実 API では eventTimestamp の降順
    // （新しい順・先頭が最新）でイベントを返し、sort/order パラメータを持たない。
    // ハンドラーが変換パイプラインに渡す前に昇順（古い順）へ並べ替えることで、
    // チャットトランスクリプト（上が最古・下が最新）として正しい順序で返ることを
    // 検証する（design.md Property 4 の入力前提を復元する）。
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
    process.env.AGENTCORE_MEMORY_ID = "agents_TestMemory-abc123";
    process.env.CHAT_SESSION_TABLE_NAME = "ChatSession-test-NONE";

    dynamoDbClientSendMock = vi.fn(async () => ({
      Item: { ownerUserId: { S: "cognito-sub-456" } },
    }));

    // 実 API を模倣し、新しい順（降順）で返す:
    // 先頭 = より新しい assistant 応答、末尾 = より古い user 発言。
    bedrockAgentCoreClientSendMock = vi.fn(async () => ({
      events: [
        {
          eventId: "event-newer",
          eventTimestamp: new Date("2024-01-01T00:00:05.000Z"),
          payload: [
            {
              conversational: {
                role: "ASSISTANT",
                content: {
                  text: JSON.stringify({ message: { role: "assistant", content: [{ text: "こんにちは、how can I help?" }] } }),
                },
              },
            },
          ],
        },
        {
          eventId: "event-older",
          eventTimestamp: new Date("2024-01-01T00:00:00.000Z"),
          payload: [
            {
              conversational: {
                role: "USER",
                content: { text: JSON.stringify({ message: { role: "user", content: [{ text: "最初の質問です" }] } }) },
              },
            },
          ],
        },
      ],
      nextToken: undefined,
    }));

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("cognito-sub-456")}` } }),
      stream as never,
      {} as never
    );

    expect(stream.metadata?.statusCode).toBe(200);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    // 古い順（昇順）: user 発言が先、assistant 応答が後。
    expect(parsed.messages).toEqual([
      {
        id: "event-0-text-0",
        role: "user",
        content: "最初の質問です",
        createdAt: Date.parse("2024-01-01T00:00:00.000Z"),
      },
      {
        id: "event-1-text-0",
        role: "assistant",
        content: "こんにちは、how can I help?",
        createdAt: Date.parse("2024-01-01T00:00:05.000Z"),
      },
    ]);
  });

  it("(b'') 複数ページにまたがる履歴を、返却された nextToken を辿って全件取得し、ページ境界を越えて昇順に並べる", async () => {
    // `bedrock-agentcore:ListEvents` はデフォルト maxResults=20 で長い会話を
    // 切り詰めるため、返却された nextToken を辿って全ページを取得する必要がある。
    // 実 API を模倣し、各ページは eventTimestamp の降順（新しい順）で返し、
    // page 1 = より新しいイベント群、page 2 = より古いイベント群とする。
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
    process.env.AGENTCORE_MEMORY_ID = "agents_TestMemory-abc123";
    process.env.CHAT_SESSION_TABLE_NAME = "ChatSession-test-NONE";

    dynamoDbClientSendMock = vi.fn(async () => ({
      Item: { ownerUserId: { S: "cognito-sub-456" } },
    }));

    const userEvent = (eventId: string, ts: string, text: string) => ({
      eventId,
      eventTimestamp: new Date(ts),
      payload: [
        {
          conversational: {
            role: "USER",
            content: { text: JSON.stringify({ message: { role: "user", content: [{ text }] } }) },
          },
        },
      ],
    });

    // page 1: 新しい群（降順）。nextToken あり → 2ページ目へ続く。
    // page 2: 古い群（降順）。nextToken なし → ループ終了。
    bedrockAgentCoreClientSendMock = vi
      .fn()
      .mockResolvedValueOnce({
        events: [
          userEvent("p1-a", "2024-01-01T00:00:03.000Z", "third"),
          userEvent("p1-b", "2024-01-01T00:00:02.000Z", "second"),
        ],
        nextToken: "page-2-token",
      })
      .mockResolvedValueOnce({
        events: [
          userEvent("p2-a", "2024-01-01T00:00:01.000Z", "first"),
          userEvent("p2-b", "2024-01-01T00:00:00.000Z", "zeroth"),
        ],
        nextToken: undefined,
      });

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("cognito-sub-456")}` } }),
      stream as never,
      {} as never
    );

    // (a) 2ページ分（各ページで1回）呼び出される。
    expect(bedrockAgentCoreClientSendMock).toHaveBeenCalledTimes(2);
    // 1ページ目は nextToken なし、2ページ目は返却された nextToken を使う
    // （サーバー側ページング。クライアント入力ではない）。
    expect(listEventsCommandMock.mock.calls[0][0]).toMatchObject({ nextToken: undefined });
    expect(listEventsCommandMock.mock.calls[1][0]).toMatchObject({ nextToken: "page-2-token" });

    expect(stream.metadata?.statusCode).toBe(200);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    // (b) 両ページのイベントが含まれ、(c) ページ境界を越えて昇順（最古が先頭）。
    expect(parsed.messages).toEqual([
      { id: "event-0-text-0", role: "user", content: "zeroth", createdAt: Date.parse("2024-01-01T00:00:00.000Z") },
      { id: "event-1-text-0", role: "user", content: "first", createdAt: Date.parse("2024-01-01T00:00:01.000Z") },
      { id: "event-2-text-0", role: "user", content: "second", createdAt: Date.parse("2024-01-01T00:00:02.000Z") },
      { id: "event-3-text-0", role: "user", content: "third", createdAt: Date.parse("2024-01-01T00:00:03.000Z") },
    ]);
  });

  it("(b''') 終端しない nextToken でも安全上限でループを打ち切り、ハングせずに応答する", async () => {
    // malformed / 終端しないページング応答（常に nextToken を返す）に対して、
    // ページ数の安全上限（MAX_PAGES=50）でループを打ち切ることを検証する
    // （例外を投げず、それまでに取得したイベントを 200 で返す）。
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
    process.env.AGENTCORE_MEMORY_ID = "agents_TestMemory-abc123";
    process.env.CHAT_SESSION_TABLE_NAME = "ChatSession-test-NONE";

    dynamoDbClientSendMock = vi.fn(async () => ({
      Item: { ownerUserId: { S: "cognito-sub-456" } },
    }));

    // 常に nextToken を返し続ける（終端しない）。1ページあたり1イベント。
    bedrockAgentCoreClientSendMock = vi.fn(async () => ({
      events: [
        {
          eventId: "loop-event",
          eventTimestamp: new Date("2024-01-01T00:00:00.000Z"),
          payload: [
            {
              conversational: {
                role: "USER",
                content: { text: JSON.stringify({ message: { role: "user", content: [{ text: "loop" }] } }) },
              },
            },
          ],
        },
      ],
      nextToken: "never-ending-token",
    }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { handler } = await import("./handler");
    const { stream } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("cognito-sub-456")}` } }),
      stream as never,
      {} as never
    );

    // ページ数の安全上限（MAX_PAGES=50）でちょうど打ち切られ、無限ループしない。
    expect(bedrockAgentCoreClientSendMock).toHaveBeenCalledTimes(50);
    expect(warnSpy).toHaveBeenCalled();
    expect(stream.metadata?.statusCode).toBe(200);

    warnSpy.mockRestore();
  });

  it("(c) 有効な Bearer トークンがない場合、401 を返し ListEvents を呼び出さない", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
    process.env.AGENTCORE_MEMORY_ID = "agents_TestMemory-abc123";
    process.env.CHAT_SESSION_TABLE_NAME = "ChatSession-test-NONE";

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(createFakeGetEvent({ headers: {} }), stream as never, {} as never);

    expect(stream.metadata?.statusCode).toBe(401);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(parsed.error).toBe("Unauthorized");
    expect(dynamoDbClientSendMock).not.toHaveBeenCalled();
    expect(bedrockAgentCoreClientSendMock).not.toHaveBeenCalled();
    expect(handleRequestImpl).not.toHaveBeenCalled();
  });

  it("(c') JWT の形はあるが署名検証に失敗する場合、401 を返し ListEvents を呼び出さない（高感度セキュリティ修正）", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
    process.env.AGENTCORE_MEMORY_ID = "agents_TestMemory-abc123";
    process.env.CHAT_SESSION_TABLE_NAME = "ChatSession-test-NONE";

    // 偽造トークン（3セグメントの見た目だけで、有効な署名を持たない）を
    // シミュレート。攻撃者が被害者の sub を主張しても、署名検証が失敗すれば
    // 401 として拒否されなければならない。
    cognitoJwtVerifierVerifyMock = vi.fn(async () => {
      throw new Error("signature verification failed");
    });

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("victim-actor-id")}` } }),
      stream as never,
      {} as never
    );

    expect(cognitoJwtVerifierVerifyMock).toHaveBeenCalledTimes(1);
    expect(stream.metadata?.statusCode).toBe(401);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(parsed.error).toBe("Unauthorized");
    expect(dynamoDbClientSendMock).not.toHaveBeenCalled();
    expect(bedrockAgentCoreClientSendMock).not.toHaveBeenCalled();
  });

  it("(d) ListEvents の呼び出しが失敗した場合、{ error: string } を返す", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
    process.env.AGENTCORE_MEMORY_ID = "agents_TestMemory-abc123";
    process.env.CHAT_SESSION_TABLE_NAME = "ChatSession-test-NONE";

    dynamoDbClientSendMock = vi.fn(async () => ({
      Item: { ownerUserId: { S: "cognito-sub-456" } },
    }));

    bedrockAgentCoreClientSendMock = vi.fn(async () => {
      throw new Error("AccessDeniedException");
    });

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("cognito-sub-456")}` } }),
      stream as never,
      {} as never
    );

    expect(stream.metadata?.statusCode).toBe(500);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error.length).toBeGreaterThan(0);
  });

  it("(e) sessionId クエリパラメータがない場合、400 を返し ListEvents を呼び出さない", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
    process.env.AGENTCORE_MEMORY_ID = "agents_TestMemory-abc123";
    process.env.CHAT_SESSION_TABLE_NAME = "ChatSession-test-NONE";

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ rawQueryString: "", headers: { authorization: `Bearer ${fakeJwt("cognito-sub-456")}` } }),
      stream as never,
      {} as never
    );

    expect(stream.metadata?.statusCode).toBe(400);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(typeof parsed.error).toBe("string");
    expect(dynamoDbClientSendMock).not.toHaveBeenCalled();
    expect(bedrockAgentCoreClientSendMock).not.toHaveBeenCalled();
  });

  it("(f) AGENTCORE_MEMORY_ID が未設定の場合、500 を返し ListEvents を呼び出さない", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
    process.env.CHAT_SESSION_TABLE_NAME = "ChatSession-test-NONE";
    // AGENTCORE_MEMORY_ID は beforeEach で削除済み（未設定）

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("cognito-sub-456")}` } }),
      stream as never,
      {} as never
    );

    expect(stream.metadata?.statusCode).toBe(500);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(parsed.error).toContain("AGENTCORE_MEMORY_ID");
    expect(dynamoDbClientSendMock).not.toHaveBeenCalled();
    expect(bedrockAgentCoreClientSendMock).not.toHaveBeenCalled();
  });

  it("(g) CHAT_SESSION_TABLE_NAME が未設定の場合、500 を返し GetItem/ListEvents を呼び出さない", async () => {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
    process.env.AGENTCORE_MEMORY_ID = "agents_TestMemory-abc123";
    // CHAT_SESSION_TABLE_NAME は beforeEach で削除済み（未設定）

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("cognito-sub-456")}` } }),
      stream as never,
      {} as never
    );

    expect(stream.metadata?.statusCode).toBe(500);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(parsed.error).toContain("CHAT_SESSION_TABLE_NAME");
    expect(dynamoDbClientSendMock).not.toHaveBeenCalled();
    expect(bedrockAgentCoreClientSendMock).not.toHaveBeenCalled();
  });
});

/**
 * actor_id 不一致時の認可ブロック（`handleMemoryRestoreRequest`、
 * memory-based-chat-history タスク 3.2、高感度: 認証経路）のユニットテスト。
 *
 * (a) actor_id 不一致 → 403、ListEvents は一度も呼び出されない
 *     （DynamoDB の GetItem モックが解決した後に ListEvents 呼び出し回数を
 *     確認することで、呼び出し前検証であること — fetch-then-reject でないこと
 *     — を検証する）
 * (b) actor_id 一致 → 既存の正常系（ListEvents を呼び出す）が引き続き動作する
 *     （回帰確認）
 * (c) ChatSession レコードが存在しない（GetItem が Item を返さない）場合も
 *     ブロック/403 として扱い、ListEvents は呼び出されない
 *
 * Requirements: 3.1, 3.2
 */
describe("copilotkitStreamingRelay handler — actor_id 不一致時の認可ブロック（GET /memory/events）", () => {
  function createFakeGetEvent(overrides: Partial<LambdaFunctionURLEvent> = {}): LambdaFunctionURLEvent {
    return createFakeEvent({
      rawPath: "/memory/events",
      rawQueryString: "sessionId=session-123",
      requestContext: {
        domainName: "example.lambda-url.us-west-2.on.aws",
        http: { method: "GET", path: "/memory/events", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
      } as unknown as LambdaFunctionURLEvent["requestContext"],
      ...overrides,
    });
  }

  function setUpConfiguredEnv() {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
    process.env.AGENTCORE_MEMORY_ID = "agents_TestMemory-abc123";
    process.env.CHAT_SESSION_TABLE_NAME = "ChatSession-test-NONE";
  }

  it("(a) actor_id が不一致の場合、403 を返し ListEvents を一度も呼び出さない（呼び出し前検証）", async () => {
    setUpConfiguredEnv();

    // ChatSession レコードの ownerUserId（"owner-actor-id"）が、Bearer トークン
    // から抽出される actorId（"requesting-actor-id"）と異なる。
    dynamoDbClientSendMock = vi.fn(async () => ({
      Item: { ownerUserId: { S: "owner-actor-id" } },
    }));

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("requesting-actor-id")}` } }),
      stream as never,
      {} as never
    );

    // GetItem（ChatSession 所有権確認）は解決済みだが、その後に ListEvents が
    // 一度も呼び出されていないことを確認する（fetch-then-reject ではなく
    // 呼び出し前検証であることの直接的な証拠）。
    expect(dynamoDbClientSendMock).toHaveBeenCalledTimes(1);
    expect(bedrockAgentCoreClientSendMock).not.toHaveBeenCalled();
    expect(listEventsCommandMock).not.toHaveBeenCalled();

    expect(stream.metadata?.statusCode).toBe(403);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error.length).toBeGreaterThan(0);
  });

  it("(b) actor_id が一致する場合、ListEvents を呼び出して正常系のレスポンスを返す（回帰確認）", async () => {
    setUpConfiguredEnv();

    dynamoDbClientSendMock = vi.fn(async () => ({
      Item: { ownerUserId: { S: "matching-actor-id" } },
    }));
    bedrockAgentCoreClientSendMock = vi.fn(async () => ({ events: [], nextToken: undefined }));

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("matching-actor-id")}` } }),
      stream as never,
      {} as never
    );

    expect(dynamoDbClientSendMock).toHaveBeenCalledTimes(1);
    expect(bedrockAgentCoreClientSendMock).toHaveBeenCalledTimes(1);
    expect(stream.metadata?.statusCode).toBe(200);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(parsed.messages).toEqual([]);
  });

  it("(c) ChatSession レコードが存在しない場合、403 を返し ListEvents を呼び出さない", async () => {
    setUpConfiguredEnv();

    // GetItem の結果に Item が含まれない（レコードが存在しない）。
    dynamoDbClientSendMock = vi.fn(async () => ({}));

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("any-actor-id")}` } }),
      stream as never,
      {} as never
    );

    expect(dynamoDbClientSendMock).toHaveBeenCalledTimes(1);
    expect(bedrockAgentCoreClientSendMock).not.toHaveBeenCalled();
    expect(listEventsCommandMock).not.toHaveBeenCalled();

    expect(stream.metadata?.statusCode).toBe(403);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(typeof parsed.error).toBe("string");
  });

  it("(d) ChatSession の GetItem 呼び出し自体が失敗した場合、500 を返し ListEvents を呼び出さない", async () => {
    setUpConfiguredEnv();

    dynamoDbClientSendMock = vi.fn(async () => {
      throw new Error("ProvisionedThroughputExceededException");
    });

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("any-actor-id")}` } }),
      stream as never,
      {} as never
    );

    expect(dynamoDbClientSendMock).toHaveBeenCalledTimes(1);
    expect(bedrockAgentCoreClientSendMock).not.toHaveBeenCalled();

    // ChatSession の所有権確認自体が失敗した場合は、一致しない（403）と
    // 混同せず 500 として扱う（一時的な AWS エラーを認可拒否として
    // 誤報告しないため）。
    expect(stream.metadata?.statusCode).toBe(500);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(typeof parsed.error).toBe("string");
  });
});

/**
 * Blob-payload restore + event ordering stabilization (image-input bugfix).
 *
 * (a) A turn whose serialized JSON exceeds AgentCore Memory's conversational
 *     text limit is stored as a `blob` payload event (not `conversational`).
 *     The restore pipeline must now decode such blob events (mirroring the
 *     Python `events_to_messages` blob branch) instead of silently dropping
 *     them, so a text+image user turn is restored as ONE multimodal message.
 * (b) `eventTimestamp` has 1-second resolution, so same-second events can
 *     reorder across reloads. The secondary sort key `eventId` (lexicographic)
 *     makes ordering deterministic when timestamps are equal.
 */
describe("copilotkitStreamingRelay handler — blob restore + ordering tiebreak (GET /memory/events)", () => {
  function createFakeGetEvent(overrides: Partial<LambdaFunctionURLEvent> = {}): LambdaFunctionURLEvent {
    return createFakeEvent({
      rawPath: "/memory/events",
      rawQueryString: "sessionId=session-123",
      requestContext: {
        domainName: "example.lambda-url.us-west-2.on.aws",
        http: { method: "GET", path: "/memory/events", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
      } as unknown as LambdaFunctionURLEvent["requestContext"],
      ...overrides,
    });
  }

  function setUpConfiguredEnv() {
    process.env.AGENTCORE_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
    process.env.AGENTCORE_MEMORY_ID = "agents_TestMemory-abc123";
    process.env.CHAT_SESSION_TABLE_NAME = "ChatSession-test-NONE";
  }

  // Mirror the Python blob shape: json.dumps(messages[0]) where
  // messages[0] = (json.dumps(session_dict), role). So the blob is a 2-element
  // array [messageJsonStr, role].
  function blobPayloadArray(role: "user" | "assistant", content: unknown[]): [string, string] {
    return [JSON.stringify({ message: { role, content }, message_id: 0 }), role];
  }

  it("(a) restores a text+image user turn stored as an oversized blob event as ONE multimodal message (not dropped)", async () => {
    setUpConfiguredEnv();

    dynamoDbClientSendMock = vi.fn(async () => ({
      Item: { ownerUserId: { S: "cognito-sub-456" } },
    }));

    const B64 = "aGVsbG8="; // "hello"
    bedrockAgentCoreClientSendMock = vi.fn(async () => ({
      events: [
        {
          eventId: "0000001756147154000#img0",
          eventTimestamp: new Date("2024-01-01T00:00:00.000Z"),
          // Oversized turn → stored as blob payload (not conversational).
          payload: [
            {
              blob: blobPayloadArray("user", [
                { text: "この画像を見て" },
                { image: { format: "png", source: { bytes: { __bytes_encoded__: true, data: B64 } } } },
              ]),
            },
          ],
        },
      ],
      nextToken: undefined,
    }));

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("cognito-sub-456")}` } }),
      stream as never,
      {} as never
    );

    expect(stream.metadata?.statusCode).toBe(200);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(parsed.messages).toEqual([
      {
        id: "event-0-user-multimodal",
        role: "user",
        content: [
          { type: "text", text: "この画像を見て" },
          { type: "image", source: { type: "data", value: B64, mimeType: "image/png" } },
        ],
        createdAt: Date.parse("2024-01-01T00:00:00.000Z"),
      },
    ]);
  });

  it("(a') ignores a non-message (agent-state) blob event without dropping surrounding conversational turns", async () => {
    setUpConfiguredEnv();

    dynamoDbClientSendMock = vi.fn(async () => ({
      Item: { ownerUserId: { S: "cognito-sub-456" } },
    }));

    bedrockAgentCoreClientSendMock = vi.fn(async () => ({
      events: [
        {
          eventId: "0000001756147154000#c1",
          eventTimestamp: new Date("2024-01-01T00:00:00.000Z"),
          payload: [
            {
              conversational: {
                role: "USER",
                content: { text: JSON.stringify({ message: { role: "user", content: [{ text: "質問" }] } }) },
              },
            },
          ],
        },
        {
          eventId: "0000001756147154000#s1",
          eventTimestamp: new Date("2024-01-01T00:00:01.000Z"),
          // Agent/session internal state blob (object) → ignored, not a message.
          payload: [{ blob: { agentState: { conversation_manager_state: {} } } }],
        },
      ],
      nextToken: undefined,
    }));

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("cognito-sub-456")}` } }),
      stream as never,
      {} as never
    );

    expect(stream.metadata?.statusCode).toBe(200);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(parsed.messages).toEqual([
      {
        id: "event-0-text-0",
        role: "user",
        content: "質問",
        createdAt: Date.parse("2024-01-01T00:00:00.000Z"),
      },
    ]);
  });

  it("(b) orders same-second events deterministically by eventId (secondary sort key)", async () => {
    setUpConfiguredEnv();

    dynamoDbClientSendMock = vi.fn(async () => ({
      Item: { ownerUserId: { S: "cognito-sub-456" } },
    }));

    // Both events share the SAME eventTimestamp (1-second resolution tie).
    // Returned in reverse eventId order; the eventId tiebreak must reorder them
    // ascending (#aaaa before #bbbb) regardless of return/stable-sort order.
    const conv = (eventId: string, text: string) => ({
      eventId,
      eventTimestamp: new Date("2024-01-01T00:00:00.000Z"),
      payload: [
        {
          conversational: {
            role: "USER",
            content: { text: JSON.stringify({ message: { role: "user", content: [{ text }] } }) },
          },
        },
      ],
    });

    bedrockAgentCoreClientSendMock = vi.fn(async () => ({
      events: [
        conv("0000001756147154000#bbbb", "second"),
        conv("0000001756147154000#aaaa", "first"),
      ],
      nextToken: undefined,
    }));

    const { handler } = await import("./handler");
    const { stream, chunks } = createFakeResponseStream();

    await handler(
      createFakeGetEvent({ headers: { authorization: `Bearer ${fakeJwt("cognito-sub-456")}` } }),
      stream as never,
      {} as never
    );

    expect(stream.metadata?.statusCode).toBe(200);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    expect(parsed.messages).toEqual([
      { id: "event-0-text-0", role: "user", content: "first", createdAt: Date.parse("2024-01-01T00:00:00.000Z") },
      { id: "event-1-text-0", role: "user", content: "second", createdAt: Date.parse("2024-01-01T00:00:00.000Z") },
    ]);
  });
});
