"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { formatRelativeTime } from "@/src/lib/agent/relativeTime";

/**
 * SessionHistorySidebar — チャットセッション履歴サイドバー
 *
 * セッション一覧を表示し、選択・新規作成・リネーム・削除を提供する。
 * collapsed 状態でのトグル表示（レスポンシブ対応）にも対応。
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 5.1, 5.2, 7.1
 */

export interface SessionHistorySidebarProps {
  sessions: Array<{
    id: string;
    sessionName: string | null;
    updatedAt: string | null;
  }>;
  activeSessionId: string | null;
  isLoading: boolean;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onRenameSession: (sessionId: string, name: string) => void;
  onDeleteSession: (sessionId: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function SessionHistorySidebar({
  sessions,
  activeSessionId,
  isLoading,
  onSelectSession,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
  collapsed,
  onToggleCollapsed,
}: SessionHistorySidebarProps) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);

  // Focus input when editing starts
  useEffect(() => {
    if (editingSessionId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingSessionId]);

  const handleStartEdit = useCallback(
    (sessionId: string, currentName: string) => {
      setEditingSessionId(sessionId);
      setEditingValue(currentName);
    },
    [],
  );

  const handleEditConfirm = useCallback(() => {
    if (editingSessionId && editingValue.trim()) {
      onRenameSession(editingSessionId, editingValue);
    }
    setEditingSessionId(null);
    setEditingValue("");
  }, [editingSessionId, editingValue, onRenameSession]);

  const handleEditCancel = useCallback(() => {
    setEditingSessionId(null);
    setEditingValue("");
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !isComposingRef.current) {
        e.preventDefault();
        handleEditConfirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleEditCancel();
      }
    },
    [handleEditConfirm, handleEditCancel],
  );

  const handleDelete = useCallback(
    (sessionId: string) => {
      const confirmed = window.confirm("このセッションを削除しますか？");
      if (confirmed) {
        onDeleteSession(sessionId);
      }
    },
    [onDeleteSession],
  );

  // Collapsed state: show only toggle button
  if (collapsed) {
    return (
      <div
        style={{
          width: "48px",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: "0.75rem",
          borderRight: "1px solid var(--color-border, #e0e0e0)",
          backgroundColor: "var(--color-surface, #ffffff)",
        }}
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="サイドバーを展開"
          title="サイドバーを展開"
          style={{
            width: "36px",
            height: "36px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            borderRadius: "var(--radius, 0.5rem)",
            backgroundColor: "transparent",
            cursor: "pointer",
            color: "var(--color-text-secondary, #555)",
            fontSize: "1.2rem",
          }}
        >
          ☰
        </button>
      </div>
    );
  }

  // Expanded state: full sidebar
  return (
    <div
      style={{
        width: "280px",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid var(--color-border, #e0e0e0)",
        backgroundColor: "var(--color-surface, #ffffff)",
        overflow: "hidden",
      }}
    >
      {/* Header: New session button + collapse toggle */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.75rem",
          borderBottom: "1px solid var(--color-border, #e0e0e0)",
        }}
      >
        <button
          type="button"
          onClick={onCreateSession}
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.4rem",
            padding: "0.5rem 0.75rem",
            border: "1px solid var(--color-primary, #0073bb)",
            borderRadius: "var(--radius, 0.5rem)",
            backgroundColor: "var(--color-primary, #0073bb)",
            color: "#ffffff",
            fontSize: "0.85rem",
            fontWeight: 500,
            cursor: "pointer",
            transition: "opacity 0.15s",
          }}
        >
          + 新規チャット
        </button>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="サイドバーを折りたたむ"
          title="サイドバーを折りたたむ"
          style={{
            width: "32px",
            height: "32px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            borderRadius: "var(--radius, 0.5rem)",
            backgroundColor: "transparent",
            cursor: "pointer",
            color: "var(--color-text-secondary, #555)",
            fontSize: "1rem",
          }}
        >
          ◀
        </button>
      </div>

      {/* Session list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "0.5rem",
        }}
      >
        {isLoading && (
          <div
            role="status"
            aria-label="読み込み中"
            style={{
              padding: "1rem",
              color: "var(--color-text-secondary, #6b7280)",
              textAlign: "center",
              fontSize: "0.85rem",
            }}
          >
            読み込み中...
          </div>
        )}

        {!isLoading && sessions.length === 0 && (
          <div
            role="status"
            style={{
              padding: "1rem",
              color: "var(--color-text-secondary, #6b7280)",
              textAlign: "center",
              fontSize: "0.85rem",
            }}
          >
            セッション履歴がありません
          </div>
        )}

        {!isLoading && sessions.length > 0 && (
          <ul
            role="listbox"
            aria-label="チャットセッション一覧"
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.25rem",
            }}
          >
            {sessions.map((session) => {
              const isActive = activeSessionId === session.id;
              const isEditing = editingSessionId === session.id;
              const displayName = session.sessionName || "新しいチャット";
              const timeLabel = session.updatedAt
                ? formatRelativeTime(session.updatedAt)
                : "";

              return (
                <li
                  key={session.id}
                  role="option"
                  aria-selected={isActive}
                  tabIndex={0}
                  onClick={() => {
                    if (!isEditing) {
                      onSelectSession(session.id);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (
                      !isEditing &&
                      (e.key === "Enter" || e.key === " ")
                    ) {
                      e.preventDefault();
                      onSelectSession(session.id);
                    }
                  }}
                  style={{
                    padding: "0.6rem 0.75rem",
                    borderRadius: "var(--radius, 0.5rem)",
                    border: `1px solid ${
                      isActive
                        ? "var(--color-primary, #0073bb)"
                        : "transparent"
                    }`,
                    backgroundColor: isActive
                      ? "color-mix(in srgb, var(--color-primary, #0073bb) 8%, var(--color-surface, #ffffff))"
                      : "transparent",
                    cursor: "pointer",
                    transition:
                      "border-color 0.15s, background-color 0.15s",
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "0.5rem",
                    }}
                  >
                    {/* Session name or inline edit input */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {isEditing ? (
                        <input
                          ref={inputRef}
                          type="text"
                          value={editingValue}
                          onChange={(e) =>
                            setEditingValue(e.target.value)
                          }
                          onBlur={handleEditConfirm}
                          onKeyDown={handleKeyDown}
                          onCompositionStart={() => {
                            isComposingRef.current = true;
                          }}
                          onCompositionEnd={() => {
                            isComposingRef.current = false;
                          }}
                          aria-label="セッション名を編集"
                          style={{
                            width: "100%",
                            padding: "0.2rem 0.4rem",
                            fontSize: "0.85rem",
                            border:
                              "1px solid var(--color-primary, #0073bb)",
                            borderRadius: "0.25rem",
                            backgroundColor:
                              "var(--color-surface, #ffffff)",
                            color: "var(--color-text, #1a1a2e)",
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            fontSize: "0.85rem",
                            fontWeight: isActive ? 600 : 400,
                            color: "var(--color-text, #1a1a2e)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {displayName}
                        </div>
                      )}

                      {/* Updated time */}
                      {!isEditing && timeLabel && (
                        <div
                          style={{
                            fontSize: "0.75rem",
                            color:
                              "var(--color-text-secondary, #6b7280)",
                            marginTop: "0.15rem",
                          }}
                        >
                          {timeLabel}
                        </div>
                      )}
                    </div>

                    {/* Rename & Delete buttons */}
                    {!isEditing && (
                      <div style={{ display: "flex", alignItems: "center", gap: "0.125rem", flexShrink: 0 }}>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartEdit(session.id, displayName);
                          }}
                          aria-label={`${displayName} の名前を変更`}
                          title="名前を変更"
                          style={{
                            width: "24px",
                            height: "24px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            border: "none",
                            borderRadius: "0.25rem",
                            backgroundColor: "transparent",
                            cursor: "pointer",
                            color:
                              "var(--color-text-secondary, #6b7280)",
                            fontSize: "0.8rem",
                            opacity: 0.6,
                            transition: "opacity 0.15s",
                          }}
                          onMouseEnter={(e) => {
                            (
                              e.currentTarget as HTMLButtonElement
                            ).style.opacity = "1";
                          }}
                          onMouseLeave={(e) => {
                            (
                              e.currentTarget as HTMLButtonElement
                            ).style.opacity = "0.6";
                          }}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(session.id);
                          }}
                          aria-label={`${displayName} を削除`}
                          title="セッションを削除"
                          style={{
                            width: "24px",
                            height: "24px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            border: "none",
                            borderRadius: "0.25rem",
                            backgroundColor: "transparent",
                            cursor: "pointer",
                            color:
                              "var(--color-text-secondary, #6b7280)",
                            fontSize: "0.9rem",
                            opacity: 0.6,
                            transition: "opacity 0.15s",
                          }}
                          onMouseEnter={(e) => {
                            (
                              e.currentTarget as HTMLButtonElement
                            ).style.opacity = "1";
                          }}
                          onMouseLeave={(e) => {
                            (
                              e.currentTarget as HTMLButtonElement
                            ).style.opacity = "0.6";
                          }}
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default SessionHistorySidebar;
