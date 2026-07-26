/**
 * stickyDate — スクロール中の「現在の日付ヘッダー」ピン留め計算（純粋関数）
 *
 * チャットの日付区切り行（`.chat-day-divider`）はメッセージ列の中に平坦な兄弟として
 * 差し込まれており（暦日ごとのセクションでラップされていない）、そのため純粋な CSS
 * `position: sticky` では過去のヘッダーが積み重なって綺麗に入れ替わらない。
 * 代わりに、スクロール領域の最上部に 1 つだけ浮かせたヘッダー（`ChatStickyDateHeader`）を
 * 置き、各区切り行のスクロール位置から「いま最上部に来ている暦日」を決めて表示する。
 *
 * この関数は DOM に一切触れない純粋なロジックとして、
 *   - 区切り行のラベルとスクロール容器上端からの相対 top オフセット（`top`）の並び
 *   - 浮遊ヘッダーの高さ（`headerHeight`）
 * から、浮遊ヘッダーの表示状態（可視かどうか / ラベル / 押し上げ translateY）を算出する。
 * これにより「どの区切り行がアクティブか」というロジックを単体テストできる。
 *
 * 前提: `dividers` はメッセージ順（＝上から下へ）に並んでいる。`top` はスクロール容器の
 * 上端を 0 とした各区切り行の上端位置（px）。上端より上へスクロールアウトした区切り行は
 * 負の値になる。
 */

/** 1 つの日付区切り行の測定値。 */
export interface DividerPosition {
  /** 表示ラベル（例: 2026年7月21日（火））。inline の区切り行と同一文字列。 */
  label: string;
  /** スクロール容器上端を 0 とした区切り行の上端オフセット（px）。上へ出ると負。 */
  top: number;
}

/** 浮遊日付ヘッダーの表示状態。 */
export interface StickyDateState {
  /** ヘッダーを表示するか（最上部に到達した区切り行が無ければ false）。 */
  visible: boolean;
  /** 表示するラベル（`visible` が false のときは ""）。 */
  label: string;
  /**
   * ヘッダー内側の押し上げ量（px, 0 または負値）。次の暦日の inline 区切り行が
   * 上端付近まで来たとき、現在のヘッダーを上へ押し出す iOS/LINE 風の演出に使う。
   */
  translateY: number;
}

/** 上端到達判定のしきい値（小さな正の余裕）。丸め誤差で点滅しないための緩衝。 */
const TOP_EPSILON = 0.5;

const HIDDEN: StickyDateState = { visible: false, label: "", translateY: 0 };

/**
 * 区切り行の測定値と浮遊ヘッダー高さから、浮遊日付ヘッダーの表示状態を算出する。
 *
 * ロジック:
 * - 「アクティブな区切り行」= `top <= TOP_EPSILON` を満たす最後の（最も下の）区切り行。
 *   これは「上端に到達済み or 上へ出た区切り行のうち、いちばん新しい暦日」を意味する。
 *   最初の区切り行がまだ上端より下（`top > 0`）にある＝会話の先頭付近では、
 *   アクティブな区切り行が無いのでヘッダーは非表示（inline の区切りがそのまま見える）。
 *   dated メッセージが 0 件のとき（`dividers` が空）も非表示。
 * - ラベルはアクティブな区切り行のラベル。
 * - 押し上げ: 次の区切り行（アクティブの 1 つ下）の `top` が 0〜headerHeight の範囲に
 *   入っているとき、`translateY = nextTop - headerHeight`（負値）で現在のヘッダーを
 *   その分だけ上へ押し出す。次の inline 区切り行が「入ってくる新ヘッダー」の役割を
 *   担うため、浮遊ヘッダーと inline 区切り行の受け渡しが滑らかになる。
 */
export function computeStickyDateState(
  dividers: DividerPosition[],
  headerHeight: number,
): StickyDateState {
  if (!Array.isArray(dividers) || dividers.length === 0) {
    return HIDDEN;
  }

  let activeIndex = -1;
  for (let i = 0; i < dividers.length; i += 1) {
    if (dividers[i].top <= TOP_EPSILON) {
      activeIndex = i;
    } else {
      // dividers はメッセージ順（top 昇順に相当）なので、最初に上端未到達が出たら以降も未到達。
      break;
    }
  }

  if (activeIndex === -1) {
    return HIDDEN;
  }

  const label = dividers[activeIndex].label;

  let translateY = 0;
  const next = dividers[activeIndex + 1];
  if (
    next !== undefined &&
    Number.isFinite(headerHeight) &&
    headerHeight > 0 &&
    next.top > 0 &&
    next.top < headerHeight
  ) {
    translateY = next.top - headerHeight;
  }

  return { visible: true, label, translateY };
}
