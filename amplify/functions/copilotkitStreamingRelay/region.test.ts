/**
 * `relay.ts` のリージョン解決に対するユニットテスト。
 *
 * 以前は `export const REGION = "us-west-2"` をハードコードしており、
 * Amplify アプリを別リージョンにデプロイすると、
 * - AgentCore への SigV4 署名リージョンが送信先ホストと食い違って
 *   `SignatureDoesNotMatch` になる
 * - DynamoDB / AgentCore Memory の SDK クライアントが存在しないリージョンを向く
 * という2つの壊れ方をした。
 *
 * `REGION` はモジュールスコープで `AWS_REGION` を読むため、各テストで
 * `vi.resetModules()` + 動的 import を使って読み込み時の環境を作り分ける。
 *
 * 高感度（認証経路）: 署名リージョンは送信先ホストと一致していなければ
 * ならない。`resolveSigningRegion` はその一致を保証する箇所なので、
 * ホスト名からの導出とフォールバックの契約をここで固定する。
 */

beforeEach(() => {
  vi.resetModules();
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
});

describe("relay.ts — REGION", () => {
  it("AWS_REGION を読む（Lambda 実行環境が必ず設定する値）", async () => {
    process.env.AWS_REGION = "ap-northeast-1";

    const { REGION } = await import("./relay");

    expect(REGION).toBe("ap-northeast-1");
  });

  it("AWS_REGION が無い場合は AWS_DEFAULT_REGION にフォールバックする", async () => {
    process.env.AWS_DEFAULT_REGION = "eu-central-1";

    const { REGION } = await import("./relay");

    expect(REGION).toBe("eu-central-1");
  });

  it("どちらも無い場合は undefined（SDK 既定のリージョン解決に委ねる）", async () => {
    const { REGION } = await import("./relay");

    expect(REGION).toBeUndefined();
  });

  it("特定のリージョンをハードコードしていない", async () => {
    process.env.AWS_REGION = "ap-northeast-1";

    const { REGION } = await import("./relay");

    expect(REGION).not.toBe("us-west-2");
  });
});

describe("relay.ts — buildInvocationUrl", () => {
  it("Runtime ARN のリージョンをエンドポイントホストに使う", async () => {
    process.env.AWS_REGION = "ap-northeast-1";
    const { buildInvocationUrl } = await import("./relay");

    const url = buildInvocationUrl(
      "arn:aws:bedrock-agentcore:ap-northeast-1:123456789012:runtime/AWS_MCP_Agent_main_branch-abc123"
    );

    expect(new URL(url).hostname).toBe("bedrock-agentcore.ap-northeast-1.amazonaws.com");
  });

  it("Lambda のリージョンと ARN のリージョンが違う場合は ARN 側を優先する", async () => {
    process.env.AWS_REGION = "ap-northeast-1";
    const { buildInvocationUrl } = await import("./relay");

    const url = buildInvocationUrl(
      "arn:aws:bedrock-agentcore:eu-central-1:123456789012:runtime/AWS_MCP_Agent_main_branch-abc123"
    );

    expect(new URL(url).hostname).toBe("bedrock-agentcore.eu-central-1.amazonaws.com");
  });

  it("ARN にリージョンが無い場合は Lambda 自身のリージョンにフォールバックする", async () => {
    process.env.AWS_REGION = "eu-west-1";
    const { buildInvocationUrl } = await import("./relay");

    const url = buildInvocationUrl("arn:aws:bedrock-agentcore::123456789012:runtime/test-abc123");

    expect(new URL(url).hostname).toBe("bedrock-agentcore.eu-west-1.amazonaws.com");
  });

  it("リージョンをどこからも解決できない場合は例外を投げる（不正なホストで送信しない）", async () => {
    const { buildInvocationUrl } = await import("./relay");

    expect(() =>
      buildInvocationUrl("arn:aws:bedrock-agentcore::123456789012:runtime/test-abc123")
    ).toThrow(/Cannot resolve region/);
  });

  it("qualifier と ARN のエンコードは従来どおり", async () => {
    process.env.AWS_REGION = "us-west-2";
    const { buildInvocationUrl } = await import("./relay");

    const arn = "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/test-abc123";
    const url = new URL(buildInvocationUrl(arn));

    expect(url.pathname).toBe(`/runtimes/${encodeURIComponent(arn)}/invocations`);
    expect(url.searchParams.get("qualifier")).toBe("DEFAULT");
  });
});

describe("relay.ts — resolveSigningRegion", () => {
  it("AgentCore のホスト名からリージョンを取り出す", async () => {
    process.env.AWS_REGION = "us-west-2";
    const { resolveSigningRegion } = await import("./relay");

    expect(resolveSigningRegion("bedrock-agentcore.ap-northeast-1.amazonaws.com")).toBe(
      "ap-northeast-1"
    );
  });

  it("buildInvocationUrl が作ったホストと必ず一致する（署名リージョンの食い違いを防ぐ）", async () => {
    process.env.AWS_REGION = "us-west-2";
    const { buildInvocationUrl, resolveSigningRegion } = await import("./relay");

    for (const region of ["us-east-1", "us-west-2", "ap-northeast-1", "eu-central-1"]) {
      const url = new URL(
        buildInvocationUrl(`arn:aws:bedrock-agentcore:${region}:123456789012:runtime/test-abc123`)
      );
      expect(resolveSigningRegion(url.hostname)).toBe(region);
    }
  });

  it("想定外のホスト形式では Lambda 自身のリージョンを返す", async () => {
    process.env.AWS_REGION = "eu-west-1";
    const { resolveSigningRegion } = await import("./relay");

    expect(resolveSigningRegion("example.com")).toBe("eu-west-1");
  });

  it("想定外のホストで AWS_REGION も無い場合は undefined を返す", async () => {
    const { resolveSigningRegion } = await import("./relay");

    expect(resolveSigningRegion("example.com")).toBeUndefined();
  });
});
