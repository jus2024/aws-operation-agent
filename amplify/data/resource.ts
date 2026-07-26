import { type ClientSchema, a, defineData } from "@aws-amplify/backend";

/**
 * データモデル定義
 *
 * 参考: https://docs.amplify.aws/nextjs/build-a-backend/data/
 */
const schema = a.schema({
  // ChatSession.operationScope の必須化のため、トップレベル enum として定義し
  // a.ref("OperationScope").required() で参照する
  // （a.enum() をモデルフィールドにインライン指定した場合は required() を
  //   呼び出せない仕様のため。enum 値は変更なし）
  OperationScope: a.enum(["readonly", "readwrite", "admin"]),

  // ============================================================
  // サンプルモデル（テンプレート参考用に残置）
  // 注意: defaultAuthorizationMode を apiKey → userPool に変更したため、
  // このモデルは apiKey では動作しなくなります。
  // フロントエンドの認証必須化が前提です。
  // ============================================================
  Todo: a
    .model({
      content: a.string(),
      isDone: a.boolean().default(false),
    })
    .authorization((allow) => [allow.authenticated()]),

  // ============================================================
  // チャットセッション（ユーザー所有）
  // owner ベース認可: 所有者のみ CRUD 可能
  // Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
  //
  // [破壊的スキーマ変更] Direct Role Switching 全面改定（Connection カタログ廃止）
  // - `connectionId` を削除し、`roleName` を新規必須フィールドとして追加した
  //   （BeforeToolCallEvent フックが直接 STS AssumeRole を呼び出す際に使用するロール名。
  //   ロール定義自体はアプリケーション設定（AGENT_ROLES 環境変数）側で管理し、
  //   DynamoDB の Connection モデルは完全撤去した）
  // - `endedAt` は既に削除済み（「セッション終了」機能が存在せず、一度も書き込まれない
  //   死んだフィールドだったため）
  // - Migration Plan: sandbox 環境は `amplify sandbox delete` を実行し、sandbox を
  //   再作成する。本番環境は既存 ChatSession レコードの手動データ移行（roleName の
  //   後付け入力）、または再登録のいずれかを運用者が選択する
  //
  // [破壊的スキーマ変更] Role Set Switching（複数ロール選択への一般化）
  // - `roleName: string`（単数・必須）を `roleNames: string[]`（配列・必須）に置換した。
  //   セッション開始時に選択した複数の Role_Entry（Role_Set）の Role_Name をまとめて
  //   1つの配列として保存する。この配列はセッション作成後は不変（Requirement 3.2）
  // - `operationScope` フィールドを削除した。スコープ強制はセッション単位の単一値ではなく、
  //   ツール呼び出しごとに選ばれた個別の Role_Entry が持つ Operation_Scope
  //   （新規 RoleConfig モデルの `scope`）に基づいて判定するようになったため、
  //   セッション単位の scope フィールド自体が意味を失った
  // - Migration Plan: sandbox 環境は `amplify sandbox delete` を実行し、sandbox を
  //   再作成する。本番環境は、既存 ChatSession レコードの `roleName` を
  //   `roleNames: [roleName]` へ変換する手動データ移行、または既存セッションを破棄して
  //   再登録するかのいずれかを運用者が選択する（`operationScope` はいずれの場合も
  //   単純に読み捨てる）
  // ============================================================
  ChatSession: a
    .model({
      ownerUserId: a.string().required(),
      roleNames: a.string().array().required(),
      sessionName: a.string().required(),
      startedAt: a.datetime(),
      updatedAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index("ownerUserId")
        .sortKeys(["updatedAt"])
        .queryField("listChatSessionByOwnerUpdatedAt"),
    ])
    .authorization((allow) => [allow.owner()]),

  // ============================================================
  // RoleConfig（新規）: Role_Config_Table
  // セッションで選択可能な Role_Entry（AWS ロール定義）を DynamoDB に永続化する。
  // これまで `AGENT_ROLES` 環境変数（Agent 起動時に一度だけ JSON パース）で管理していた
  // ロール定義を、この Data Model に移行する。Role_Entry の追加・変更・削除は、
  // このモデルの CRUD 経由で行い、Agent の再デプロイを必要としない
  // （Requirements: 1.1, 8.3, 8.4, 8.6）。
  //
  // 認可: allow.group("ADMINS") のみ。allow.authenticated() は付与しない。
  // 一般ユーザー向けのロール一覧取得（チャット用）はこのモデルの GraphQL API を
  // 経由せず、`/api/roles` Route Handler が DynamoDB を直接 Scan する別経路を使う
  // （roleArn を常に除外し、isActive=true のレコードのみ返す）。この分離により、
  // roleArn が非管理者に渡る経路は設計上存在しない。
  //
  // isActive による論理削除:
  // Role_Entry の削除は isActive を false に設定するのみであり、レコード自体は
  // Role_Config_Table から除去しない（論理削除）。これは、Role_Config_Table の
  // 主キーが id（UUID）であり name ではないため、物理削除+同名での再作成を許すと
  // 過去セッション復元時の文字列照合（roleNames とのマッチング）が誤って別の
  // Role_Entry に紐付いてしまう危険があるためである。isActive を false から true に
  // 戻す（再アクティブ化する）操作は提供しない。name の一意性チェックは isActive の
  // 値に関わらず全レコードを対象に行う（Requirements: 1.8, 8.6, 8.8）。
  // ============================================================
  RoleConfig: a
    .model({
      name: a.string().required(),
      displayName: a.string().required(),
      accountLabel: a.string().required(),
      roleArn: a.string().required(),
      scope: a.ref("OperationScope").required(),
      isActive: a.boolean().required().default(true),
    })
    .authorization((allow) => [allow.group("ADMINS")]),

  // ============================================================
  // MessageFeedback（新規）: アシスタントメッセージへの Good/Bad 評価
  // 1 件のアシスタントメッセージ（Message_Id）に対して 1 ユーザーが付与する
  // 評価メタデータを永続化する。発言内容そのもの（正データソースは AgentCore
  // Memory）ではなく、評価と任意コメントのみを保存する。
  // Requirements: 4.1, 4.2, 4.3, 4.4, 8.5
  //
  // フィールド（Req 4.1）:
  // - ownerUserId: レコード所有者の識別子（Cognito sub、owner claim と一致）
  // - chatSessionId: 紐づく Chat_Session の識別子
  // - messageId: AG-UI 上のアシスタントメッセージ識別子（Message_Id）
  // - sentiment: 評価値 "good" / "bad"（Feedback_Sentiment）
  // - comment: 任意の自由記述（bad のときのみ意味を持つ）。
  //   最大 1000 文字の上限はアプリ層（isValidComment / ダイアログ）で強制する。
  //   Amplify の a.string() は文字数制約を持たないため、スキーマ側では長さを
  //   検証しない（Req 3.5 はフロントで担保）。
  // - createdAt: 作成タイムスタンプ
  //
  // secondaryIndex（Req 4.5 の upsert 基盤 / 集計走査）:
  // - (ownerUserId, messageId) で、同一ユーザー×同一メッセージの既存レコードを
  //   検索し upsert（存在すれば update / なければ create / クリアで delete）する
  //   ための走査に用いる。GSI の物理設計詳細・集計クエリ方式は実装フェーズで確定
  //   （要件 Out of Scope）。
  //
  // 🚩 [高感度] 認可（Req 4.3, 4.4）:
  // - allow.owner().to(["create","read","update","delete"]): 所有者は自分の
  //   Feedback を作成・読み取り・更新・削除できる。
  // - allow.authenticated().to(["read"]): 認証済みの任意ユーザーが全オーナー横断で
  //   read できる（Feedback_Dashboard の全ユーザー集計・他ユーザーの Bad コメント
  //   閲覧を支える）。read の開放により、他ユーザーの自由記述コメントに機微情報が
  //   含まれ得る点は運用者が受容する前提（design.md の高感度フラグ参照）。
  // - create/update/delete は owner 以外に付与しない → なりすまし投稿・改ざん・
  //   削除は不可（Req 4.4, 4.7）。
  //
  // 認可モード: defaultAuthorizationMode: "userPool" を継承（Req 4.2、既存と一貫）。
  // 既存モデル（ChatSession / RoleConfig / Todo）の定義・認可は無変更（Req 8.5）。
  // ============================================================
  MessageFeedback: a
    .model({
      ownerUserId: a.string().required(),
      chatSessionId: a.string().required(),
      messageId: a.string().required(),
      sentiment: a.enum(["good", "bad"]),
      comment: a.string(),
      createdAt: a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index("ownerUserId")
        .sortKeys(["messageId"])
        .queryField("listFeedbackByOwnerMessage"),
    ])
    .authorization((allow) => [
      allow.owner().to(["create", "read", "update", "delete"]),
      allow.authenticated().to(["read"]),
    ]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    // 高感度変更: apiKey → userPool に変更
    // これにより全 Data アクセスに Cognito 認証が必須となる
    // 既存のサンプル Todo (apiKey) は動作しなくなる
    defaultAuthorizationMode: "userPool",
  },
});
