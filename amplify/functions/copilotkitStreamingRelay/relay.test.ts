import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `relay.ts` の `extractCognitoSub` に対するユニットテスト
 * （高感度セキュリティ修正: Cognito JWT の署名検証を追加）。
 *
 * 修正前は base64url デコードのみで `sub` クレームを読んでおり、署名検証を
 * 一切行っていなかった（Lambda 関数 URL の認証タイプが `NONE` であるため、
 * 偽造トークンで任意の `sub` を主張できる脆弱性だった）。このテストは
 * `aws-jwt-verify` の `CognitoJwtVerifier` をモックし、実際の Cognito JWKS
 * エンドポイントへのネットワークアクセスなしに、署名検証ロジックの契約
 * （常に `Promise<string | null>` を返し、例外を投げない）を検証する。
 *
 * 検証する契約:
 * - 有効な署名 + 一致する userPoolId/clientId → 検証済みの sub を返す
 * - 無効な署名（検証が reject する）→ null
 * - 期限切れトークン（検証が reject する）→ null
 * - token_use 不一致（例: access を期待して id トークンが来た）→ null
 * - COGNITO_USER_POOL_ID 未設定 → 任意の入力に対して null（フェイルクローズ）
 * - 3セグメントでない文字列（JWT の形をしていない）→ null（署名検証すら行わない）
 *
 * Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4
 */

let cognitoJwtVerifierVerifyMock: ReturnType<typeof vi.fn> = vi.fn();
const cognitoJwtVerifierCreateMock = vi.fn(() => ({
  verify: (...args: unknown[]) => cognitoJwtVerifierVerifyMock(...args),
}));

vi.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: {
    create: (...args: unknown[]) => cognitoJwtVerifierCreateMock(...args),
  },
}));

function base64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function fakeJwt(sub: string): string {
  return `${base64url({ alg: "RS256" })}.${base64url({ sub })}.fake-signature`;
}

beforeEach(() => {
  vi.resetModules();
  cognitoJwtVerifierCreateMock.mockClear();
  cognitoJwtVerifierVerifyMock = vi.fn();
  delete process.env.COGNITO_USER_POOL_ID;
  delete process.env.COGNITO_USER_POOL_CLIENT_ID;
});

describe("relay.ts — extractCognitoSub（Cognito JWT 署名検証）", () => {
  it("有効な署名 + 一致する userPoolId/clientId の場合、検証済みの sub を返す", async () => {
    process.env.COGNITO_USER_POOL_ID = "us-west-2_testpool";
    process.env.COGNITO_USER_POOL_CLIENT_ID = "test-client-id";
    cognitoJwtVerifierVerifyMock = vi.fn(async () => ({ sub: "verified-sub-123", token_use: "access" }));

    const { extractCognitoSub } = await import("./relay");
    const result = await extractCognitoSub(fakeJwt("verified-sub-123"));

    expect(result).toBe("verified-sub-123");
    expect(cognitoJwtVerifierCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userPoolId: "us-west-2_testpool",
        tokenUse: "access",
        clientId: "test-client-id",
      })
    );
  });

  it("署名検証が失敗する（無効な署名）場合、null を返し例外を投げない", async () => {
    process.env.COGNITO_USER_POOL_ID = "us-west-2_testpool";
    process.env.COGNITO_USER_POOL_CLIENT_ID = "test-client-id";
    cognitoJwtVerifierVerifyMock = vi.fn(async () => {
      throw new Error("JwtInvalidSignatureError");
    });

    const { extractCognitoSub } = await import("./relay");
    const result = await extractCognitoSub(fakeJwt("forged-sub"));

    expect(result).toBeNull();
  });

  it("期限切れトークンの場合、null を返す", async () => {
    process.env.COGNITO_USER_POOL_ID = "us-west-2_testpool";
    process.env.COGNITO_USER_POOL_CLIENT_ID = "test-client-id";
    cognitoJwtVerifierVerifyMock = vi.fn(async () => {
      throw new Error("JwtExpiredError");
    });

    const { extractCognitoSub } = await import("./relay");
    const result = await extractCognitoSub(fakeJwt("expired-sub"));

    expect(result).toBeNull();
  });

  it("token_use 不一致（ID トークンが access として検証される等）の場合、null を返す", async () => {
    process.env.COGNITO_USER_POOL_ID = "us-west-2_testpool";
    process.env.COGNITO_USER_POOL_CLIENT_ID = "test-client-id";
    cognitoJwtVerifierVerifyMock = vi.fn(async () => {
      throw new Error("CognitoJwtInvalidTokenUseError");
    });

    const { extractCognitoSub } = await import("./relay");
    const result = await extractCognitoSub(fakeJwt("id-token-sub"));

    expect(result).toBeNull();
  });

  it("COGNITO_USER_POOL_ID が未設定の場合、フェイルクローズで任意の入力に対して null を返す（検証すら行わない）", async () => {
    // COGNITO_USER_POOL_ID は beforeEach で削除済み（未設定）

    const { extractCognitoSub } = await import("./relay");
    const result = await extractCognitoSub(fakeJwt("any-sub"));

    expect(result).toBeNull();
    expect(cognitoJwtVerifierCreateMock).not.toHaveBeenCalled();
    expect(cognitoJwtVerifierVerifyMock).not.toHaveBeenCalled();
  });

  it("3セグメントでない文字列（JWT の形をしていない）の場合、署名検証を呼び出さずに null を返す", async () => {
    process.env.COGNITO_USER_POOL_ID = "us-west-2_testpool";

    const { extractCognitoSub } = await import("./relay");
    const result = await extractCognitoSub("not-a-jwt");

    expect(result).toBeNull();
    expect(cognitoJwtVerifierVerifyMock).not.toHaveBeenCalled();
  });

  it("検証済み payload に sub クレームがない場合、null を返す", async () => {
    process.env.COGNITO_USER_POOL_ID = "us-west-2_testpool";
    cognitoJwtVerifierVerifyMock = vi.fn(async () => ({ token_use: "access" }));

    const { extractCognitoSub } = await import("./relay");
    const result = await extractCognitoSub(fakeJwt("irrelevant"));

    expect(result).toBeNull();
  });

  it("COGNITO_USER_POOL_CLIENT_ID が未設定でも、userPoolId のみで verifier を作成する（clientId は null で検証をスキップ）", async () => {
    process.env.COGNITO_USER_POOL_ID = "us-west-2_testpool";
    // COGNITO_USER_POOL_CLIENT_ID は未設定（beforeEach で削除済み）
    cognitoJwtVerifierVerifyMock = vi.fn(async () => ({ sub: "sub-without-client-check" }));

    const { extractCognitoSub } = await import("./relay");
    const result = await extractCognitoSub(fakeJwt("sub-without-client-check"));

    expect(result).toBe("sub-without-client-check");
    expect(cognitoJwtVerifierCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: null })
    );
  });
});
