/**
 * Property-based tests for the actor_id authorization pre-check
 * (memoryRestoreAuthorization / handleMemoryRestoreRequest)
 *
 * **Validates: Requirements 3.2**
 *
 * Property 5: actor_id が一致しない場合、Memory 取得呼び出し自体が発生しない
 * - 任意の、認証済みユーザーの actor_id と選択された Chat_Session の実際の
 *   actor_id が異なる組み合わせに対して、Memory 読み出しハンドラーは基盤となる
 *   AgentCore_Memory の ListEvents 呼び出しを一度も発行せず、呼び出し前に
 *   処理を拒否する。
 *
 * このテストは2つのレイヤーで Property 5 を検証する:
 * (1) `isSessionOwnedByActor`（純粋関数）が、actor_id が異なる任意の組み合わせに
 *     対して常に `false` を返すこと（許可条件が満たされないこと）を検証する。
 * (2) `handleMemoryRestoreRequest`（`handler.ts` の実際のハンドラー分岐）を、
 *     ListEvents 相当の呼び出し（`bedrock-agentcore:ListEvents`）をモック化した
 *     状態で actor_id が異なる任意の組み合わせに対して呼び出し、モックの呼び出し
 *     回数が常に0であることを検証する（handler.test.ts に実装したモック化の
 *     方式と同様のアプローチ）。
 *
 * Tag: Feature: memory-based-chat-history, Property 5: actor_id が一致しない場合、Memory 取得呼び出し自体が発生しない
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fc from "fast-check";
import { isSessionOwnedByActor } from "./memoryRestoreAuthorization";

// --- Generators ---

/** Cognito sub 相当の actor_id 文字列（空文字は許可条件の判定対象外にするため除外する） */
const actorIdArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 40 });

/** actor_id が確実に異なる2値の組を生成する（sessionOwnerUserId, actorId の順） */
const distinctActorIdPairArb: fc.Arbitrary<[string, string]> = fc
  .tuple(actorIdArb, actorIdArb)
  .filter(([a, b]) => a !== b);

// --- Property 5（純粋関数レイヤー）: isSessionOwnedByActor ---

describe("Property 5: actor_id が一致しない場合、Memory 取得呼び出し自体が発生しない（純粋関数レイヤー）", () => {
  it("(1) sessionOwnerUserId と actorId が異なる場合、isSessionOwnedByActor は常に false を返す", () => {
    fc.assert(
      fc.property(distinctActorIdPairArb, ([sessionOwnerUserId, actorId]) => {
        expect(isSessionOwnedByActor(sessionOwnerUserId, actorId)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("(2) sessionOwnerUserId が null（Chat_Session が存在しない）場合、isSessionOwnedByActor は常に false を返す", () => {
    fc.assert(
      fc.property(actorIdArb, (actorId) => {
        expect(isSessionOwnedByActor(null, actorId)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("(3) sessionOwnerUserId と actorId が一致する場合のみ isSessionOwnedByActor は true を返す（対照確認）", () => {
    fc.assert(
      fc.property(actorIdArb, (actorId) => {
        expect(isSessionOwnedByActor(actorId, actorId)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});

// --- Property 5（ハンドラー統合レイヤー）: handleMemoryRestoreRequest ---
//
// handler.ts は `awslambda`（Lambda ランタイム注入グローバル）・
// `@aws-sdk/client-bedrock-agentcore`・`@aws-sdk/client-dynamodb`・
// `@copilotkit/runtime`・`@ag-ui/client` に依存するため、handler.test.ts と
// 同様のモック化方式を用いる。

let bedrockAgentCoreClientSendMock: ReturnType<typeof vi.fn> = vi.fn();
const listEventsCommandMock = vi.fn((input: unknown) => ({ input }));

vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => bedrockAgentCoreClientSendMock(...args),
  })),
  ListEventsCommand: listEventsCommandMock,
}));

let dynamoDbClientSendMock: ReturnType<typeof vi.fn> = vi.fn();
const getItemCommandMock = vi.fn((input: unknown) => ({ input }));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => dynamoDbClientSendMock(...args),
  })),
  GetItemCommand: getItemCommandMock,
}));

vi.mock("@copilotkit/runtime", () => ({
  CopilotRuntime: vi.fn().mockImplementation(function (this: Record<string, unknown>, opts: unknown) {
    this.opts = opts;
  }),
  ExperimentalEmptyAdapter: vi.fn().mockImplementation(() => ({})),
  copilotRuntimeNodeHttpEndpoint: vi.fn(() => () => Promise.resolve(new Response(null, { status: 200 }))),
}));

vi.mock("@ag-ui/client", () => ({
  HttpAgent: vi.fn().mockImplementation((opts: unknown) => ({ opts })),
}));

// Cognito JWT の署名検証（`extractCognitoSub`、高感度セキュリティ修正）を
// モック化する。このテストは actor_id の一致/不一致の認可ロジック（Property 5）
// を検証するものであり、署名検証自体は対象外のため、`fakeJwt(sub)` の
// payload から sub を取り出して「検証成功」として返す（handler.test.ts と
// 同じモック方式）。
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
  bedrockAgentCoreClientSendMock = vi.fn();
  listEventsCommandMock.mockClear();
  dynamoDbClientSendMock = vi.fn();
  getItemCommandMock.mockClear();
  process.env.AGENTCORE_RUNTIME_ARN =
    "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-runtime-abc123";
  process.env.AGENTCORE_MEMORY_ID = "agents_TestMemory-abc123";
  process.env.CHAT_SESSION_TABLE_NAME = "ChatSession-test-NONE";
  process.env.COGNITO_USER_POOL_ID = "us-west-2_testpool";
  process.env.COGNITO_USER_POOL_CLIENT_ID = "test-client-id";
  cognitoJwtVerifierVerifyMock = vi.fn(async (jwt: string) => {
    const parts = jwt.split(".");
    if (parts.length !== 3) throw new Error("invalid jwt shape");
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  });
});

function createFakeResponseStream() {
  const chunks: Buffer[] = [];
  const stream: {
    write: (chunk: string | Buffer) => boolean;
    end: () => void;
    metadata?: { statusCode: number; headers: Record<string, string> };
  } = {
    write: (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      return true;
    },
    end: () => {},
  };
  return { stream, chunks };
}

function base64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function fakeJwt(sub: string): string {
  return `${base64url({ alg: "none" })}.${base64url({ sub })}.signature`;
}

describe("Property 5: actor_id が一致しない場合、Memory 取得呼び出し自体が発生しない（ハンドラー統合レイヤー）", () => {
  it("actor_id が異なる任意の組み合わせに対して、handleMemoryRestoreRequest は ListEvents を一度も呼び出さない", async () => {
    await fc.assert(
      fc.asyncProperty(distinctActorIdPairArb, async ([sessionOwnerUserId, requestingActorId]) => {
        vi.resetModules();
        bedrockAgentCoreClientSendMock = vi.fn();
        dynamoDbClientSendMock = vi.fn(async () => ({
          Item: { ownerUserId: { S: sessionOwnerUserId } },
        }));

        const { handleMemoryRestoreRequest } = await import("./handler");
        const { stream, chunks } = createFakeResponseStream();

        const request = new Request(
          `https://example.lambda-url.us-west-2.on.aws/memory/events?sessionId=session-123`,
          { headers: { authorization: `Bearer ${fakeJwt(requestingActorId)}` } }
        );

        await handleMemoryRestoreRequest(request, stream as never);

        // ListEvents 相当の呼び出しが一度も発行されていないこと（呼び出し前拒否）
        expect(bedrockAgentCoreClientSendMock).not.toHaveBeenCalled();
        expect(stream.metadata?.statusCode).toBe(403);
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        expect(typeof parsed.error).toBe("string");
      }),
      { numRuns: 100 }
    );
  });
});
