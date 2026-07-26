"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAuthSession } from "aws-amplify/auth";
import type { RoleInfo } from "@/src/lib/agent/roleInfo";

/**
 * 利用可能ロール一覧を取得するフック
 *
 * `GET /api/roles` を呼び出し、サーバーサイドの `AGENT_ROLES` 設定から
 * 導出された `RoleInfo[]`（name, displayName, scope）を返す。
 *
 * 認証は Amplify の Cognito トークンを Bearer ヘッダーとして付与する
 * （`CopilotProvider` と同じパターン）。
 *
 * Requirements: 1.4, 10.1
 */

export type { RoleInfo };

export interface UseRolesResult {
  roles: RoleInfo[];
  isLoading: boolean;
  error: string | null;
  /** ロール一覧を再取得する */
  refetch: () => void;
}

export function useRoles(): UseRolesResult {
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const refetch = useCallback(() => {
    setRefreshToken((prev) => prev + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadRoles() {
      setIsLoading(true);
      setError(null);

      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.accessToken?.toString();

        if (!token) {
          if (!cancelled) {
            setRoles([]);
            setError("認証情報を取得できませんでした");
            setIsLoading(false);
          }
          return;
        }

        const response = await fetch("/api/roles", {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          if (!cancelled) {
            setRoles([]);
            setError(
              response.status === 401
                ? "認証に失敗しました"
                : "ロール一覧の取得に失敗しました",
            );
            setIsLoading(false);
          }
          return;
        }

        const data = (await response.json()) as { roles?: RoleInfo[] };

        if (!cancelled) {
          setRoles(Array.isArray(data.roles) ? data.roles : []);
          setError(null);
          setIsLoading(false);
        }
      } catch {
        if (!cancelled) {
          setRoles([]);
          setError("ロール一覧の取得に失敗しました");
          setIsLoading(false);
        }
      }
    }

    loadRoles();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return { roles, isLoading, error, refetch };
}
