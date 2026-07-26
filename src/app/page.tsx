"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useAgent, UseAgentUpdate } from "@copilotkit/react-core/v2";
import { useAuthenticator } from "@aws-amplify/ui-react";
import { fetchAuthSession } from "aws-amplify/auth";
import type { RoleInfo } from "@/src/lib/agent/roleInfo";
import { useRoles } from "@/src/lib/agent/useRoles";
import { CopilotProvider } from "@/src/lib/agent/CopilotProvider";
import { useChatSessions } from "@/src/lib/agent/useChatSessions";
import { useSessionMemoryRestore } from "@/src/lib/agent/useSessionMemoryRestore";
import { useSessionSubmitHandler } from "@/src/lib/agent/useSessionSubmitHandler";
import {
  resolveRestoredRoleSet,
  canSendInRestoredSession,
} from "@/src/lib/agent/useSessionRestore";
import {
  canAccessRoleConfigSettings,
  canAccessFeedbackDashboard,
} from "@/src/lib/agent/accessGates";
import { selectNextActiveSession } from "@/src/lib/agent/sessionSort";
import { RoleSetSelectorDialog } from "@/src/components/agent/RoleSetSelectorDialog";
import { RoleConfigManager } from "@/src/components/agent/RoleConfigManager";
import { FeedbackDashboardContainer } from "@/src/components/agent/FeedbackDashboardContainer";
import { SessionChat } from "@/src/components/agent/SessionChat";
import { ChatComposer } from "@/src/components/agent/ChatComposer";
import { ChatComposerProvider } from "@/src/components/agent/ChatComposerContext";
import { SessionHistorySidebar } from "@/src/components/agent/SessionHistorySidebar";
import {
  MessageFeedbackProvider,
  FeedbackAssistantMessage,
} from "@/src/components/agent/MessageFeedbackProvider";
import { BotIcon } from "@/src/components/agent/AgentIcons";
import {
  MessageTimestampProvider,
  useMessageTimestamp,
  useMessageTimestampVersion,
} from "@/src/components/agent/MessageTimestampContext";
import { toLocalDayKey } from "@/src/lib/agent/messageTime";
import { useVisualizationToolRender } from "@/src/components/agent/visualization/useVisualizationToolRender";
import type { RoleChip } from "@/src/components/agent/SessionHeader";

/**
 * チャット主画面
 *
 * 状態マシン（Role Set Switching 対応後）:
 *   [*] → unauthenticated
 *   unauthenticated → authenticated: ログイン
 *     （認証後は role_selection を経由せず、直接サイドバー + メイン画面に入る）
 *   authenticated(no_session) → dialog_open: 「+ 新規チャット」クリック
 *   dialog_open → session_active: Role_Set 確定（roleNames.length >= 1）
 *   dialog_open → authenticated(no_session): キャンセル
 *   session_active → dialog_open: 「+ 新規チャット」クリック（別セッションを新規作成）
 *   session_active → error: 復元した Role_Set が全て利用不可（Requirement 3.6）
 *
 * `dialog_open` はサイドバー + メイン画面の上に重ねるモーダルオーバーレイであり、
 * 全画面遷移ではない（design.md Component 10）。
 *
 * 過去セッション選択時のロール復元 (Requirement 3.4〜3.6):
 *   サイドバーで過去セッションを選択すると、そのセッションが記録していた
 *   roleNames（Role_Set）を resolveRestoredRoleSet で現在の Role_Config
 *   （useRoles() の roles）に対してローカル照合する。
 *   - available.length > 0: sessionState.roleNames を available の
 *     Role_Name に更新して送信を許可する。unavailableNames があれば
 *     欠落チップとして部分欠落を表示する（送信は継続可能）。
 *   - available.length === 0: 全欠落表示 + 送信禁止のエラー状態に遷移する。
 *     永続化された Role_Names 自体は変更しない。
 *
 * 管理者向け Role_Config メンテナンス画面リンク (Requirement 8.1, 8.2):
 *   ADMINS グループに属するユーザーにのみ、認証後常時表示されるリンクボタンを
 *   表示する。クリックすると RoleConfigManager をパネル/モーダルとして開く
 *   （新規サブページは作らない、`structure` ルール）。
 *
 * Requirements: 2.1, 2.4, 2.7, 3.1, 3.3, 3.4, 3.5, 3.6, 8.1, 8.2
 */

type AppState =
  | { kind: "unauthenticated" }
  | { kind: "no_session" }
  | { kind: "session_active"; roleNames: string[] }
  | { kind: "error"; message: string };

/**
 * 現在の sessionState の roleNames（有効な Role_Set）と unavailableNames
 * （欠落中の Role_Name）を、現在の Role_Config（roles）と照合して
 * SessionHeader 用の RoleChip[] を構築する。
 *
 * - roleNames の各要素は resolveRestoredRoleSet の available から来ているため
 *   通常は roles に必ず一致するが、念のため見つからない場合は
 *   missing チップとして扱う。
 * - unavailableNames はそのまま missing チップとして追加する（表示名は
 *   Role_Name 自体を使う。現在の Role_Config に存在しないため displayName が
 *   分からないため）。
 */
function buildRoleChips(
  roleNames: string[],
  unavailableNames: string[],
  roles: RoleInfo[],
): RoleChip[] {
  const byName = new Map(roles.map((r) => [r.name, r]));

  const availableChips: RoleChip[] = roleNames.map((name) => {
    const match = byName.get(name);
    if (match) {
      return {
        name: match.name,
        displayName: match.displayName,
        accountLabel: match.accountLabel,
        scope: match.scope,
      };
    }
    return { name, displayName: name, accountLabel: "", scope: "", missing: true };
  });

  const missingChips: RoleChip[] = unavailableNames.map((name) => ({
    name,
    displayName: name,
    accountLabel: "",
    scope: "",
    missing: true,
  }));

  return [...availableChips, ...missingChips];
}

/**
 * SessionChatWithPersistence — CopilotProvider 内でセッション関連の副作用フックを使用するラッパー
 *
 * CopilotProvider 内部に配置し、useAgent() にアクセスして
 * (1) AgentCore Memory からの会話履歴復元（useSessionMemoryRestore）と
 * (2) 最初のユーザーメッセージ送信時のセッション名自動生成（useSessionNameAutoGeneration）
 * を行う。
 *
 * DynamoDB `ChatMessage` への発言内容の書き込み（旧 `onNewMessage` 購読）は
 * 廃止済みであり、発言内容の正のデータソースは AgentCore Memory に一本化されている
 * （Requirement 1.2, 4.1）。
 */
function SessionChatWithPersistence({
  activeSessionId,
  ownerUserId,
  renameSession,
  touchSession,
  roleChips,
  onNewSession,
}: {
  activeSessionId: string | null;
  ownerUserId: string | null;
  renameSession: (id: string, name: string) => Promise<unknown>;
  touchSession: (id: string) => Promise<void>;
  roleChips: RoleChip[];
  onNewSession: () => void;
}) {
  // セッション切替時の会話履歴復元は AgentCore Memory からの読み出しに一本化する
  // （DynamoDB ChatMessage への読み書きは行わない）。Memory は既に時系列順で
  // イベントを返すため、フロントエンド側での再ソートは不要。
  const { error: memoryRestoreError, retry: retryMemoryRestore } = useSessionMemoryRestore({
    activeSessionId,
  });

  // ライブ（今送受信した）ターンの「初回観測時刻（first-seen）」を、メッセージ単位
  // タイムスタンプ・レジストリへ登録する。AG-UI/CopilotKit の Message 型には
  // タイムスタンプが無いため、まだ登録の無いメッセージ id に対して Date.now() を
  // 記録する（復元済みの正確な時刻は registerTimestamp の先勝ちで保持される）。
  // このコンポーネントは MessageTimestampProvider 配下（page.tsx で結線）で実行される。
  const { agent: timestampAgent } = useAgent({
    agentId: "sample_agent",
    updates: [UseAgentUpdate.OnMessagesChanged],
  });
  const timestampRegistry = useMessageTimestamp();
  const liveMessages = timestampAgent?.messages;
  // レジストリのバージョンを購読し、復元タイムスタンプが（setMessages 直前に）
  // 後から登録されたケースでも日付区切り集合を再計算できるようにする。
  const timestampVersion = useMessageTimestampVersion();

  useEffect(() => {
    if (!timestampRegistry || !liveMessages) return;

    // (1) ライブターンの first-seen 時刻を登録する（先勝ちで復元の正確な時刻を保持）。
    const now = Date.now();
    for (const message of liveMessages) {
      if (message.id && timestampRegistry.getTimestamp(message.id) === undefined) {
        timestampRegistry.registerTimestamp(message.id, now);
      }
    }

    // (2) 日付区切り集合を算出する。メッセージ順（= レンダー順の真実）に走査し、
    //     各メッセージの登録済みタイムスタンプからローカル暦日キーを引く。
    //     タイムスタンプ未登録の id はスキップ（日付起点にしない = 捏造しない）。
    //     直前の非スキップメッセージと暦日キーが異なるとき、その id を
    //     「その暦日の最初のメッセージ」として集合へ加える（最初の時刻付き
    //     メッセージは常に起点）。復元時刻は registerTimestamp の先勝ちで
    //     既に格納済みのため、この走査は現行レジストリのスナップショットを反映する。
    const dayStartIds = new Set<string>();
    let prevDayKey: string | null = null;
    for (const message of liveMessages) {
      const id = message.id;
      if (!id) continue;
      const ts = timestampRegistry.getTimestamp(id);
      if (ts === undefined) continue;
      const dayKey = toLocalDayKey(ts);
      if (dayKey === "") continue;
      if (dayKey !== prevDayKey) {
        dayStartIds.add(id);
        prevDayKey = dayKey;
      }
    }
    timestampRegistry.setDayStartIds(dayStartIds);
    // timestampVersion を依存に含めることで、復元タイムスタンプの後追い登録
    // （version bump）でも再計算される。setDayStartIds は等価集合なら state を
    // 更新しないため、無限ループにはならない。
  }, [timestampRegistry, liveMessages, timestampVersion]);

  // Generative UI: Agent が `emit_visualization` ツールで送出した可視化ペイロードを
  // CopilotChat のレンダリングに配線する（parseVisualization を通して描画、検証失敗時も
  // メッセージ残部の描画を継続）。CopilotProvider 配下でのみ有効なフックのため、
  // ここ（SessionChatWithPersistence）で呼び出す（Req 1.1, 1.5, 8.2, 8.3）。
  useVisualizationToolRender();

  // メッセージ送信時のハンドラー（`CopilotChat` の `onSubmitMessage` に中継）:
  // (a) 最初のユーザーメッセージ送信時のセッション名自動生成と、(b) 毎回の
  // ユーザー送信での `ChatSession.updatedAt` 更新（touchSession）を1つの
  // コールバックに合成する。合成の詳細・順序・分離原則は
  // `useSessionSubmitHandler.ts` のコメント参照。いずれも DynamoDB の
  // `ChatSession` メタデータ更新のみで、発言内容の書き込み（ChatMessage）や
  // AgentCore Memory への結合は一切行わない（Requirement 1.3）。
  const { handleSubmitMessage } = useSessionSubmitHandler({
    activeSessionId,
    renameSession,
    touchSession,
  });

  // Feedback フローの配線: Good/Bad 押下・Bad コメントダイアログ・sentiment 遷移・
  // 永続化エラー表示を MessageFeedbackProvider に集約し、CopilotChat の各
  // アシスタントメッセージへ FeedbackAssistantMessage 経由で Feedback_Control を
  // 統合する（Task 6.4, Req 2.2–2.5, 3.6）。エラー状態（error あり）のときは
  // CopilotChat を描画しないため、Feedback 配線も不要。
  if (memoryRestoreError || !activeSessionId) {
    return (
      <ChatComposerProvider value={{ onUserSubmit: handleSubmitMessage }}>
        <SessionChat
          roleChips={roleChips}
          onNewSession={onNewSession}
          error={memoryRestoreError}
          onRetry={memoryRestoreError ? retryMemoryRestore : undefined}
          onSubmitMessage={handleSubmitMessage}
          Input={ChatComposer}
        />
      </ChatComposerProvider>
    );
  }

  return (
    <ChatComposerProvider value={{ onUserSubmit: handleSubmitMessage }}>
      <MessageFeedbackProvider
        ownerUserId={ownerUserId}
        chatSessionId={activeSessionId}
      >
        <SessionChat
          roleChips={roleChips}
          onNewSession={onNewSession}
          onSubmitMessage={handleSubmitMessage}
          AssistantMessage={FeedbackAssistantMessage}
          Input={ChatComposer}
        />
      </MessageFeedbackProvider>
    </ChatComposerProvider>
  );
}

export default function Home() {
  const { authStatus } = useAuthenticator((ctx) => [ctx.authStatus]);
  const { roles, isLoading: isRolesLoading, refetch: refetchRoles } = useRoles();

  const [sessionState, setSessionState] = useState<{ roleNames: string[] } | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // 過去セッション復元時、記録されていた roleNames の一部/全部が現在の
  // Role_Config に存在しなかった場合の欠落中 Role_Name（Requirement 3.5, 3.6）
  const [unavailableNames, setUnavailableNames] = useState<string[]>([]);

  // ユーザー ID（Cognito sub）
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);

  // Cognito グループ（cognito:groups クレーム、管理者向けリンクの表示制御に使用）
  const [groups, setGroups] = useState<string[]>([]);

  // アクティブセッション ID
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // サイドバー折りたたみ状態
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // RoleSetSelectorDialog の開閉状態（新規チャット開始用オーバーレイ）
  const [dialogOpen, setDialogOpen] = useState(false);

  // RoleConfigManager（ADMINS 専用メンテナンス画面）の開閉状態
  const [showRoleConfigManager, setShowRoleConfigManager] = useState(false);

  // Feedback_Dashboard（フィードバック集計画面）の開閉状態。
  // 全認証ユーザーに開放するオーバーレイ表示（Req 5.1, 5.3, 8.6）。
  const [showFeedbackDashboard, setShowFeedbackDashboard] = useState(false);

  // 初回ロード時に最新セッションを自動選択したかどうか（一度だけ実行するためのガード）
  const autoSelectedRef = useRef(false);

  // Cognito sub / cognito:groups を取得
  useEffect(() => {
    let cancelled = false;

    async function loadUserIdentity() {
      try {
        const session = await fetchAuthSession();
        const sub = session.tokens?.idToken?.payload?.sub as string | undefined;
        const rawGroups = session.tokens?.idToken?.payload?.["cognito:groups"];
        if (!cancelled) {
          if (sub) setOwnerUserId(sub);
          setGroups(Array.isArray(rawGroups) ? rawGroups.map(String) : []);
        }
      } catch {
        // 未認証時は null/空のまま
      }
    }

    if (authStatus === "authenticated") {
      loadUserIdentity();
    } else {
      setOwnerUserId(null);
      setGroups([]);
    }

    return () => {
      cancelled = true;
    };
  }, [authStatus]);

  // セッション管理フック
  const {
    sessions,
    isLoading: isSessionsLoading,
    createSession,
    renameSession,
    deleteSession,
    touchSession,
  } = useChatSessions(ownerUserId);

  // 状態マシンの決定
  const appState: AppState = (() => {
    if (authStatus !== "authenticated") {
      return { kind: "unauthenticated" };
    }
    if (sessionError) {
      return { kind: "error", message: sessionError };
    }
    if (sessionState) {
      return { kind: "session_active", roleNames: sessionState.roleNames };
    }
    return { kind: "no_session" };
  })();

  // サイドバー: 過去セッション選択時のロール復元（Requirement 3.4〜3.6）
  //
  // 選択された ChatSession が記録していた roleNames（Role_Set）を、
  // resolveRestoredRoleSet で現在の Role_Config（useRoles() の roles）に
  // 対してローカル照合する（同期的な純粋関数、API 呼び出し不要）。
  // - available.length > 0: sessionState.roleNames を available の
  //   Role_Name に更新し、送信を許可する。unavailableNames があれば
  //   部分欠落インジケーターを表示する。
  // - available.length === 0: 送信をブロックしたエラー状態に遷移する。
  const handleSelectSession = useCallback(
    (sessionId: string) => {
      const selectedSession = sessions.find((s) => s.id === sessionId);
      if (!selectedSession) {
        // サイドバーに表示されているセッション一覧から選択されたはずなので通常到達しないが、
        // 一覧の再取得タイミングとの競合に備えてガードする。
        setSessionError("選択されたセッションが見つかりません。");
        setUnavailableNames([]);
        setSessionState(null);
        setActiveSessionId(sessionId);
        return;
      }

      const storedRoleNames = (selectedSession.roleNames ?? []).filter(
        (name): name is string => typeof name === "string",
      );
      const result = resolveRestoredRoleSet(storedRoleNames, roles);

      if (!canSendInRestoredSession(result)) {
        // 全欠落: 送信禁止のエラー状態に遷移する（Requirement 3.6）。
        // 永続化された roleNames 自体は変更しない。
        setSessionState(null);
        setUnavailableNames(storedRoleNames);
        setSessionError("元のロールがすべて見つかりません。このセッションでは送信できません。");
        setActiveSessionId(sessionId);
        return;
      }

      // 一部/全部が利用可能: sessionState を有効な Role_Set に更新し送信を許可する
      // （Requirement 3.5）。
      setSessionError(null);
      setSessionState({ roleNames: result.available.map((r) => r.name) });
      setUnavailableNames(result.unavailableNames);
      setActiveSessionId(sessionId);
    },
    [sessions, roles],
  );

  // 初回ロード時に最新セッション（sessions[0]、updatedAt 降順）を自動選択する。
  // ロールとセッション一覧の読み込みが完了してから一度だけ実行する。
  useEffect(() => {
    if (authStatus !== "authenticated") return;
    if (autoSelectedRef.current) return;
    if (activeSessionId) return;
    if (isSessionsLoading || isRolesLoading) return;
    if (sessions.length === 0) return;

    autoSelectedRef.current = true;
    handleSelectSession(sessions[0].id);
  }, [authStatus, activeSessionId, isSessionsLoading, isRolesLoading, sessions, handleSelectSession]);

  // RoleSetSelectorDialog を開く（「+ 新規チャット」クリック、または空状態のボタン）
  const handleOpenDialog = useCallback(() => {
    refetchRoles();
    setDialogOpen(true);
  }, [refetchRoles]);

  const handleCancelDialog = useCallback(() => {
    setDialogOpen(false);
  }, []);

  // RoleSetSelectorDialog で Role_Set を確定した際に Chat_Session を作成する
  const handleConfirmDialog = useCallback(
    async (roleNames: string[], sessionName?: string) => {
      setDialogOpen(false);
      const result = await createSession({ roleNames, sessionName });
      if (result.data) {
        setSessionError(null);
        setUnavailableNames([]);
        setSessionState({ roleNames });
        setActiveSessionId(result.data.id);
      } else if (result.error) {
        setSessionError(result.error);
      }
    },
    [createSession],
  );

  // サイドバー: セッション削除
  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      const result = await deleteSession(sessionId);
      if (result.error) return;

      // 削除したのがアクティブセッションの場合、次のセッションを選択
      if (sessionId === activeSessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        const next = selectNextActiveSession(
          remaining.map((s) => ({ id: s.id, updatedAt: s.updatedAt ?? "" })),
        );
        if (next) {
          handleSelectSession(next.id);
        } else {
          setActiveSessionId(null);
          setSessionState(null);
          setSessionError(null);
          setUnavailableNames([]);
        }
      }
    },
    [deleteSession, activeSessionId, sessions, handleSelectSession],
  );

  // サイドバー: セッションリネーム
  const handleRenameSession = useCallback(
    async (sessionId: string, name: string) => {
      await renameSession(sessionId, name);
    },
    [renameSession],
  );

  // サイドバー折りたたみトグル
  const handleToggleCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  // 未認証状態
  if (appState.kind === "unauthenticated") {
    return null;
  }

  const canAccessAdmin = canAccessRoleConfigSettings(groups);
  // Feedback_Dashboard は認証済みの全ユーザーに開放する（ADMINS ゲートは掛けない）。
  const canViewFeedbackDashboard = canAccessFeedbackDashboard(
    authStatus === "authenticated",
  );

  // メイン画面（サイドバー右側）の内容を決定する。
  function renderMainPane() {
    if (appState.kind === "error") {
      return (
        <SessionChat
          roleChips={buildRoleChips(sessionState?.roleNames ?? [], unavailableNames, roles)}
          onNewSession={handleOpenDialog}
          error={appState.message}
        />
      );
    }

    if (appState.kind === "session_active" && activeSessionId) {
      return (
        <CopilotProvider roleNames={appState.roleNames} threadId={activeSessionId}>
          {/* メッセージ単位タイムスタンプ・レジストリを CopilotProvider 配下に置く。
              SessionChatWithPersistence（復元登録・ライブ first-seen 検知の副作用）と
              その配下の CopilotChat メッセージ行（時刻表示）の双方がこのプロバイダーの
              内側で実行される。 */}
          <MessageTimestampProvider>
            <SessionChatWithPersistence
              activeSessionId={activeSessionId}
              ownerUserId={ownerUserId}
              renameSession={renameSession}
              touchSession={touchSession}
              roleChips={buildRoleChips(appState.roleNames, unavailableNames, roles)}
              onNewSession={handleOpenDialog}
            />
          </MessageTimestampProvider>
        </CopilotProvider>
      );
    }

    // no_session: セッション0件時の空状態表示（Requirement 2.1, 2.7）
    if (!isSessionsLoading && sessions.length === 0) {
      return (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: "1rem",
            color: "var(--color-text-secondary, #6b7280)",
          }}
        >
          <p style={{ fontSize: "1rem" }}>チャットセッションがありません</p>
          <button
            type="button"
            onClick={handleOpenDialog}
            style={{
              padding: "0.6rem 1.2rem",
              border: "1px solid var(--color-primary, #0073bb)",
              borderRadius: "var(--radius, 0.5rem)",
              backgroundColor: "var(--color-primary, #0073bb)",
              color: "#ffffff",
              fontSize: "0.9rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            新規チャットを開始
          </button>
        </div>
      );
    }

    // セッション一覧の読み込み中、または自動選択待ち
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-text-secondary, #6b7280)",
          fontSize: "0.9rem",
        }}
      >
        読み込み中...
      </div>
    );
  }

  return (
    <main
      style={{
        margin: "0 auto",
        padding: "0",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* アプリトップバー（mocks/chat.html の .topbar / .brand を踏襲）。
          左: ブランドマーク + タイトル + サブタイトル。
          右: フィードバック集計（全認証ユーザー）と ADMINS 限定のロール設定管理。
          従来この 2 ボタンは position: fixed の右上に置いていたが、トップバー内へ
          移設した（Req 5.3, 8.6）。RoleConfig の ADMINS ゲート（canAccessAdmin）は
          従来どおり維持する。 */}
      <header
        role="banner"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          padding: "0.75rem 1.5rem",
          backgroundColor: "var(--color-surface)",
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            minWidth: 0,
          }}
        >
          {/* ブランドマーク: アシスタントアバターと同じ円形フレームに共通の
              BotIcon を白で内接させる。ブランドの塗り（ブランドグラデーション）と
              グリフはアバターと共有し、サイズと配置だけを変えて差別化する。
              アバター（.msg__avatar）と同じ border-radius: var(--radius-pill) の
              円形にし、アイコンは枠の ~60% に収めて内接させる。 */}
          <div
            aria-hidden="true"
            style={{
              width: "34px",
              height: "34px",
              borderRadius: "var(--radius-pill)",
              display: "grid",
              placeItems: "center",
              background:
                "linear-gradient(135deg, var(--color-primary), #00a0dc)",
              color: "#ffffff",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: "60%",
                height: "60%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <BotIcon />
            </div>
          </div>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: "0.98rem",
                fontWeight: 600,
                whiteSpace: "nowrap",
                color: "var(--color-text)",
              }}
            >
              AWS運用アシスタント
            </div>
            <div
              style={{
                fontSize: "0.75rem",
                color: "var(--color-text-secondary)",
                whiteSpace: "nowrap",
              }}
            >
              AWS 環境の調査・可視化・運用支援
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          {/* フィードバック集計ボタン: 認証済みの全ユーザーに表示する
              （ADMINS ゲートを掛けない、Req 5.1, 8.6）。 */}
          {canViewFeedbackDashboard && (
            <button
              type="button"
              onClick={() => setShowFeedbackDashboard(true)}
              aria-label="フィードバック集計を開く"
              style={{
                fontSize: "0.75rem",
                fontWeight: 500,
                padding: "0.375rem 0.75rem",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--color-border-strong)",
                backgroundColor: "var(--color-surface)",
                color: "var(--color-text)",
                cursor: "pointer",
                boxShadow: "var(--shadow-sm)",
                whiteSpace: "nowrap",
              }}
            >
              フィードバック集計
            </button>
          )}

          {/* 認証後常時表示の管理者向け Role_Config メンテナンス画面リンク。
              ADMINS グループに属さないユーザーには描画しない（Requirement 8.1）。 */}
          {canAccessAdmin && (
            <button
              type="button"
              onClick={() => setShowRoleConfigManager(true)}
              aria-label="ロール設定管理を開く"
              style={{
                fontSize: "0.75rem",
                fontWeight: 500,
                padding: "0.375rem 0.75rem",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--color-border-strong)",
                backgroundColor: "var(--color-surface)",
                color: "var(--color-text)",
                cursor: "pointer",
                boxShadow: "var(--shadow-sm)",
                whiteSpace: "nowrap",
              }}
            >
              ロール設定管理
            </button>
          )}
        </div>
      </header>

      {/* 本体: サイドバー + メインペインの横並び行（従来のレイアウト）。 */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "row",
          overflow: "hidden",
          minHeight: 0,
        }}
      >
        <SessionHistorySidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          isLoading={isSessionsLoading}
          onSelectSession={handleSelectSession}
          onCreateSession={handleOpenDialog}
          onRenameSession={handleRenameSession}
          onDeleteSession={handleDeleteSession}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
        />
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            minWidth: 0,
            position: "relative",
          }}
        >
          {renderMainPane()}
        </div>
      </div>

      <RoleSetSelectorDialog
        isOpen={dialogOpen}
        roles={roles}
        isLoading={isRolesLoading}
        onConfirm={handleConfirmDialog}
        onCancel={handleCancelDialog}
      />

      {showRoleConfigManager && (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0, 0, 0, 0.4)",
            padding: "1rem",
            overflowY: "auto",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: "48rem",
              maxHeight: "90vh",
              overflowY: "auto",
              borderRadius: "var(--radius, 0.5rem)",
              backgroundColor: "var(--color-surface, #ffffff)",
              boxShadow: "0 10px 25px rgba(0, 0, 0, 0.15)",
            }}
          >
            <RoleConfigManager
              groups={groups}
              onClose={() => setShowRoleConfigManager(false)}
            />
          </div>
        </div>
      )}

      {/* フィードバック集計ダッシュボードのオーバーレイ。RoleConfigManager と
          同じオーバーレイパターンで主画面上に重ねて表示する（新規サブページは
          作らない、Req 5.3, 8.1）。 */}
      {showFeedbackDashboard && (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0, 0, 0, 0.4)",
            padding: "1rem",
            overflowY: "auto",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: "72rem",
              maxHeight: "90vh",
              overflowY: "auto",
              borderRadius: "var(--radius, 0.5rem)",
              backgroundColor: "var(--color-surface, #ffffff)",
              boxShadow: "0 10px 25px rgba(0, 0, 0, 0.15)",
            }}
          >
            <FeedbackDashboardContainer
              onClose={() => setShowFeedbackDashboard(false)}
            />
          </div>
        </div>
      )}
    </main>
  );
}
