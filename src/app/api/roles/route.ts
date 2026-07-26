import { NextRequest } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { extractBearerToken } from "@/src/lib/agent/authGate";
import { toRoleInfoList } from "@/src/lib/agent/roleInfo";

/**
 * ロール一覧 API Route
 *
 * `RoleConfig` テーブル（Amplify Gen 2 Data_Model、DynamoDB）を直接 `Scan` し、
 * 認証済みユーザーに利用可能な Role_Entry 一覧を返す。`roleArn` はフロントエンドに
 * 公開しない（情報最小化 / Requirements 1.6）。`isActive = true` のレコードのみを
 * 返す（論理削除済みエントリの除外 / Requirements 1.8）。
 *
 * `RoleInfo` 型と `toRoleInfoList` は `@/src/lib/agent/roleInfo` に定義されている。
 * Next.js の Route Handler は HTTP メソッド名（GET 等）以外の named export を
 * 許可しないため、このファイルではそれら以外の export を行わない。
 *
 * Requirements: 1.6, 1.7, 1.8
 */

const ENV_VAR_ROLE_CONFIG_TABLE_NAME = "ROLE_CONFIG_TABLE_NAME";

const dynamoDbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoDbClient);

export async function GET(req: NextRequest): Promise<Response> {
  // ─── 認証ゲート（401）────────────────────────────────────
  // 有効な Bearer トークンがない場合は即 401。
  // Requirements: 1.6
  const authHeader = req.headers.get("authorization");
  if (!extractBearerToken(authHeader)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ─── Role_Config_Table の Scan（サーバーサイドのみ）────────
  // roleArn は API レスポンスに一切含めない（Requirements 1.6）。
  // isActive = false（論理削除済み）のレコードは選択候補として
  // 一切返さない（Requirements 1.8）。
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: process.env[ENV_VAR_ROLE_CONFIG_TABLE_NAME],
        // "name" と "scope" はいずれも DynamoDB の予約語のため、
        // ExpressionAttributeNames でエイリアスする必要がある
        // （エイリアスしない場合 ValidationException: reserved keyword になる）。
        ProjectionExpression: "#n, displayName, accountLabel, #s",
        FilterExpression: "isActive = :true",
        ExpressionAttributeNames: { "#n": "name", "#s": "scope" },
        ExpressionAttributeValues: { ":true": true },
      }),
    );
    const roles = toRoleInfoList(result.Items ?? []);
    return Response.json({ roles });
  } catch (err) {
    // DynamoDB 読み取り失敗時は空配列を返す（Requirements 1.7 と同様の
    // フォールバック方針。フロントエンドは空リストとして扱い、
    // Role_Set_Selector を開かずエラー表示する）
    console.error("[roles] scan_failed:", err);
    return Response.json({ roles: [] });
  }
}
