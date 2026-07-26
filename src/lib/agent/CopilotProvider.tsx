"use client";

import { CopilotKit } from "@copilotkit/react-core/v2";
import { fetchAuthSession } from "aws-amplify/auth";
import { useState, useEffect, useMemo, type ReactNode } from "react";
import { buildCopilotProperties } from "./copilotProperties";

interface CopilotProviderProps {
  children: ReactNode;
  /** 選択された Role_Set の Role_Name 配列（セッションコンテキスト伝播用） */
  roleNames?: string[];
  /** CopilotKit スレッド ID（セッション ID をマッピング） */
  threadId?: string;
}

/**
 * CopilotKit を Next.js API Route 経由で AgentCore Runtime に接続するプロバイダー。
 *
 * /api/copilotkit が CopilotKit Runtime として動作し、AgentCore Runtime にプロキシする。
 * 認証は Amplify の Cognito トークンを Bearer ヘッダーとして渡す。
 *
 * roleNames は CopilotKit の properties メカニズムを通じてリクエストボディに含まれ、
 * API Route がセッションコンテキストヘッダーに変換する。
 * Requirements: 6.3, 9.6
 */
export function CopilotProvider({
  children,
  roleNames,
  threadId,
}: CopilotProviderProps) {
  const [headers, setHeaders] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadToken() {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.accessToken?.toString();
        if (!cancelled) {
          setHeaders(
            token ? { Authorization: `Bearer ${token}` } : {},
          );
        }
      } catch {
        if (!cancelled) {
          setHeaders({});
        }
      }
    }

    loadToken();
    return () => { cancelled = true; };
  }, []);

  // roleNames をリクエストボディの properties として送信
  const properties = useMemo(
    () => buildCopilotProperties(roleNames),
    [roleNames],
  );

  if (headers === null) {
    return (
      <div style={{ padding: "1rem", color: "#6b7280", fontSize: "0.9rem" }}>
        認証情報を取得中...
      </div>
    );
  }

  return (
    <CopilotKit
      runtimeUrl={process.env.NEXT_PUBLIC_COPILOTKIT_RELAY_URL}
      headers={headers}
      properties={properties}
      agent="sample_agent"
      threadId={threadId}
    >
      {children}
    </CopilotKit>
  );
}
