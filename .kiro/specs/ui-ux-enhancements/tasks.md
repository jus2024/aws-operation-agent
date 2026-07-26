# Implementation Plan: UI/UX Enhancements

## Overview

本実装計画は、`requirements.md`（Req 1〜8）と `design.md`（6 イニシアチブ + 8 Correctness Properties）に厳密に基づき、既存アーキテクチャ（Next.js App Router + `@copilotkit/react-core/v2` + AG-UI + Amplify Gen 2）を壊さずに段階的に構築する。

実装は `repo-workflow` ルールに従い、リファクタ・機能追加・インフラ変更を混在させず、レビューしやすい単位（HTML モック / データモデル / 純粋ロジック / Generative UI / Feedback / Dashboard / ビジュアル / Agent 送出）に分割する。すべてのフロント成果物は `src/app/page.tsx` 上に構築し、新規サブページを作らない（Req 8.1）。CopilotKit import は `@copilotkit/react-core/v2` に統一する（Req 8.2）。純粋ロジックは `src/lib/agent/` に置き、`fast-check`（`{ numRuns: 100 }` 以上）で 8 プロパティを検証する（既存 `src/lib/agent/*.pbt.test.ts` の慣習に準拠）。

実装言語: **TypeScript**（フロント/Amplify）、**Python 3.12+**（`agents/` のみ）。設計は具体言語を用いているため言語選択は不要。

> 🚩 本計画には **高感度変更（auth/data）** が含まれる（Task 2）。`security` / `repo-workflow` / `amplify-backend` ルールに従い、レビュー必須としてフラグを立てている。

## Tasks

- [x] 1. UI/UX リニューアルの HTML モック先行確認（React 実装前の単独成果物）
  - [x] 1.1 主画面（チャット）の静的 HTML モックを作成
    - セッション履歴サイドバー・チャットエリア・Feedback_Control を含む刷新後ビジュアルを表現
    - 認証・バックエンド・アプリ起動なしでブラウザ単体表示できる静的 HTML として作成（例: `mocks/chat.html`）
    - 実アプリのルーティング/ナビゲーションに接続しない（レビューが既存挙動を変えない）
    - 業務利用にふさわしいトーン（Req 7 の品質基準を先取り）
    - _Requirements: 6.1, 6.3, 6.4, 6.5_

  - [x] 1.2 Feedback_Dashboard の静的 HTML モックを作成
    - Good/Bad 件数・比率・トレンド・Bad コメント一覧・空状態の刷新後ビジュアルを表現
    - 静的 HTML として単体表示可能・アプリ配線なし（例: `mocks/dashboard.html`）
    - _Requirements: 6.2, 6.3, 6.4, 6.5_

- [x] 2. MessageFeedback Amplify Data_Model + 認可の追加（🚩 高感度: 要レビュー）
  - [x] 2.1 `amplify/data/resource.ts` に MessageFeedback モデルを段階的に追加
    - フィールド: `ownerUserId`(required), `chatSessionId`(required), `messageId`(required), `sentiment`(enum ["good","bad"]), `comment`(optional, <=1000), `createdAt`(datetime required)
    - `(ownerUserId, messageId)` の upsert 検索と集計走査用の secondaryIndex を定義（GSI 物理設計の詳細は実装フェーズで確定）
    - `defaultAuthorizationMode: "userPool"` を継承（既存モデルと一貫）
    - 🚩 **[高感度] 認可設定:** `allow.owner().to(["create","read","update","delete"])` + `allow.authenticated().to(["read"])`。**read を全認証ユーザーへ開放**（他ユーザーの Bad コメント閲覧を許容）する一方、CUD は owner 限定でなりすまし/改ざん/削除を防止。プライバシー影響（コメントに機微情報が入り得る）を運用者が受容していることをレビューで確認
    - 🚩 **[高感度] 既存モデル無変更:** `ChatSession`(`allow.owner()`) / `RoleConfig`(`allow.group("ADMINS")`) / `Todo` の定義・認可を一切変更しない
    - **デプロイ影響:** スキーマ変更は `amplify sandbox` で反復検証し Amplify Hosting デプロイで反映。既存モデル無変更のため後方互換
    - **検証ノート（コーディング対象外）:** owner の CRUD / 別ユーザーの read 可・CUD 拒否 / 記録 owner が認証ユーザー sub と一致 / Dashboard の全ユーザー read は、ローカルでは SigV4 + コンピューティングロールが必要なため結合検証できず、Amplify Hosting デプロイ環境で確認する（`testing` ルール）
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 8.5_

- [x] 3. `src/lib/agent/` の純粋ロジック実装 + プロパティベーステスト
  - [x] 3.1 Visualization スキーマ/検証/正規化/アクセシブル変換を実装
    - `src/lib/agent/visualization/schema.ts`: `VisualizationType`, `VisualizationPayload`, `parseVisualization`（例外を投げず ok/reason を返す全域関数）, `normalizeVisualization`, `isValidVisualization`, `toAccessibleTable`
    - bar/line/pie/table の 4 型に対応、非適合は `invalid_schema` / 非対応型は `unsupported_type`
    - _Requirements: 1.1, 1.4, 1.5, 1.6, 1.7, 1.8_

  - [x] 3.2 Property 1 のプロパティテストを作成
    - **Feature: ui-ux-enhancements, Property 1: Visualization_Payload の validate/normalize ラウンドトリップ**（正規化後も適合・同一 type/データ値・冪等）
    - `src/lib/agent/visualization/schema.pbt.test.ts`、`fast-check` `{ numRuns: 100 }` 以上、適合ペイロード生成器（Unicode/大きな数値/空系列のエッジ含む）
    - **Validates: Requirements 1.6**

  - [x] 3.3 Property 2 のプロパティテストを作成
    - **Feature: ui-ux-enhancements, Property 2: parse は全域であり非適合は必ずフォールバックへ分類される**（任意入力で例外なし、ok:true/unsupported_type/invalid_schema のいずれか）
    - `src/lib/agent/visualization/schema.pbt.test.ts`、適合/非対応型/不正構造/`unknown` を混在生成、`{ numRuns: 100 }` 以上
    - **Validates: Requirements 1.1, 1.4, 1.5**

  - [x] 3.4 Property 3 のプロパティテストを作成
    - **Feature: ui-ux-enhancements, Property 3: アクセシブルな代替はタイトルと全データ値を含む**（`toAccessibleTable` の caption に title、rows に全データ値）
    - `src/lib/agent/visualization/schema.pbt.test.ts`、適合ペイロード生成器、`{ numRuns: 100 }` 以上
    - **Validates: Requirements 1.7, 1.8**

  - [x] 3.5 Feedback リデューサとコメント長バリデーションを実装
    - `src/lib/agent/feedback/feedbackState.ts`: `FeedbackState`, `nextFeedbackState(current, activated)`, `FEEDBACK_COMMENT_MAX=1000`, `isValidComment`
    - none+X→X / 反対押下→更新（bad→good で comment 破棄）/ 同一押下→クリア、sentiment≠bad なら comment は常に null
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 3.5, 3.6_

  - [x] 3.6 Property 4 のプロパティテストを作成
    - **Feature: ui-ux-enhancements, Property 4: Feedback トグルリデューサ**（none/反対/同一 の遷移と comment 破棄不変）
    - `src/lib/agent/feedback/feedbackState.pbt.test.ts`、状態×押下 sentiment の全組合せ生成、`{ numRuns: 100 }` 以上
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.5, 3.6**

  - [x] 3.7 Property 5 のプロパティテストを作成
    - **Feature: ui-ux-enhancements, Property 5: コメント長バリデーション**（`isValidComment(c)` ⇔ 長さ<=1000、境界 1000 有効/1001 無効）
    - `src/lib/agent/feedback/feedbackState.pbt.test.ts`、任意長文字列（境界・Unicode 含む）、`{ numRuns: 100 }` 以上
    - **Validates: Requirements 3.5**

  - [x] 3.8 (owner, messageId) upsert のローカルストアロジックを実装
    - `src/lib/agent/feedback/messageFeedbackStore.ts`: アクション列適用で (owner, messageId) あたり高々 1 レコードを維持、clear で 0 件、`nextFeedbackState` を利用
    - _Requirements: 4.5, 4.6_

  - [x] 3.9 Property 6 のプロパティテストを作成
    - **Feature: ui-ux-enhancements, Property 6: (owner, messageId) 単位の upsert 不変条件**（任意アクション列後に高々 1 件、直近 clear なら 0 件）
    - `src/lib/agent/feedback/messageFeedbackStore.pbt.test.ts`、good/bad/clear の任意列生成器、`{ numRuns: 100 }` 以上
    - **Validates: Requirements 4.5, 4.6**

  - [x] 3.10 全ユーザー横断の集計ロジックを実装
    - `src/lib/agent/feedback/aggregate.ts`: `FeedbackRecordView`, `FeedbackAggregate`, `aggregateFeedback(records)`（goodCount/badCount/total/goodRatio/badWithComments、空集合は 0 値）
    - _Requirements: 5.2, 5.4, 5.6, 5.7_

  - [x] 3.11 Property 7 のプロパティテストを作成
    - **Feature: ui-ux-enhancements, Property 7: 全ユーザー横断の集計不変条件**（good+bad===total===|R|、goodRatio 定義、badWithComments は全て bad、空集合でエラーにならない）
    - `src/lib/agent/feedback/aggregate.pbt.test.ts`、複数オーナー混在＋空集合を含む生成器、`{ numRuns: 100 }` 以上
    - **Validates: Requirements 5.2, 5.4, 5.6, 5.7**

  - [x] 3.12 Feedback_Dashboard のアクセスゲートを追加
    - `src/lib/agent/accessGates.ts`（既存へ追記）: `canAccessFeedbackDashboard(isAuthenticated) = isAuthenticated`。既存 `canAccessRoleConfigSettings(groups)`（ADMINS ゲート）は変更しない
    - _Requirements: 5.1, 8.6_

  - [x] 3.13 Property 8 のプロパティテストを作成
    - **Feature: ui-ux-enhancements, Property 8: アクセスゲート（Dashboard は全認証・RoleConfig は ADMINS）**
    - `src/lib/agent/accessGates.pbt.test.ts`（既存へ追記）、`isAuthenticated` × `groups`（ADMINS 有無/任意グループ）生成、`{ numRuns: 100 }` 以上
    - **Validates: Requirements 5.1, 8.6**

- [x] 4. チェックポイント — 純粋ロジックと全プロパティテストの通過を確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Generative UI コンポーネントの実装（回答のリッチ表示）
  - [x] 5.1 Visualization ディスパッチャと各可視化コンポーネントを実装
    - `src/components/agent/visualization/`: `Visualization`（正規化後に型で分岐）+ `BarChartView` / `LineChartView` / `PieChartView` / `DataTableView`
    - 各 Visualization に `<figure>` + 視覚的に隠したデータ表 + `aria-label`/`figcaption` のアクセシブル代替を付与
    - _Requirements: 1.1, 1.2, 1.7, 1.8_

  - [x] 5.2 VisualizationFallback を実装
    - 生ペイロードをテキスト/簡易表で表示し「未対応/検証失敗」の注記を添える
    - _Requirements: 1.4, 1.5_

  - [x] 5.3 Visualization を CopilotChat レンダリングへ配線
    - 受信 AG-UI ペイロードを `parseVisualization()` に通して描画、検証失敗時もメッセージ残部の描画を継続。import は `@copilotkit/react-core/v2` のみ、接続構成は不変
    - _Requirements: 1.1, 1.5, 8.2, 8.3_

  - [x] 5.4 Generative UI のユニットテストを作成
    - 4 可視化タイプの各描画、非対応型フォールバック、検証失敗時の継続描画（特定例・エッジのみ、網羅は PBT に委譲）
    - _Requirements: 1.2, 1.4, 1.5_

- [x] 6. Good/Bad フィードバック操作 + コメント収集ダイアログ
  - [x] 6.1 useMessageFeedback 永続化フックを実装
    - `src/lib/agent/feedback/useMessageFeedback.ts`: `generateClient<Schema>()` で MessageFeedback を操作。楽観的更新→create/update/delete→失敗時ロールバック、(owner, messageId) upsert、owner は identity claim に一致
    - _Requirements: 2.7, 4.5, 4.6, 4.7_

  - [x] 6.2 FeedbackControl を実装
    - `src/components/agent/`: Good/Bad ボタン、good/bad/none の 3 状態を視覚区別、CopilotKit 標準フィードバック UI スロットへ統合
    - _Requirements: 2.1, 2.6_

  - [x] 6.3 FeedbackCommentDialog を実装
    - Bad 押下時に開く任意入力ダイアログ、最大 1000 文字（超過時は送信不可 + バリデーションメッセージ）、コメント無し送信・キャンセル許容
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 6.4 Feedback フローを配線
    - Bad→ダイアログ起動、sentiment 遷移（good⇔bad、同一押下でクリア）、bad→good/クリア時のコメント削除、エラーインジケーター（`role="alert"`）。`src/app/page.tsx`/Chat へ統合
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 3.6_

  - [x] 6.5 Feedback のユニットテストを作成
    - ボタン 3 状態の視覚区別、Bad でのダイアログ起動とコメント有り/無し/キャンセル、永続化失敗時ロールバック
    - _Requirements: 2.6, 2.7, 3.1, 3.2, 3.3, 3.4_

  - [x] 6.6 MessageActionRow を実装（再生成 + コピー + 新規セッションボタン撤去）
    - `src/components/agent/`: アシスタントメッセージ下部に Feedback_Control + 再生成(regenerate) + コピー(copy) を 1 行に統合（CopilotKit のメッセージアクションスロット）。再生成は元プロンプトの再応答要求、コピーは応答テキストを `navigator.clipboard` へ。セッションヘッダーの冗長な「新規セッション」ボタンを撤去し、サイドバー「新規チャット」に一本化
    - _Requirements: 2.8, 2.9, 2.10, 7.5_

- [x] 7. Feedback_Dashboard（全認証ユーザー向け）
  - [x] 7.1 FeedbackDashboard コンポーネントを実装
    - Good/Bad 件数・Good 比率、時系列トレンド（Task 5 の Visualization を再利用）、Bad + コメント一覧、0 件時の空状態
    - _Requirements: 5.2, 5.4, 5.5, 5.6, 5.7_

  - [x] 7.2 MessageFeedback からの読み取りとエラー/空状態の区別を実装
    - all-authenticated read で全ユーザーの Feedback（他ユーザー Bad コメント含む）を取得、read 失敗時はエラー + 再試行導線（空状態と区別）
    - _Requirements: 5.7, 5.8_

  - [x] 7.3 Dashboard 導線を page.tsx に追加
    - `src/app/page.tsx` 右上に「フィードバック集計」ボタンを全認証ユーザー向けに併置（`RoleConfigManager` を開く導線と同じ場所）、`showFeedbackDashboard` でオーバーレイ表示。既存 ADMINS ゲート（RoleConfig 導線）は維持、新規サブページを作らない
    - _Requirements: 5.1, 5.3, 8.1, 8.6_

  - [x] 7.4 Dashboard のユニットテストを作成
    - トレンド描画と空状態表示
    - _Requirements: 5.5, 5.7_

- [x] 8. ビジュアルリニューアル / Design_Tokens 適用（HTML モックの方向性を反映）
  - [x] 8.1 Design_Tokens を定義
    - 色・余白・タイポグラフィの共有トークン集合を単一ソースとして定義
    - _Requirements: 7.1_

  - [x] 8.2 チャット/サイドバー/Dashboard へトークンを一貫適用
    - 通常テキスト 4.5:1 / 大テキスト・境界 3:1 のコントラスト、キーボード操作 + 可視フォーカス、幅 1024px 以上で横スクロールなし、既存機能（チャット・履歴・ロール選択・RoleConfig 保守）を維持
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 8.3 コントラスト/トークンのユニットテストを作成
    - コントラスト比計算関数と使用トークンペアの列挙検証
    - _Requirements: 7.2_

- [x] 9. Agent 側の Visualization_Payload 送出（`agents/`）
  - [x] 9.1 AG-UI で Visualization_Payload を送出する処理を実装
    - `agents/app/` 内に、フロント `schema.ts` と合意した同一構造の可視化データを AG-UI イベント（カスタムイベント or tool 結果）として送出。Web アプリ本体（`src/`）にエージェントランタイムロジックを持ち込まない
    - _Requirements: 1.3, 8.4_

  - [x] 9.2 Agent 側スキーマ検証テスト + スモーク確認を作成
    - Python 側の合意構造バリデーションを `hypothesis` で（既存 `agents/app/**/test_*_pbt.py` の慣習）。ruff lint + インポート確認を優先
    - **スモークノート（コーディング対象外の検証手順）:** `uvicorn` または `agentcore dev` で起動し `curl` で `/invocations` を叩き、AG-UI イベントに Visualization_Payload が含まれることを確認。フロント↔Agent 結合は Amplify Hosting デプロイ環境で確認（ローカル結合不可）
    - _Requirements: 1.3_

- [x] 11. 画像入力（アップロード + スクリーンショット貼り付け）
  - [x] 11.1 画像添付の純粋バリデーションロジックを実装
    - `src/lib/agent/attachments/imageAttachment.ts`: 定数 `IMAGE_MAX_BYTES=3*1024*1024`（1 画像 3MB）/`MESSAGE_IMAGE_BUDGET_BYTES=3*1024*1024`（1 メッセージの生バイト合計予算＝主要ゲート）/`IMAGE_MAX_COUNT=3`/`TRANSPORT_MAX_BYTES=6*1024*1024` および `EFFECTIVE_TRANSPORT_MAX_BYTES≈5*1024*1024`/`ACCEPTED_IMAGE_TYPES`、型 `ImageAttachment`/`ImageAttachmentError`（`message_budget_exceeded` を含む）/`ImageFileMeta`、全域関数 `validateImageFile`（≤3MB）/ `withinMessageBudget`（合計 ≤3MB）/ `canAcceptMore`（≤3 枚）/ `withinTransportLimit`（base64 サイズを実効上限と比較）（いずれも例外を投げず ok/reason を返す）
    - _Requirements: 9.4, 9.5, 9.8_

  - [x] 11.2 Property 9 のプロパティテストを作成
    - **Feature: ui-ux-enhancements, Property 9: 画像添付バリデーション（型許可リスト・サイズ上限・合計予算・枚数上限）**（validateImageFile は type∈allowlist ∧ size≤3MB と同値、withinMessageBudget は生バイト合計≤3MB と同値、canAcceptMore は count≤3、いずれも境界値を含む）
    - `src/lib/agent/attachments/imageAttachment.pbt.test.ts`、`fast-check` `{ numRuns: 100 }` 以上、contentType(許可/非許可)×sizeBytes(3MB境界/+1/0)×合計予算(3MB境界/+1)×current/incoming(3枚境界) の生成器
    - **Validates: Requirements 9.4, 9.5**

  - [x] 11.3 Composer（画像添付/貼り付け/プレビュー）を実装
    - `src/components/agent/`: ファイル選択(accept=PNG/JPEG/WebP/GIF, multiple)、テキスト入力フォーカス中の paste で画像添付、サムネ+ファイル名+サイズのプレビューと個別削除、11.1 の純粋関数で「単一画像3MB / メッセージ合計3MB予算(主要ゲート) / 最大3枚」を非ブロッキング検証、添付/削除コントロールのキーボード操作+aria-label
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.9, 9.10_

  - [x] 11.4 送信時の base64 インライン送出を配線
    - 受理済み添付を base64 化し、CopilotKit/AG-UI の multimodal メッセージ（text + image blocks）として既存 `/api/copilotkit` + SigV4 経路で送出（接続構成不変）。**現在ターンの画像のみをインライン送出し、過去ターンの Image_Attachment バイナリはスレッドから strip して再送しない**（Req 9.9）。送信前に合計ペイロードを ~5MB の実効転送上限（`EFFECTIVE_TRANSPORT_MAX_BYTES`）で見積り、エンコード失敗/上限超過はエラー表示し添付を黙って落とさない。import は `@copilotkit/react-core/v2` のみ
    - _Requirements: 9.6, 9.8, 9.9, 8.7_

  - [x] 11.5 Composer/画像入力のユニットテストを作成
    - ファイル選択の accept、フォーカス中 paste 添付、プレビュー+個別削除、エンコード失敗/ペイロード超過のエラー表示、キーボード操作/aria（代表例のみ、網羅は Property 9 に委譲）
    - _Requirements: 9.1, 9.2, 9.3, 9.8, 9.9_

  - [x] 11.6 Agent 側でインライン画像を受理しビジョンモデルで処理
    - `agents/app/`: AG-UI 経由の multimodal メッセージ（text + base64 画像ブロック）を受理し、Strands 経由で Bedrock Converse API へ渡す。ビジョン処理ロジックは `agents/` に閉じ `src/` に持ち込まない（Req 8.4）
    - テキストのみ・テキスト+画像の両方を、単一のビジョン対応マルチモーダルモデル（Bedrock Converse API / Strands `BedrockModel`）で処理する。入力ごとのモデルルーティングは行わない（将来のコスト最適化拡張としてのみ想定）
    - モデル ID は環境変数で設定可能にする（ハードコードしない）
    - デフォルトモデル: Claude Sonnet 5 — ベース ID `anthropic.claude-sonnet-5`、クロスリージョン推論プロファイル `us./eu./au./jp.anthropic.claude-sonnet-5`（ap-northeast-1 では `jp.anthropic.claude-sonnet-5` を使用）、グローバル `global.anthropic.claude-sonnet-5`
    - 実装時の検証: Strands BedrockModel / Converse が対象リージョンで設定モデル ID を受理するかスモークテストする。受理されない場合は世代の近い Converse 対応モデル（例: `anthropic.claude-sonnet-4-6`）にフォールバックする。リージョン可用性・推論プロファイル要否を確認する。設定モデルは必ずビジョン対応であること
    - 3MB/画像は Converse の 3.75MB/画像上限に収まる
    - _Requirements: 9.7, 8.4_

  - [x] 11.7 Agent 側の画像受理スモーク + インポート確認を作成
    - **スモークノート（コーディング対象外）:** `uvicorn`/`agentcore dev` 起動 + `curl` で `/invocations` に text+base64 画像ブロックを投げ、受理と画像参照応答を確認。ruff lint + インポート確認を優先。フロント↔Agent 結合は Amplify Hosting デプロイ環境で確認（ローカル不可）
    - _Requirements: 9.7_

- [x] 12. CopilotKit 標準フィードバック/アクションへの切替 (Option A)
  - 実行中アプリで CopilotKit 既定の操作行（再生成 + コピー）と独自 `MessageActionRow` が二重に重なって表示される不具合（隠蔽 CSS `.copilotKitMessageControls` が v1.59 DOM に不一致）を受け、独自コントロールの実装を止め CopilotKit のビルトインメッセージコントロールへ一本化する
  - [x] 12.1 spec 更新（design.md / tasks.md）
    - design.md の Overview イニシアチブ 2・6、Components and Interfaces §3/§7、Testing Strategy、Error Handling を「ビルトインコントロール + 薄いラッパー」方針へ更新し、「設計変更 (Option A)」の rationale を追記。Req 2.1, 2.6, 2.8, 2.9, 2.10, 7.5 がビルトインで満たされることを確認
    - _Requirements: 2.1, 2.6, 2.8, 2.9, 2.10, 7.5_
  - [x] 12.2 `FeedbackAssistantMessage` を薄いラッパーへ書き換え
    - `MessageFeedbackProvider.tsx` の `FeedbackAssistantMessage` を、既定 `AssistantMessage`（`DefaultAssistantMessage`）に `feedback`（good→`"thumbsUp"`, bad→`"thumbsDown"`, null→`null`）を注入し `onThumbsUp`/`onThumbsDown` を `onGood`/`onBad` + Bad コメントダイアログへ配線するラッパーにする。`feedback-assistant-message` ラッパー div と `FeedbackControl`/`MessageActionRow` の使用を除去。プロバイダー本体（`recordFeedback`/ダイアログ起動/`role="alert"` エラー表示）は不変
    - _Requirements: 2.1, 2.6, 2.8, 2.9, 2.10, 7.5_
  - [x] 12.3 独自 `FeedbackControl` / `MessageActionRow` とその CSS・テストを削除
    - `FeedbackControl.tsx` / `feedback-control.css` / `FeedbackControl.test.tsx` / `MessageActionRow.tsx` / `message-action-row.css` / `MessageActionRow.test.tsx` を削除し、参照を除去
    - _Requirements: 2.1, 2.6, 2.8, 2.9, 2.10, 7.5_
  - [x] 12.4 lint/型チェック/テスト通過を確認
    - `npx tsc --noEmit` / `npm run lint` / `npm test` を実行し、`FeedbackControl`/`MessageActionRow` への残参照と v1 `@copilotkit/react-core` import が無いことを確認
    - _Requirements: 2.1, 2.6, 2.8, 2.9, 2.10, 7.5_

- [x] 10. 最終チェックポイント — 全テストと静的検証の通過を確認
  - Ensure all tests pass, ask the user if questions arise.
  - lint + 型チェックで `@copilotkit/react-core/v2` のみ使用（v1 不使用, Req 8.2）、`src/app/` に新規サブページ無し（Req 8.1）、`src/` に Agent ランタイムロジック無し（Req 8.4）を確認
  - 画像入力の静的検証: 画像添付バリデーションが `src/lib/agent/attachments/` の純粋モジュールに分離されていること、`src/` に Agent のビジョン処理ロジックが無いこと（Req 8.4）、画像送出が既存 `/api/copilotkit` + SigV4 経路のみで新規接続/ストレージを導入していないこと（Req 8.7）、Property 9 テスト通過を確認

## Notes

- `*` 付きサブタスクは任意（テスト系）で、MVP 高速化のためスキップ可能。トップレベルタスクには `*` を付けない
- 各タスクは実装対象の具体的な要件番号を参照し、PBT タスクは design.md の Correctness Properties（Property 1〜8）をタグ形式 `Feature: ui-ux-enhancements, Property {N}: ...` で明示参照する
- プロパティテストは `fast-check` を `{ numRuns: 100 }` 以上で実行し、既存 `src/lib/agent/*.pbt.test.ts` の慣習に合わせる（1 プロパティ = 1 プロパティテスト）
- 🚩 Task 2 は高感度変更（MessageFeedback の read 全認証開放 + 増分スキーマ追加）。認可のインテグレーション検証は Amplify Hosting デプロイ環境で実施する（ローカル不可: SigV4 + コンピューティングロール）
- HTML モック（Task 1）は React 実装前の単独レビュー成果物で、アプリのルーティング/ナビには接続しない
- 検証は最も狭い範囲から: フロントは lint + 型チェック優先、Amplify はデプロイ/設定影響を記載、Agent はスモーク + インポート確認を優先
- 全フロント成果物は `src/app/page.tsx` 上に構築し新規サブページを作らない。Agent ランタイムロジックは `agents/` に閉じる
- Task 6.2 (FeedbackControl) と 6.6 (独自 MessageActionRow) は Option A（Task 12）により CopilotKit 標準コントロールへ置き換えられた（superseded）。6.x のチェックは外さない

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1", "3.1", "3.5", "3.10", "3.12"] },
    { "id": 1, "tasks": ["3.2", "3.6", "3.8", "3.11", "3.13"] },
    { "id": 2, "tasks": ["3.3", "3.7", "3.9", "5.1", "5.2", "6.1", "9.1", "11.1"] },
    { "id": 3, "tasks": ["3.4", "5.3", "6.2", "6.3", "7.1", "9.2", "11.2", "11.3", "11.6"] },
    { "id": 4, "tasks": ["5.4", "6.4", "6.6", "7.2", "11.4", "11.5", "11.7"] },
    { "id": 5, "tasks": ["6.5", "7.3", "8.1"] },
    { "id": 6, "tasks": ["7.4", "8.2"] },
    { "id": 7, "tasks": ["8.3"] }
  ]
}
```
