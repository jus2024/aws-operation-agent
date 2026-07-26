"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * ChatComposerContext — 画像添付経路の「セッション副作用」を ChatComposer へ配線する
 *
 * テキストのみの送信は CopilotChat の `onSend` を経由するため、`CopilotChat` の
 * `onSubmitMessage`（= `useSessionSubmitHandler` の `handleSubmitMessage`）が
 * 自動的に発火する。しかし画像を含む送信は `useImageMessageSender` 経由で
 * `onSend` をバイパスするため、セッション名の自動生成（初回メッセージ）と
 * `touchSession`（updatedAt 更新）が発火しない。
 *
 * そこで `SessionChatWithPersistence` が持つ `handleSubmitMessage` を本コンテキストの
 * `onUserSubmit` として供給し、ChatComposer は画像送信の成功時にこれを 1 回だけ呼ぶ。
 * これによりテキスト経路と画像経路でセッション副作用の挙動を揃える。
 *
 * `onUserSubmit` は任意（null-safe）であり、Provider 無しでも ChatComposer は
 * 動作する（テスト・単体利用のため）。
 */
export interface ChatComposerContextValue {
  /**
   * ユーザーがメッセージを送信した直後に一度だけ呼ばれる副作用。
   * 画像経路（onSend をバイパスする経路）でセッション名自動生成 + touchSession を
   * 発火させるために使う。テキストのみの経路では CopilotChat の onSubmitMessage が
   * 担うため、ChatComposer からは呼ばない。
   */
  onUserSubmit?: (text: string) => void | Promise<void>;
}

const ChatComposerContext = createContext<ChatComposerContextValue>({});

export function ChatComposerProvider({
  value,
  children,
}: {
  value: ChatComposerContextValue;
  children: ReactNode;
}) {
  return (
    <ChatComposerContext.Provider value={value}>
      {children}
    </ChatComposerContext.Provider>
  );
}

export function useChatComposerContext(): ChatComposerContextValue {
  return useContext(ChatComposerContext);
}

export default ChatComposerContext;
