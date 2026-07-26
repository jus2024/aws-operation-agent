"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * MessageTimestampContext — メッセージ ID → 表示時刻（epoch ミリ秒）のレジストリ
 *
 * チャットの各メッセージ行に記録時刻（HH:MM）を表示するための、軽量な
 * メッセージ単位タイムスタンプ・レジストリを提供する React コンテキスト。
 * 2 つの時刻ソースを 1 つのレジストリに集約する:
 *
 * - 復元メッセージ（過去セッション）: AgentCore Memory の `eventTimestamp`
 *   （バックエンド `memoryRestore` が各メッセージへ `createdAt` として付与）を、
 *   `useSessionMemoryRestore` が復元時に `registerTimestamp(id, createdAt)` で登録する
 *   （1 秒解像度・保存時刻の「正確な時刻」）。
 * - ライブメッセージ（今送受信したターン）: AG-UI/CopilotKit の Message 型には
 *   タイムスタンプフィールドが無いため、クライアント側で「初回に観測した時刻」
 *   （first-seen = `Date.now()`）を `registerTimestamp` で登録する。
 *
 * 重要な不変条件: `registerTimestamp` は「まだ登録が無い ID のときだけ」値を設定する
 * （既存値を上書きしない）。これにより、ライブの first-seen 時刻が、後から/先に
 * 登録された復元の正確な時刻を上書きしてしまうことを防ぐ。
 *
 * 実装（2 つのコンテキストに分割する理由）:
 * - 値の保持は `useRef<Map<string, number>>`（レンダー間で安定）で行う。
 * - `ApiContext` は `{ getTimestamp, registerTimestamp }` を安定した参照で公開する。
 *   これを購読する副作用フック（`useSessionMemoryRestore` の復元登録や
 *   ライブ first-seen 検知）は、登録のたびに参照が変わらないため useEffect の
 *   依存に含めても再フェッチ/再実行ループを起こさない。
 * - `VersionContext` は新規エントリ追加時に bump するカウンタ。メッセージ行
 *   （`useMessageTime`）はこれを購読しており、新しい時刻が登録されると再レンダーして
 *   表示へ反映する。副作用側は VersionContext を購読しないため、登録が再フェッチを
 *   誘発しない。
 *
 * UI ロジックとインフラの分離方針に従い、このコンテキストは「id→時刻」の
 * 純粋な登録/参照のみを担い、接続構成やメッセージ状態管理には関与しない。
 */

interface MessageTimestampApi {
  /** 指定メッセージ ID の表示時刻（epoch ミリ秒）。未登録なら undefined。 */
  getTimestamp: (id: string) => number | undefined;
  /**
   * メッセージ ID に表示時刻（epoch ミリ秒）を登録する。
   * すでに登録済みの ID には何もしない（先勝ち = 復元の正確な時刻を優先）。
   * `id` が空、または `epochMs` が有限数でない場合も何もしない。
   */
  registerTimestamp: (id: string, epochMs: number) => void;
  /**
   * 「暦日の最初のメッセージ」である ID 集合を登録する（日付区切り行の描画用）。
   * 算出はメッセージ順の唯一の真実であるレンダー済みメッセージ配列を持つ
   * 副作用（page.tsx）側で行い、その結果集合をここへ格納する。
   * 集合が実質的に変化しない場合は state 更新をスキップして再レンダー/ループを避ける。
   */
  setDayStartIds: (ids: Set<string>) => void;
}

const MessageTimestampApiContext = createContext<MessageTimestampApi | null>(null);
const MessageTimestampVersionContext = createContext<number>(0);
// 「暦日の最初のメッセージ」ID 集合。メッセージ行（useIsFirstOfDay）が購読し、
// 集合が更新されると日付区切りの表示に反映される。
const MessageTimestampDayStartContext = createContext<Set<string>>(new Set());

/** 2 つの Set が同じ要素を持つか（順不同）。不要な state 更新を避けるため。 */
function sameStringSet(a: Set<string>, b: Set<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  return Array.from(a).every((value) => b.has(value));
}

export function MessageTimestampProvider({ children }: { children: ReactNode }) {
  const mapRef = useRef<Map<string, number>>(new Map());
  const [version, setVersion] = useState(0);
  const [dayStartIds, setDayStartIdsState] = useState<Set<string>>(
    () => new Set(),
  );

  const registerTimestamp = useCallback((id: string, epochMs: number) => {
    if (typeof id !== "string" || id.length === 0) return;
    if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return;
    // 先勝ち: 既に登録済みなら上書きしない（ライブ first-seen が復元の正確な
    // 時刻を上書きしないための不変条件）。
    if (mapRef.current.has(id)) return;
    mapRef.current.set(id, epochMs);
    // 新規エントリ追加時のみ、メッセージ行の再レンダーを促す。
    setVersion((v) => v + 1);
  }, []);

  const getTimestamp = useCallback((id: string) => mapRef.current.get(id), []);

  const setDayStartIds = useCallback((ids: Set<string>) => {
    // 実質的な変化が無ければ state を更新しない（副作用からの呼び出しで
    // 再レンダーが無限ループしないための不変条件）。
    setDayStartIdsState((prev) => (sameStringSet(prev, ids) ? prev : ids));
  }, []);

  // API 参照は安定させる（getTimestamp/registerTimestamp/setDayStartIds は
  // useCallback [] のため恒久的に同一）。副作用フックが依存に含めても
  // 再実行ループにならない。
  const api = useMemo<MessageTimestampApi>(
    () => ({ getTimestamp, registerTimestamp, setDayStartIds }),
    [getTimestamp, registerTimestamp, setDayStartIds],
  );

  return (
    <MessageTimestampApiContext.Provider value={api}>
      <MessageTimestampVersionContext.Provider value={version}>
        <MessageTimestampDayStartContext.Provider value={dayStartIds}>
          {children}
        </MessageTimestampDayStartContext.Provider>
      </MessageTimestampVersionContext.Provider>
    </MessageTimestampApiContext.Provider>
  );
}

/**
 * タイムスタンプ・レジストリの API（登録/参照）を返すフック。
 * 副作用（復元登録・ライブ first-seen 検知）から使う。参照が安定しているため
 * useEffect の依存に含めても再実行ループを起こさない。プロバイダー外では null。
 */
export function useMessageTimestamp(): MessageTimestampApi | null {
  return useContext(MessageTimestampApiContext);
}

/**
 * メッセージ行の描画用フック。指定 ID の表示時刻（epoch ミリ秒）を返し、
 * 新しい時刻が登録された際は（VersionContext を購読しているため）再レンダーする。
 * プロバイダー外、ID 未指定、未登録の場合は undefined を返す。
 */
export function useMessageTime(id: string | undefined): number | undefined {
  const api = useContext(MessageTimestampApiContext);
  // 新規登録時に再レンダーするため version を購読する（値自体は使わない）。
  useContext(MessageTimestampVersionContext);
  if (!api || typeof id !== "string" || id.length === 0) {
    return undefined;
  }
  return api.getTimestamp(id);
}

/**
 * レジストリのバージョン（新規タイムスタンプ登録のたびに増える単調カウンタ）を返す。
 * 日付区切り集合を算出する副作用（page.tsx）が、メッセージ配列に加えて
 * 「復元タイムスタンプが後から登録された」ことも検知して再計算するために購読する。
 */
export function useMessageTimestampVersion(): number {
  return useContext(MessageTimestampVersionContext);
}

/**
 * 指定メッセージ ID が「その暦日の最初のメッセージ」か否かを返すメッセージ行用フック。
 * `setDayStartIds` で登録された集合を購読し、集合が更新されると再レンダーする。
 * プロバイダー外、ID 未指定、集合に含まれない場合は false を返す。
 */
export function useIsFirstOfDay(id: string | undefined): boolean {
  const dayStartIds = useContext(MessageTimestampDayStartContext);
  if (typeof id !== "string" || id.length === 0) {
    return false;
  }
  return dayStartIds.has(id);
}

export default MessageTimestampProvider;
