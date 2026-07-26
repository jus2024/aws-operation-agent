# Requirements Document

## Introduction

本仕様は、機能面の開発が概ね完了した本アプリケーション（Next.js App Router + CopilotKit `@copilotkit/react-core/v2` + AG-UI + Amplify Gen 2）に対して、UI/UX を強化する4つの取り組みを定義する。

1. **回答のリッチ化（Generative UI）**: LLM の回答をテキストだけでなくグラフや表として可視化し、AG-UI / CopilotKit の generative UI 機構と整合させる。
2. **Good/Bad フィードバックの作り込み**: CopilotKit 標準のグッド/バッドボタン押下時の挙動を実装し、DynamoDB（Amplify Data Model）へ保存する。Bad の場合は任意で具体的な悪い点を入力・収集する。
3. **フィードバック集計画面**: 全ユーザーを横断した Good/Bad の件数・傾向を可視化する集計画面を、認証済みの全ユーザーが閲覧できるようにする。画面は既存の主画面上の導線（`RoleConfigManager` を開くボタンと同じ場所）に配置するが、ADMINS グループ所属では制限しない。他ユーザーが投稿した Bad の自由記述コメントも含めて閲覧できる。
4. **画面のビジュアルリニューアル**: 業務利用にふさわしいトーンを保ちつつ、より見やすく使いたくなる画面へ改善する。まず HTML のみのモックで画面イメージを先行確認する。

### 設計方針・前提

- 主画面は既存どおり `src/app/page.tsx` を維持し、新規サブページは作らない（`structure` ルール）。フィードバック集計画面は既存の主画面上の導線（`RoleConfigManager` を開くボタンと同じ場所）に載せるが、認証済みの全ユーザーが利用でき、ADMINS グループ所属では制限しない。
- フロントエンドの CopilotKit import は `@copilotkit/react-core/v2` を使用する（v1 ではない）。ブラウザ → `/api/copilotkit`（SSR Lambda, CopilotRuntime + `ExperimentalEmptyAdapter`）→ `HttpAgent`（SigV4）→ AgentCore Runtime という接続構成は変更しない。
- 発言内容そのものの正のデータソースは AgentCore Memory に一本化済みであり、本仕様で追加する Feedback は発言内容とは別の付随メタデータとして新規 Data Model に保存する（`ChatMessage` への発言内容書き込みは復活させない）。
- Generative UI のためにエージェント側（`agents/`）が可視化ペイロードを AG-UI プロトコルで送出する必要がある場合、その実装はエージェントランタイム層に閉じ、Web アプリ本体（`src/`）にエージェントのランタイムロジックを混在させない（`structure` ルール）。

### スコープ外（Out of Scope）

- 可視化に用いる具体的なチャートライブラリの選定、Feedback 永続化の DynamoDB 物理設計（GSI 構成等）、および集計クエリの具体的な実装方式。これらは設計フェーズで確定する（本仕様では利用者体験と振る舞いのゴールのみを規定する）。
- HTML モックで確認したビジュアルを React コンポーネントへ実装反映する作業の詳細手順。本仕様ではモック先行確認を1つの成果物要件として規定し、実装反映は後続タスクとする。
- Cognito グループ（ADMINS）の運用・付与フローの変更。ADMINS グループは既存のものをそのまま利用し、Role_Config 保守画面のアクセス制御に引き続き用いる。
- LLM/エージェントの応答内容そのものの品質改善（プロンプト設計、ツール追加など）。本仕様は表現・可視化・フィードバック収集・画面体験に限定する。

## Glossary

- **Frontend**: Next.js App Router で実装された Web アプリ本体（`src/`）。
- **Chat_UI**: `@copilotkit/react-ui` の `CopilotChat` を用いたチャット表示領域（`SessionChat`）。
- **Agent**: AgentCore Runtime 上で動作する Strands エージェント（`agents/`）。
- **API_Route**: `/api/copilotkit` に配置される Next.js API Route。
- **Generative_UI**: LLM の回答に含まれる構造化データを、テキストではなくグラフや表などの UI コンポーネントとして描画する仕組み。CopilotKit / AG-UI の generative UI 機構を通じて実現する。
- **Visualization**: Generative_UI が描画する可視化コンポーネント（棒グラフ、折れ線グラフ、円グラフ、データ表など）。
- **Visualization_Payload**: Agent が AG-UI プロトコル経由で送出する、可視化の種類とデータを表す構造化データ。
- **Visualization_Schema**: Visualization_Payload が満たすべき、フロントエンドとエージェントで合意された構造定義（可視化種別・データ系列・ラベル等）。
- **Feedback**: 1件のアシスタントメッセージに対して1ユーザーが付与する評価。Feedback_Sentiment と任意の Feedback_Comment を持つ。
- **Feedback_Control**: Chat_UI 上に表示される Good/Bad ボタン（CopilotKit 標準のフィードバック UI）。
- **Feedback_Sentiment**: Feedback の評価値。"good" または "bad" のいずれか。
- **Feedback_Comment**: Bad 評価時に任意で入力される自由記述の悪い点。
- **Feedback_Comment_Dialog**: Bad 押下時に表示される、Feedback_Comment 入力用の任意入力ダイアログ。
- **MessageFeedback**: Feedback を永続化する Amplify Gen 2 の Data_Model（DynamoDB テーブル）。
- **Message_Id**: AG-UI プロトコル上でアシスタントメッセージを一意に識別する識別子。Feedback はこの Message_Id に紐づく。
- **Chat_Session**: ユーザー所有のチャットセッションメタデータレコード（既存 `ChatSession` モデル）。
- **Feedback_Dashboard**: 全ユーザー横断の Feedback 集計・傾向を表示する画面。認証済みの全ユーザーが閲覧でき、他ユーザーが投稿した Bad の Feedback_Comment も含めて表示する。ADMINS グループ所属では制限しない。
- **Administrator / ADMINS group**: Cognito の `ADMINS` グループに属し、Role_Config 保守画面へのアクセスを許可されたユーザー。
- **UI_Mock**: リニューアル後の画面イメージを先行確認するための、バックエンドに接続しない静的 HTML モック。
- **Design_Tokens**: 色・余白・タイポグラフィ等を統一するために定義される再利用可能なスタイル値の集合。
- **Data_Model**: Amplify Gen 2 で定義される DynamoDB ベースのデータモデル。
- **Composer**: メッセージ送信前の入力領域。テキスト入力に加えて画像の添付（ファイル選択）・クリップボード貼り付け・添付プレビュー表示を担う。
- **Image_Attachment**: 送信前のユーザーメッセージに添付される画像。専用のオブジェクトストレージ（S3 等）を介さず、AG-UI プロトコル上で base64 エンコードされたインライン画像コンテンツとして送出される。
- **Message_Action_Row**: アシスタントメッセージの下部に表示される操作行。Feedback_Control（Good/Bad）に加えて、再生成（regenerate）アクションとコピー（copy-to-clipboard）アクションを含む。

## Requirements

### Requirement 1: Generative UI による回答のリッチ表示

**User Story:** As a user, I want the assistant's answers to be rendered as charts and tables when the data is suitable, so that I can understand quantitative results at a glance instead of reading raw text.

#### Acceptance Criteria

1. WHEN the Agent returns an assistant response that includes a Visualization_Payload conforming to the Visualization_Schema, THE Generative_UI SHALL render that payload within the Chat_UI as the Visualization corresponding to the payload's declared visualization type, instead of rendering the payload as raw text.
2. THE Generative_UI SHALL support rendering at least the following visualization types: bar chart, line chart, pie chart, and tabular data table.
3. WHEN the Agent produces content intended for visualization, THE Agent SHALL emit that content as a Visualization_Payload over the AG-UI protocol conforming to the Visualization_Schema.
4. IF a Visualization_Payload declares a visualization type that is not among the types listed in Criterion 2, THEN THE Generative_UI SHALL render a textual fallback representation of the payload and SHALL display an indication that the visualization type is not supported.
5. IF a Visualization_Payload fails validation against the Visualization_Schema, THEN THE Generative_UI SHALL render a textual fallback representation and SHALL continue rendering the remainder of the assistant message without interruption.
6. FOR ALL Visualization_Payload values that conform to the Visualization_Schema, validating and normalizing the payload and then re-validating the normalized result SHALL yield a payload that still conforms to the Visualization_Schema and represents the same visualization type and data values (round-trip property).
7. THE Generative_UI SHALL render each Visualization with an accessible text alternative that conveys the visualization's title and underlying data values to assistive technologies.
8. WHERE a rendered Visualization is a chart type, THE Generative_UI SHALL make the chart's underlying data values available to the user in a textual or tabular form.

### Requirement 2: Good/Bad フィードバック操作の挙動

**User Story:** As a user, I want the good and bad buttons on each assistant message to actually record my rating, so that my feedback is captured and reflected in the interface.

#### Acceptance Criteria

1. THE Chat_UI SHALL display the Feedback_Control (a Good button and a Bad button) on each assistant message.
2. WHEN a user activates the Good button on an assistant message that currently has no Feedback from that user, THE Frontend SHALL record a Feedback with Feedback_Sentiment "good" associated with that message's Message_Id and its Chat_Session.
3. WHEN a user activates the Bad button on an assistant message that currently has no Feedback from that user, THE Frontend SHALL record a Feedback with Feedback_Sentiment "bad" associated with that message's Message_Id and its Chat_Session, and SHALL proceed according to Requirement 3.
4. WHEN a user activates a Feedback_Sentiment that is the opposite of the Feedback_Sentiment they have already recorded for the same message, THE Frontend SHALL update that message's Feedback to the newly activated Feedback_Sentiment.
5. WHEN a user activates the same Feedback_Sentiment that they have already recorded for the same message, THE Frontend SHALL clear that user's Feedback for that message so that the message has no Feedback from that user.
6. THE Feedback_Control SHALL visually indicate the current Feedback_Sentiment recorded by the user for each message, distinguishing the "good", "bad", and no-feedback states.
7. IF recording, updating, or clearing a Feedback fails, THEN THE Frontend SHALL display an error indication and SHALL restore the Feedback_Control to reflect the last successfully persisted state for that message.
8. THE Chat_UI SHALL display the Message_Action_Row on each assistant message, presenting the Feedback_Control together with a regenerate (再生成) action and a copy-to-clipboard (コピー) action, preserving these existing CopilotKit message actions alongside the Good/Bad buttons.
9. WHEN a user activates the regenerate (再生成) action on an assistant message, THE Frontend SHALL request the Agent to produce a new response for that message's originating user prompt.
10. WHEN a user activates the copy-to-clipboard (コピー) action on an assistant message, THE Frontend SHALL copy that assistant response's text content to the system clipboard.

### Requirement 3: Bad フィードバックのコメント収集

**User Story:** As a user, I want to optionally describe what was wrong when I give a bad rating, so that the specific problem can be collected and reviewed.

#### Acceptance Criteria

1. WHEN a user records a Feedback with Feedback_Sentiment "bad", THE Frontend SHALL display the Feedback_Comment_Dialog for that message.
2. THE Feedback_Comment_Dialog SHALL allow the user to submit the "bad" Feedback with a Feedback_Comment and SHALL also allow the user to submit the "bad" Feedback without any Feedback_Comment.
3. WHEN a user submits the Feedback_Comment_Dialog with a non-empty Feedback_Comment, THE Frontend SHALL persist that Feedback_Comment together with the "bad" Feedback for that message's Message_Id.
4. WHEN a user closes or cancels the Feedback_Comment_Dialog without entering a Feedback_Comment, THE Frontend SHALL retain the "bad" Feedback for that message with no Feedback_Comment.
5. THE Feedback_Comment_Dialog SHALL limit the Feedback_Comment to at most 1000 characters, and IF the user enters more than 1000 characters, THEN THE Frontend SHALL prevent submission and display a validation message indicating the character limit.
6. WHERE a user later changes a message's Feedback_Sentiment from "bad" to "good" or clears the Feedback, THE Frontend SHALL remove the previously stored Feedback_Comment for that message.

### Requirement 4: フィードバックの永続化・データモデル・認可

**User Story:** As a system, I want feedback to be stored durably with clear ownership and access rules, so that owners control their own feedback while any authenticated user can review feedback in aggregate.

#### Acceptance Criteria

1. THE MessageFeedback Data_Model SHALL persist each Feedback record with an owner user identifier, the associated Chat_Session identifier, the associated Message_Id, a Feedback_Sentiment whose value is "good" or "bad", an optional Feedback_Comment, and a creation timestamp.
2. THE MessageFeedback Data_Model SHALL be defined in `amplify/data/resource.ts` using the Cognito userPool authorization mode, consistent with the existing Data_Models.
3. THE MessageFeedback Data_Model SHALL authorize the owner of a Feedback record to create, read, update, and delete that record, and SHALL authorize every authenticated user to read Feedback records across all owners.
4. THE MessageFeedback Data_Model SHALL NOT authorize any user other than the owner of a Feedback record to create, update, or delete that record.
5. THE Frontend SHALL maintain at most one Feedback record per combination of owner user identifier and Message_Id, updating the existing record rather than creating a duplicate when the same user changes their rating for the same message.
6. WHEN a user clears their Feedback for a message under Requirement 2 Criterion 5, THE Frontend SHALL remove the corresponding MessageFeedback record for that owner and Message_Id.
7. THE Frontend SHALL associate every Feedback record with the identity of the authenticated user who created it and SHALL NOT record a Feedback under the identity of any other user.

### Requirement 5: フィードバック集計ダッシュボード（全ユーザー向け）

**User Story:** As an authenticated user, I want to see good and bad feedback counts and trends across all users, so that I can understand overall satisfaction and identify recurring problems.

#### Acceptance Criteria

1. THE Frontend SHALL allow every authenticated user to access the Feedback_Dashboard, without requiring membership in the ADMINS group.
2. THE Feedback_Dashboard SHALL present Feedback aggregated across all users regardless of which authenticated user is currently viewing it, including Bad Feedback_Comment values authored by other users.
3. THE Frontend SHALL provide the entry point to the Feedback_Dashboard to every authenticated user, co-located with the existing navigation used to open the Role_Config maintenance screen (`RoleConfigManager`), without introducing a new subpage under `src/app/`.
4. WHEN an authenticated user opens the Feedback_Dashboard, THE Frontend SHALL display, aggregated across all users, the total count of "good" Feedback, the total count of "bad" Feedback, and the proportion of "good" Feedback among all Feedback records.
5. THE Feedback_Dashboard SHALL display the trend of "good" and "bad" Feedback counts over time using a Visualization.
6. THE Feedback_Dashboard SHALL display Feedback records whose Feedback_Sentiment is "bad" together with their Feedback_Comment values, for review of specific reported problems.
7. IF there are zero Feedback records available, THEN THE Feedback_Dashboard SHALL display an empty-state indication rather than an error.
8. THE Feedback_Dashboard SHALL read Feedback data through the MessageFeedback Data_Model using the all-authenticated-user read authorization defined in Requirement 4.

### Requirement 6: UI/UX リニューアルの HTML モック先行確認

**User Story:** As a stakeholder, I want to review the renewed screen design as a static HTML mock first, so that I can confirm the visual direction before any application code is changed.

#### Acceptance Criteria

1. THE UI_Mock SHALL present the renewed visual design of the primary chat screen, including the session history sidebar, the chat area, and the Feedback_Control.
2. THE UI_Mock SHALL present the renewed visual design of the Feedback_Dashboard.
3. THE UI_Mock SHALL be viewable in a web browser as static HTML without requiring authentication, backend services, or the running application.
4. THE UI_Mock SHALL NOT be wired into the running application's routing or navigation, so that reviewing the mock does not alter existing application behavior.
5. THE UI_Mock SHALL reflect a professional tone appropriate for business use as constrained by the visual quality criteria in Requirement 7.

### Requirement 7: リニューアル後のビジュアル品質基準

**User Story:** As a business user, I want the interface to be clean, readable, and professional, so that it is pleasant to use for work without being distracting.

#### Acceptance Criteria

1. THE Frontend SHALL apply a single shared set of Design_Tokens for color, spacing, and typography consistently across the chat screen, the session history sidebar, and the Feedback_Dashboard.
2. THE Frontend SHALL render normal-size text with a contrast ratio of at least 4.5:1 against its background, and SHALL render large text and interactive component boundaries with a contrast ratio of at least 3:1 against their backgrounds.
3. THE Frontend SHALL make every interactive control operable by keyboard and SHALL display a visible focus indicator on the currently focused control.
4. WHILE the browser viewport width is at least 1024 pixels, THE Frontend SHALL present the chat screen, the session history sidebar, and the Feedback_Dashboard without horizontal scrolling of the primary content.
5. THE Frontend SHALL preserve the existing chat, session history, role selection, and Role_Config maintenance functionality after the visual renewal, such that no existing user-facing capability is removed by the styling changes, while consolidating redundant duplicate controls; specifically, THE Frontend SHALL remove the redundant "新規セッション" button from the session header and SHALL retain the sidebar "新規チャット" control as the single entry point for starting a new Chat_Session.

### Requirement 8: 既存アーキテクチャ・構成との整合

**User Story:** As a developer, I want these UI/UX enhancements to fit the established architecture and repository structure, so that the changes remain reviewable and do not violate existing layering rules.

#### Acceptance Criteria

1. THE Frontend SHALL build all new user-facing capabilities of this specification on the primary page (`src/app/page.tsx`) and SHALL NOT introduce new subpages under `src/app/` for them.
2. THE Frontend SHALL use CopilotKit imports from `@copilotkit/react-core/v2` for all chat and Generative_UI integration, and SHALL NOT introduce imports from the v1 package.
3. THE Frontend SHALL continue to route chat requests through the API_Route to the single AgentCore Runtime using the existing SigV4-signed `HttpAgent` connection, without changing that connection architecture.
4. WHERE Generative_UI requires the Agent to emit Visualization_Payload data, THE Agent-side implementation SHALL reside within `agents/`, and THE Frontend SHALL NOT contain agent runtime logic for producing Visualization_Payload data. WHERE image input requires the Agent to process Image_Attachment content with a vision-capable model (Requirement 9), THE Agent-side implementation SHALL reside within `agents/`, and THE Frontend SHALL NOT contain agent runtime vision-processing logic.
5. THE MessageFeedback Data_Model SHALL be added incrementally to the existing `amplify/data/resource.ts` schema without removing or altering the authorization of the existing `ChatSession` and `RoleConfig` Data_Models.
6. THE Frontend SHALL make the Feedback_Dashboard entry point available to every authenticated user and SHALL NOT gate that entry point by ADMINS group membership, while continuing to gate the Role_Config maintenance screen entry point by the existing ADMINS group membership check.
7. THE Frontend SHALL transmit Image_Attachment content to the single AgentCore Runtime through the existing API_Route and SigV4-signed `HttpAgent` connection defined in Criterion 3, without introducing a new connection architecture or object storage service.

### Requirement 9: 画像入力（アップロード + スクリーンショット貼り付け）

**User Story:** As a user, I want to attach images from my device and paste screenshots from the clipboard into the chat, so that the assistant can answer questions about them.

#### Acceptance Criteria

1. THE Composer SHALL provide a control to select one or more image files from the user's device.
2. WHILE the Composer text input is focused, WHEN the user pastes (Ctrl+V / Cmd+V) and the clipboard contains an image, THE Frontend SHALL attach that image to the pending message as an Image_Attachment.
3. THE Frontend SHALL show a preview, consisting of a thumbnail together with the filename and size, of each Image_Attachment before sending, and SHALL allow the user to remove an individual Image_Attachment before sending.
4. THE Frontend SHALL accept image types PNG, JPEG, WebP, and GIF, and IF the user attaches a file of an unsupported type, THEN THE Frontend SHALL reject that file and SHALL display a non-blocking validation message.
5. THE Frontend SHALL enforce all of the following limits: (a) a per-image size limit of 3 megabytes of raw bytes, (b) a per-message total attached-image budget of 3 megabytes of raw bytes summed across all Image_Attachments on the pending message, and (c) a per-message limit of at most 3 Image_Attachments; and IF adding an attachment would exceed any of limits (a), (b), or (c), THEN THE Frontend SHALL prevent that attachment and SHALL display a validation message naming the exceeded limit.
6. WHEN a user sends a message that has one or more Image_Attachments, THE Frontend SHALL transmit each Image_Attachment to the Agent as base64-encoded inline image content over the AG-UI protocol, alongside any text content, without using separate object storage.
7. THE Agent SHALL accept the inline image content and SHALL process it with a vision-capable model so that the Agent's response can reference the content of the image.
8. THE Frontend SHALL keep the total base64-encoded request within the approximately 6 megabyte transport limit of the Amplify Hosting SSR Lambda, and SHALL estimate the total request payload size before sending; IF an Image_Attachment cannot be base64-encoded, or IF the estimated total request payload would exceed that transport limit, THEN THE Frontend SHALL display an error and SHALL NOT silently drop the Image_Attachment.
9. THE Frontend SHALL NOT retransmit previously-sent Image_Attachment binary data on subsequent turns of the same conversation, such that only the current turn's Image_Attachments are sent inline and prior-turn image bytes are not resent, in order to keep each request within the transport limit.
10. THE Frontend SHALL make the attach control and each Image_Attachment remove control operable by keyboard and SHALL provide each with an accessible label.
