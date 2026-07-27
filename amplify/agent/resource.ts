/**
 * AgentCore Runtime / Memory を Amplify Gen 2 のバックエンドスタックの一部として
 * 定義する。
 *
 * 目的:
 * 以前は AgentCore を AgentCore CLI（`agentcore deploy`）で別途デプロイしていた。
 * その構成では Amplify が生成する RoleConfig テーブル名を CDK 側から知る手段が
 * ないため、`agentcore.json` と CLI 側の CDK スタックに `<APPSYNC_API_ID>` /
 * `<YOUR_AWS_ACCOUNT_ID>` というプレースホルダを手で埋める運用が必要だった。
 * 同一の CDK アプリに載せることで、テーブル名・アカウント ID・Runtime ARN・
 * Memory ID がすべて synth 時に解決でき、これらのプレースホルダと手動の環境変数
 * 設定が不要になった。AgentCore CLI のプロジェクト（`agents/agentcore/`）は削除済み。
 *
 * Docker が不要な理由:
 * AgentCore Runtime の direct code deployment（CodeZip）を使う。コードと依存を
 * zip して S3 に置くだけで、Dockerfile・ECR・ARM コンテナビルドが要らないため、
 * Docker を持たない Amplify Hosting のビルド環境でも成立する。依存は事前に
 * `scripts/build-agent-package.sh` が Linux arm64 向けに展開する（CDK の
 * `s3_assets.Asset` は zip とアップロードのみを行い、依存の解決はしない）。
 *
 * 制約:
 * - direct code deployment のパッケージ上限は 250MB（Container は 2GB）。
 *   ビルドスクリプト側でサイズを検査している。
 * - L2 コンストラクト（`aws-cdk-lib/aws-bedrockagentcore` の `Runtime` /
 *   `AgentRuntimeArtifact`）は aws-cdk-lib 2.262.0 以降で使える。このリポジトリの
 *   インストール済みバージョンでは L1（`CfnRuntime` / `CfnMemory`）のみのため、
 *   ここでは L1 を直接使っている。
 */
import { ArnFormat, Names, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as bedrockagentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `scripts/build-agent-package.sh` が生成するビルド出力のディレクトリ。
 * エージェントのソースと、Linux arm64 向けに展開した依存の両方を含む。
 */
const AGENT_PACKAGE_DIR = fileURLToPath(
  new URL("../../agents/app/AWS_MCP_Agent/.build", import.meta.url)
);

/**
 * エージェントが `sts:AssumeRole` する対象ロールの名前。
 *
 * これらは運用者が手動で作成した既存ロール（この CDK の管理外）で、AgentCore
 * Runtime の実行ロールを Principal として信頼し、それぞれ ReadOnlyAccess /
 * AdministratorAccess 相当を持つ。
 *
 * 以前は AgentCore CLI 側の CDK スタックに
 * `arn:aws:iam::<YOUR_AWS_ACCOUNT_ID>:role/...` というプレースホルダ付きの ARN を
 * 直書きしていたが、Amplify のスタック内であればアカウント ID は
 * `Stack.of(scope).account` で解決できるため、ロール名だけを持てば足りる。
 */
const ASSUMABLE_ROLE_NAMES = ["AgentMCPReadOnlyRole", "AgentMCPAdminRole"];

/** Role_Config のキャッシュ TTL（秒）。`roles/config.py` の既定値と同じ。 */
const ROLE_CONFIG_CACHE_TTL_SECONDS = "30";

export interface AgentCoreResources {
  /** AgentCore Runtime の ARN（`copilotkitStreamingRelay` の SigV4 呼び出し先）。 */
  readonly runtimeArn: string;
  /** AgentCore Memory の ID（会話履歴の `ListEvents` 用）。 */
  readonly memoryId: string;
  /** AgentCore Memory の ARN（IAM ポリシーの Resource 用）。 */
  readonly memoryArn: string;
}

/**
 * リソース名に付ける環境サフィックスを、Amplify のバックエンド識別子から作る。
 *
 * AgentCore の Runtime 名 / Memory 名はアカウント・リージョン単位で一意である
 * 必要があり、sandbox・`develop`・`main` が同一アカウントに共存しうるため、
 * 環境ごとに異なる名前にしないと 2 つ目のデプロイが失敗する。
 *
 * `Names.uniqueId` のハッシュ（例 `ox9b95037cd6`）でも一意性は満たせるが、
 * CloudWatch Logs のロググループ名やコスト分析でどの環境の Runtime なのかが
 * 読み取れない。Amplify は CDK コンテキストにバックエンド識別子を入れている
 * （`@aws-amplify/platform-core` の CDKContextKey）ので、そこから
 * `main_branch` / `alice_sandbox` のような読める名前を作る。
 *
 * 使える文字は英数字とアンダースコアのみ。ハイフン等はアンダースコアに寄せ、
 * Runtime 名の 48 文字制限に収まるよう切り詰める。
 *
 * 注意: このサフィックスが変わると Runtime と Memory は「別のリソース」になり
 * 置き換えが発生する（Memory の置き換えは会話履歴の断絶を意味する）。
 * 命名規則は本番の初回デプロイより前に確定させること。
 */
function environmentSuffix(scope: Construct): string {
  const sanitize = (value: string) => value.replace(/[^A-Za-z0-9]/g, "_");

  const backendName = scope.node.tryGetContext("amplify-backend-name");
  const backendType = scope.node.tryGetContext("amplify-backend-type");

  if (typeof backendName === "string" && backendName && typeof backendType === "string" && backendType) {
    return `${sanitize(backendName)}_${sanitize(backendType)}`.slice(0, 24);
  }

  // コンテキストが無い場合（Amplify 以外からの synth など）は一意性のみを担保する。
  return Names.uniqueId(scope).slice(-12);
}

export interface CreateAgentCoreResourcesProps {
  /**
   * Role_Entry を保持する RoleConfig テーブル（Amplify Data が生成した L2）。
   * Runtime の実行ロールにこのテーブルへの `dynamodb:Scan` のみを許可し、
   * テーブル名を Runtime の環境変数に渡す。
   */
  readonly roleConfigTable: ITable;
}

/**
 * AgentCore Memory と Runtime、および Runtime の実行ロールを作成する。
 *
 * リソース名に環境ごとのサフィックスを付ける理由:
 * AgentCore の Runtime 名・Memory 名はアカウント / リージョン単位で一意である
 * 必要がある。以前は `agentcore.json` に固定名を書いていたので衝突しなかったが、
 * Amplify のスタックに載せると sandbox・`develop`・`main` が同一アカウントに
 * 同時に存在しうるため、スタックごとに異なる名前にしないと 2 つ目のデプロイが
 * 失敗する。`Names.uniqueId` は synth 時に確定する（トークンではない）ため
 * リソース名に使える。
 */
export function createAgentCoreResources(
  scope: Construct,
  props: CreateAgentCoreResourcesProps
): AgentCoreResources {
  const stack = Stack.of(scope);

  if (!existsSync(AGENT_PACKAGE_DIR)) {
    throw new Error(
      [
        `AgentCore のビルド出力が見つかりません: ${AGENT_PACKAGE_DIR}`,
        "AGENT_ENABLED=true でデプロイする前に ./scripts/build-agent-package.sh を実行してください",
        "（Linux arm64 向けの依存を展開したディレクトリを作ります）。",
      ].join("\n")
    );
  }

  const suffix = environmentSuffix(scope);

  // --- AgentCore Memory ---------------------------------------------------
  // 会話の発言本文の唯一の正。actor_id（Cognito sub）と session_id でスコープされる。
  // 保持期間 365 日・長期記憶（SEMANTIC）有効は、以前 agentcore.json の
  // `memories` に定義していた設定をそのまま移したもの。
  // description は ASCII のみにする。IAM は description に
  // `[\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]`（実質 Latin-1）しか許さず、
  // 日本語を入れるとデプロイ時に 400 で失敗する（synth では検出できない）。
  // AgentCore 側は日本語を受け付けたが、リソース間で揃える方が事故が少ない。
  const memory = new bedrockagentcore.CfnMemory(scope, "AwsMcpAgentMemory", {
    name: `AWS_MCP_AgentMemory_${suffix}`,
    description: "Conversation history for the AWS MCP agent (source of truth)",
    eventExpiryDuration: 365,
    memoryStrategies: [
      {
        semanticMemoryStrategy: {
          name: "semantic_facts",
        },
      },
    ],
  });

  // Memory は会話履歴（発言本文の唯一の正）を保持するため、スタックの削除・
  // ロールバックで消さない。
  //
  // RETAIN を選ぶ理由:
  // - Amplify アプリを削除したときに会話履歴が失われるのは取り返しがつかない。
  //   Runtime はコードから作り直せるが、Memory の中身は作り直せない。
  // - Memory の作成には数分かかる。同じスタック内の他のリソースが先に失敗すると
  //   ロールバックが始まるが、`CREATING` 中の Memory は削除できないため
  //   `ROLLBACK_FAILED` でスタックが詰まる（実際に踏んだ）。RETAIN なら削除を
  //   試みないのでこの詰まりも起きない。
  //
  // 代償: 初回作成が失敗した場合、Memory が孤児として残る。同じ名前で再作成
  // しようとすると衝突するため、再試行の前に孤児を手動で削除する必要がある
  // （`aws bedrock-agentcore-control list-memories` で確認して delete-memory）。
  // 起こるのは初回作成時のみで、エラーメッセージも明確なため、履歴消失のリスクと
  // 引き換えにこちらを受け入れる。
  memory.applyRemovalPolicy(RemovalPolicy.RETAIN);

  // --- Runtime の実行ロール ------------------------------------------------
  // 信頼ポリシーは AgentCore Runtime のドキュメントに従い、SourceAccount /
  // SourceArn による confused deputy 対策の条件を付ける。
  const runtimeName = `AWS_MCP_Agent_${suffix}`;
  const executionRole = new iam.Role(scope, "AwsMcpAgentRuntimeRole", {
    assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
      conditions: {
        StringEquals: { "aws:SourceAccount": stack.account },
        ArnLike: {
          "aws:SourceArn": stack.formatArn({
            service: "bedrock-agentcore",
            resource: "*",
          }),
        },
      },
    }),
    // ASCII のみ（上記 CfnMemory のコメント参照）。
    description: `Execution role for AgentCore Runtime ${runtimeName}`,
  });

  // CloudWatch Logs / X-Ray / メトリクス（direct deploy 実行ロールの標準セット）。
  // ECR 系の権限は CodeZip では不要なので付与しない（Container ビルド用）。
  // CloudWatch Logs の ARN は `log-group:<名前>` のようにコロン区切りなので、
  // `formatArn` の既定（スラッシュ区切り）ではなく COLON_RESOURCE_NAME を指定する
  // （既定のままだと `log-group//aws/...` という二重スラッシュの ARN になり、
  // ポリシーが実際のロググループに一致しない）。
  const logGroupArn = (resourceName: string) =>
    stack.formatArn({
      service: "logs",
      resource: "log-group",
      resourceName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

  executionRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["logs:CreateLogGroup", "logs:DescribeLogStreams"],
      resources: [logGroupArn("/aws/bedrock-agentcore/runtimes/*")],
    })
  );
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [logGroupArn("/aws/bedrock-agentcore/runtimes/*:log-stream:*")],
    })
  );
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["logs:DescribeLogGroups"],
      resources: [logGroupArn("*")],
    })
  );
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      actions: [
        "xray:PutTraceSegments",
        "xray:PutTelemetryRecords",
        "xray:GetSamplingRules",
        "xray:GetSamplingTargets",
      ],
      resources: ["*"],
    })
  );
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["cloudwatch:PutMetricData"],
      resources: ["*"],
      conditions: { StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } },
    })
  );

  // モデル呼び出し（Strands Agent が Bedrock のモデルを呼ぶ）。
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [
        `arn:${stack.partition}:bedrock:*::foundation-model/*`,
        stack.formatArn({ service: "bedrock", resource: "*" }),
      ],
    })
  );

  // Memory への読み書き（会話イベントの記録と復元）。Resource を自分の Memory に
  // 限定できるのが統合の利点で、従来は Memory ID が synth 時に分からなかった。
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      actions: [
        "bedrock-agentcore:CreateEvent",
        "bedrock-agentcore:ListEvents",
        "bedrock-agentcore:GetEvent",
        "bedrock-agentcore:RetrieveMemoryRecords",
      ],
      resources: [memory.attrMemoryArn, `${memory.attrMemoryArn}/*`],
    })
  );

  // 高感度（IAM）: ロール切り替えの中核。運用者が用意した読み取り専用 /
  // 管理者ロールの引き受けのみを許可する。アカウント ID は Stack から解決するため
  // プレースホルダが不要になった。
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: ASSUMABLE_ROLE_NAMES.map((roleName) =>
        stack.formatArn({
          service: "iam",
          region: "",
          resource: "role",
          resourceName: roleName,
        })
      ),
    })
  );

  // Role_Entry の読み取り。従来は `<APPSYNC_API_ID>` を含むテーブル ARN を手で
  // 書いていた箇所で、ここではテーブルの L2 から ARN が解決される。
  //
  // `grantReadData` ではなく明示的な PolicyStatement を使う理由:
  // `grantReadData` は GetItem / Query / BatchGetItem / DescribeTable、および
  // ストリームの GetRecords まで含むが、エージェントは Role_Entry 一覧を
  // `Scan` するだけであり、以前の AgentCore CLI 側の CDK スタックも
  // `dynamodb:Scan` のみを許可している。統合によって権限が広がらないように
  // アクションを揃える。
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["dynamodb:Scan"],
      resources: [props.roleConfigTable.tableArn],
    })
  );

  // --- Runtime -------------------------------------------------------------
  // ビルド出力のディレクトリを zip して CDK 管理の S3 バケットにアップロードする。
  // Docker を使う CDK の bundling オプションは使わない（Amplify のビルド環境に
  // Docker がないため）。依存の展開はビルドスクリプトの責務。
  const codeAsset = new s3assets.Asset(scope, "AwsMcpAgentCode", {
    path: AGENT_PACKAGE_DIR,
  });
  codeAsset.grantRead(executionRole);

  const runtime = new bedrockagentcore.CfnRuntime(scope, "AwsMcpAgentRuntime", {
    agentRuntimeName: runtimeName,
    description: "AWS MCP agent (AG-UI / Strands Agents)",
    roleArn: executionRole.roleArn,
    agentRuntimeArtifact: {
      codeConfiguration: {
        code: {
          s3: {
            bucket: codeAsset.s3BucketName,
            prefix: codeAsset.s3ObjectKey,
          },
        },
        // EntryPoint は最大 2 要素。Container ビルドの CMD
        // （`opentelemetry-instrument python -m main`）に相当する CodeZip 版。
        entryPoint: ["opentelemetry-instrument", "main.py"],
        runtime: "PYTHON_3_13",
      },
    },
    networkConfiguration: { networkMode: "PUBLIC" },
    protocolConfiguration: "AGUI",
    requestHeaderConfiguration: {
      requestHeaderAllowlist: [
        "X-Role-Names",
        "X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId",
      ],
    },
    environmentVariables: {
      // 以前 agentcore.json に `RoleConfig-<APPSYNC_API_ID>-NONE` と書いていた値。
      // 同一スタック内なので実テーブル名がデプロイ時に解決される。
      ROLE_CONFIG_TABLE_NAME: props.roleConfigTable.tableName,
      ROLE_CONFIG_CACHE_TTL_SECONDS,
    },
  });

  return {
    runtimeArn: runtime.attrAgentRuntimeArn,
    memoryId: memory.attrMemoryId,
    memoryArn: memory.attrMemoryArn,
  };
}
