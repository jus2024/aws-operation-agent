# Requirements Document

## Introduction

チャットセッション履歴管理機能。左側サイドバーに過去のチャットセッション一覧を表示し、ユーザーが過去のセッションを選択して会話内容を閲覧できるようにする。DynamoDB でセッション毎のメタデータ（最終更新日時、セッション名）を管理し、セッション名は初期会話から自動生成されるか、ユーザーが手動で変更できる。

## Glossary

- **Session_History_Sidebar**: 画面左側に表示されるチャットセッション一覧パネル
- **Chat_Session**: DynamoDB に保存されるチャットセッションのメタデータレコード（セッション名、最終更新日時等を含む）
- **Session_Name**: チャットセッションの表示名。自動生成または手動設定される
- **Chat_Message**: セッション内の個々のメッセージ（ユーザー発言・アシスタント応答）
- **Session_Name_Generator**: チャットの初期会話内容からセッション名を自動生成するロジック
- **Active_Session**: 現在表示・操作中のチャットセッション

## Requirements

### Requirement 1: チャットセッションメタデータの永続化

**User Story:** As a ユーザー, I want チャットセッションのメタデータがDynamoDBに保存される, so that 過去のセッション一覧を後から参照できる。

#### Acceptance Criteria

1. WHEN a new chat session is started, THE Chat_Session SHALL create a record in DynamoDB with ownerUserId, connectionId, operationScope, sessionName, startedAt, and updatedAt fields
2. WHEN a message is sent or received in a session, THE Chat_Session SHALL update the updatedAt field to the current timestamp
3. THE Chat_Session SHALL store sessionName as a string field with a maximum length of 100 characters
4. THE Chat_Session SHALL use owner-based authorization so that only the session owner can read, update, or delete the record
5. WHEN a session record is queried, THE Chat_Session SHALL support sorting by updatedAt in descending order

### Requirement 2: チャットメッセージの永続化

**User Story:** As a ユーザー, I want チャットメッセージがセッション毎に永続化される, so that 過去の会話内容を後から読み返せる。

#### Acceptance Criteria

1. WHEN a user sends a message, THE Chat_Message SHALL persist the message with sessionId, role (user/assistant), content, and createdAt fields
2. WHEN an assistant responds, THE Chat_Message SHALL persist the response with the same sessionId and role set to assistant
3. THE Chat_Message SHALL use owner-based authorization so that only the session owner can access messages
4. WHEN a session is selected from the history, THE Chat_Message SHALL return all messages for that session ordered by createdAt in ascending order

### Requirement 3: セッション履歴サイドバーの表示

**User Story:** As a ユーザー, I want 画面左側にチャット履歴のサイドバーが表示される, so that 過去のセッションを一覧で確認し選択できる。

#### Acceptance Criteria

1. WHILE a user is authenticated and in session_active state, THE Session_History_Sidebar SHALL display a list of past chat sessions belonging to the current user
2. THE Session_History_Sidebar SHALL display each session with its sessionName and updatedAt formatted as a relative time (例: "3分前", "昨日")
3. THE Session_History_Sidebar SHALL order sessions by updatedAt in descending order (newest first)
4. WHEN a user clicks a session entry in the sidebar, THE Session_History_Sidebar SHALL load and display the selected session's messages in the chat area
5. THE Session_History_Sidebar SHALL visually highlight the Active_Session in the list
6. THE Session_History_Sidebar SHALL provide a button to create a new chat session
7. WHILE the sidebar is displayed, THE Session_History_Sidebar SHALL be collapsible to maximize the chat area on smaller screens

### Requirement 4: セッション名の自動生成

**User Story:** As a ユーザー, I want セッション名がチャットの初期会話から自動的に設定される, so that 後から履歴を見たときにどんな会話だったか分かる。

#### Acceptance Criteria

1. WHEN the first user message is sent in a new session, THE Session_Name_Generator SHALL generate a concise session name (30 characters or fewer) based on the message content
2. WHEN the session name is auto-generated, THE Chat_Session SHALL update the sessionName field in DynamoDB
3. WHILE no user message has been sent yet, THE Chat_Session SHALL use a default sessionName of "新しいチャット"
4. THE Session_Name_Generator SHALL generate the session name on the client side using the first user message text (truncation or summarization)

### Requirement 5: セッション名の手動変更

**User Story:** As a ユーザー, I want セッション名を自分で変更できる, so that 分かりやすい名前を自由に付けられる。

#### Acceptance Criteria

1. WHEN a user double-clicks or activates the edit action on a session name in the sidebar, THE Session_History_Sidebar SHALL display an inline text input for editing
2. WHEN a user submits the edited session name, THE Chat_Session SHALL update the sessionName field in DynamoDB
3. IF the submitted session name exceeds 100 characters, THEN THE Session_History_Sidebar SHALL truncate the name to 100 characters and save the truncated value
4. IF the submitted session name is empty, THEN THE Session_History_Sidebar SHALL reject the edit and retain the previous sessionName

### Requirement 6: セッションの切り替えと状態管理

**User Story:** As a ユーザー, I want 過去のセッションと現在のセッションを自由に切り替えられる, so that 複数の会話を管理しやすい。

#### Acceptance Criteria

1. WHEN a user selects a past session from the sidebar, THE Active_Session SHALL switch to the selected session and load its messages into the chat area
2. WHEN a user switches sessions, THE Active_Session SHALL preserve the current session's state (messages remain in DynamoDB) without data loss
3. WHEN a user creates a new session via the sidebar button, THE Active_Session SHALL start a fresh chat session with the same connectionId and operationScope as the current session
4. WHILE viewing a past session, THE Session_History_Sidebar SHALL allow the user to send new messages that append to the existing session

### Requirement 7: セッションの削除

**User Story:** As a ユーザー, I want 不要なセッションを削除できる, so that 履歴を整理できる。

#### Acceptance Criteria

1. WHEN a user triggers the delete action on a session entry, THE Session_History_Sidebar SHALL display a confirmation prompt before deletion
2. WHEN the user confirms deletion, THE Chat_Session SHALL delete the session record and all associated Chat_Message records from DynamoDB
3. IF the deleted session is the Active_Session, THEN THE Session_History_Sidebar SHALL switch to the most recent remaining session or show the new session state
4. IF no sessions remain after deletion, THEN THE Session_History_Sidebar SHALL display an empty state with a prompt to start a new chat
