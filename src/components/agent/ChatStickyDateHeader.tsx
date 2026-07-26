"use client";

import { useEffect, useRef, useState } from "react";
import {
  computeStickyDateState,
  type DividerPosition,
  type StickyDateState,
} from "@/src/lib/agent/stickyDate";

/**
 * ChatStickyDateHeader — スクロール中に「最上部に見えている暦日」を上部にピン留めする浮遊ヘッダー
 *
 * LINE / iOS メッセージ / WhatsApp の「日付ヘッダー」に相当する演出。CopilotChat の
 * スクロール容器（`.copilotKitMessages`, `overflow-y: scroll`）の最上部へ、1 つだけ
 * 絶対配置したヘッダー（`.chat-sticky-date`）を重ね、現在最上部に来ている暦日の日付を
 * 表示する。日付が変わる境界へスクロールすると、次の暦日の inline 区切り行
 * （`.chat-day-divider`）が上端へ入ってくるのに合わせてラベルが入れ替わる。
 *
 * 設計上の判断（CSS sticky ではなく浮遊ヘッダーを採用した理由）:
 * - CopilotChat は各メッセージを `.copilotKitMessagesContainer` 直下の平坦な兄弟として
 *   描画し（`RenderMessage` はカスタムコンポーネントをラッパー無しで返す）、`.chat-day-divider`
 *   も暦日ごとのセクションでラップされない。この構造では純粋な `position: sticky` は
 *   過去のヘッダーが上部に積み重なり、綺麗に入れ替わらない。
 * - そこで DOM を測定して「アクティブな暦日」を求める浮遊ヘッダーにする。アクティブ判定と
 *   押し上げ量の算出は純粋関数 `computeStickyDateState` に切り出し、単体テスト可能にしている
 *   （UI ロジックとインフラ/DOM の分離）。
 *
 * 実装方針:
 * - スクロール容器は親要素（`SessionChat` のチャット領域）配下の `.copilotKitMessages` を
 *   `querySelector` で解決する。CopilotChat の内部 DOM が未マウントの場合に備え、
 *   見つかるまで親を MutationObserver で監視してから購読を張る。
 * - 位置計算は `scroll` / `resize` / メッセージ変化（`MutationObserver`）を trigger にし、
 *   `requestAnimationFrame` で 1 フレームにまとめてレイアウトスラッシングを避ける。
 * - ラベルは各区切り行の `data-date` 属性（inline 区切りと同一の `formatMessageDate` 文字列）を
 *   読むため、浮遊ヘッダーと inline 区切りの表示が必ず一致する。
 * - すべての購読はアンマウント時に解除する。ヘッダーは `pointer-events: none` で、
 *   スクロール/クリックを妨げない。
 */
export function ChatStickyDateHeader() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<StickyDateState>({
    visible: false,
    label: "",
    translateY: 0,
  });

  useEffect(() => {
    const rootEl = rootRef.current;
    const parent = rootEl?.parentElement;
    if (!rootEl || !parent) return;

    let frame = 0;
    let scroller: HTMLElement | null = null;
    let waitObserver: MutationObserver | null = null;
    let scrollObserver: MutationObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const measure = () => {
      frame = 0;
      if (!scroller) return;
      const containerTop = scroller.getBoundingClientRect().top;
      const dividerEls = Array.from(
        scroller.querySelectorAll<HTMLElement>(".chat-day-divider"),
      );
      const dividers: DividerPosition[] = dividerEls.map((el) => ({
        label: el.dataset.date ?? el.textContent?.trim() ?? "",
        top: el.getBoundingClientRect().top - containerTop,
      }));
      const headerHeight = rootEl.offsetHeight || 0;
      const next = computeStickyDateState(dividers, headerHeight);
      setState((prev) =>
        prev.visible === next.visible &&
        prev.label === next.label &&
        prev.translateY === next.translateY
          ? prev
          : next,
      );
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    const attach = (el: HTMLElement) => {
      scroller = el;
      el.addEventListener("scroll", schedule, { passive: true });
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(el);
      // メッセージの追加/復元/生成でも区切り行が変化するため subtree を監視する。
      scrollObserver = new MutationObserver(schedule);
      scrollObserver.observe(el, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      window.addEventListener("resize", schedule);
      schedule();
    };

    const found = parent.querySelector<HTMLElement>(".copilotKitMessages");
    if (found) {
      attach(found);
    } else {
      // CopilotChat の内部 DOM が後からマウントされるケースに備えて待機する。
      waitObserver = new MutationObserver(() => {
        const el = parent.querySelector<HTMLElement>(".copilotKitMessages");
        if (el) {
          waitObserver?.disconnect();
          waitObserver = null;
          attach(el);
        }
      });
      waitObserver.observe(parent, { childList: true, subtree: true });
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
      waitObserver?.disconnect();
      scrollObserver?.disconnect();
      resizeObserver?.disconnect();
      if (scroller) scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="chat-sticky-date"
      data-visible={state.visible ? "true" : "false"}
      aria-hidden="true"
    >
      <div
        className="chat-day-divider chat-sticky-date__inner"
        style={{
          transform: state.translateY
            ? `translateY(${state.translateY}px)`
            : undefined,
        }}
      >
        <span>{state.label}</span>
      </div>
    </div>
  );
}

export default ChatStickyDateHeader;
