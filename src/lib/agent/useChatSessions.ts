"use client";

import { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import { resolveSessionName, defaultSessionName } from "./sessionNameResolver";
import { buildChatSessionCreateInput } from "./chatMessagePersistence";

/**
 * チャットセッション管理フック
 *
 * セッションの一覧取得・作成・リネーム・削除・タッチを提供する。
 * 既存パターン（useConnectionCatalog / useConnectionAdmin）に従い、
 * generateClient<Schema>() と try/catch + { data, errors } レスポンスを使用する。
 *
 * Requirements: 1.1, 1.2, 1.3, 1.5, 5.2, 5.3, 5.4, 6.3, 7.2
 */

type ChatSession = Schema["ChatSession"]["type"];

export interface MutationResult<T = ChatSession> {
  data: T | null;
  error: string | null;
}

export interface UseChatSessionsResult {
  sessions: ChatSession[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  createSession: (input: {
    roleNames: string[];
    sessionName?: string;
  }) => Promise<MutationResult<ChatSession>>;
  renameSession: (
    id: string,
    candidateName: string,
  ) => Promise<MutationResult<ChatSession>>;
  deleteSession: (id: string) => Promise<MutationResult<{ id: string }>>;
  touchSession: (id: string) => Promise<void>;
}

export function useChatSessions(
  ownerUserId: string | null,
): UseChatSessionsResult {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    if (!ownerUserId) {
      setSessions([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const client = generateClient<Schema>();
      const { data, errors } =
        await client.models.ChatSession.listChatSessionByOwnerUpdatedAt(
          { ownerUserId },
          { sortDirection: "DESC" },
        );

      if (errors && errors.length > 0) {
        setError(errors.map((e) => e.message).join(", "));
        setSessions([]);
      } else {
        setSessions(data ?? []);
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "セッション一覧の取得に失敗しました";
      setError(message);
      setSessions([]);
    } finally {
      setIsLoading(false);
    }
  }, [ownerUserId]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const createSession = useCallback(
    async (input: {
      roleNames: string[];
      sessionName?: string;
    }): Promise<MutationResult<ChatSession>> => {
      if (!ownerUserId) {
        return { data: null, error: "ユーザーが認証されていません" };
      }

      try {
        const client = generateClient<Schema>();
        const createInput = buildChatSessionCreateInput({
          ownerUserId,
          roleNames: input.roleNames,
          sessionName: input.sessionName,
        });
        const { data, errors } =
          await client.models.ChatSession.create(createInput);

        if (errors && errors.length > 0) {
          return {
            data: null,
            error: errors.map((e) => e.message).join(", "),
          };
        }

        if (data) {
          setSessions((prev) => [data, ...prev]);
        }

        return { data: data ?? null, error: null };
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : "セッションの作成に失敗しました";
        return { data: null, error: message };
      }
    },
    [ownerUserId],
  );

  const renameSession = useCallback(
    async (
      id: string,
      candidateName: string,
    ): Promise<MutationResult<ChatSession>> => {
      try {
        const client = generateClient<Schema>();

        // 現在のセッション名を取得
        const { data: current, errors: getErrors } =
          await client.models.ChatSession.get({ id });

        if (getErrors && getErrors.length > 0) {
          return {
            data: null,
            error: getErrors.map((e) => e.message).join(", "),
          };
        }

        const currentName = current?.sessionName ?? defaultSessionName();
        const resolvedName = resolveSessionName(candidateName, currentName);

        const { data, errors } = await client.models.ChatSession.update({
          id,
          sessionName: resolvedName,
        });

        if (errors && errors.length > 0) {
          return {
            data: null,
            error: errors.map((e) => e.message).join(", "),
          };
        }

        if (data) {
          setSessions((prev) =>
            prev.map((s) => (s.id === id ? data : s)),
          );
        }

        return { data: data ?? null, error: null };
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : "セッション名の変更に失敗しました";
        return { data: null, error: message };
      }
    },
    [],
  );

  const deleteSession = useCallback(
    async (id: string): Promise<MutationResult<{ id: string }>> => {
      try {
        const client = generateClient<Schema>();

        // ChatSession レコードを削除する。
        // 発言内容の正のデータソースは AgentCore Memory に一本化されており、
        // DynamoDB 側にメッセージ本体（旧 ChatMessage）は保持しないため、
        // セッション削除時のメッセージクリーンアップは不要。
        const { data, errors } = await client.models.ChatSession.delete({
          id,
        });

        if (errors && errors.length > 0) {
          return {
            data: null,
            error: errors.map((e) => e.message).join(", "),
          };
        }

        setSessions((prev) => prev.filter((s) => s.id !== id));

        return { data: data ? { id: data.id } : null, error: null };
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : "セッションの削除に失敗しました";
        return { data: null, error: message };
      }
    },
    [],
  );

  const touchSession = useCallback(async (id: string): Promise<void> => {
    try {
      const client = generateClient<Schema>();
      await client.models.ChatSession.update({ id });
    } catch {
      // ベストエフォート: touchSession のエラーはサイレントに無視する
    }
  }, []);

  return {
    sessions,
    isLoading,
    error,
    refresh: fetchSessions,
    createSession,
    renameSession,
    deleteSession,
    touchSession,
  };
}
