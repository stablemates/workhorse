import { VisuallyHidden } from "@mantine/core";
import {
  Fragment,
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import type { LoadState } from "./core.js";

/**
 * Whether the page on screen answers an older request than the one its controls name.
 *
 * A control such as a time range or a state filter asks the server again in place. The page keeps
 * the previous answer on screen until the new answer arrives, so the operator never sees an empty
 * frame or a full-page loader. A page reads this value to dim the rows that are about to change.
 */
export const PagePendingContext = createContext(false);

export function usePagePending(): boolean {
  return useContext(PagePendingContext);
}

/**
 * Counts the times a page load replaced a cached answer on screen.
 *
 * A page shows its cached answer at once after a click, and the page load replaces it a moment
 * later. Rows with a `requestKey` mount again at that moment, so a new row at the top does not
 * push the cached rows down. The pixels change in place and nothing on the page moves.
 */
export const PageAnswerContext = createContext(0);

/**
 * True when the page data on screen answers a request other than `pageKey`.
 *
 * `shownKey` is the request that the data on screen answers. A refresh of the same request is not
 * pending, because the rows on screen already describe what the controls name.
 */
export function pagePending(
  loadState: Pick<LoadState, "status" | "data">,
  shownKey: string | null,
  pageKey: string,
): boolean {
  if (loadState.data === null || loadState.status === "error") return false;
  return shownKey !== null && shownKey !== pageKey;
}

/**
 * Rows that can answer an older request for a moment.
 *
 * While `pending` is true the rows stay in place, dimmed, with `aria-busy`. The rows keep their
 * size, so the page does not move, and scroll position and focus stay where they were.
 *
 * `requestKey` names the request that the controls ask for. When the answer to a new request
 * arrives, the rows inside `PendingRows` mount again as a new list. A row that is in both lists
 * then does not slide to its new place, which reads as a layout shift. The rows also mount again
 * when a page load replaces a cached answer, for the same reason. A refresh of the same request
 * keeps every row. Only the rows mount again, so a scroll area around them keeps its position.
 * If a control in the old rows had focus, the control with the same `id` in the new rows gets it
 * back, so a keyboard user does not lose their place.
 */
export function PendingResults({
  pending,
  requestKey,
  children,
}: {
  pending: boolean;
  requestKey?: string;
  children: ReactNode;
}) {
  const answer = useContext(PageAnswerContext);
  const listKey = requestKey === undefined ? undefined : `${requestKey}#${answer}`;
  const [settledKey, setSettledKey] = useState(listKey);
  if (!pending && settledKey !== listKey) setSettledKey(listKey);
  const renderedKey = pending ? settledKey : listKey;
  const container = useRef<HTMLDivElement | null>(null);
  const focusedId = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (container.current) restoreFocus(document, container.current, focusedId.current);
  }, [renderedKey]);
  const rememberFocus = (event: FocusEvent<HTMLDivElement>) => {
    focusedId.current = event.target.id || null;
  };
  const forgetFocus = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    focusedId.current = focusAfterBlur(
      focusedId.current,
      next instanceof Node ? next : null,
      event.currentTarget,
    );
  };
  return (
    <div
      ref={container}
      onFocus={rememberFocus}
      onBlur={forgetFocus}
      className="pending-results"
      data-pending={pending ? "true" : undefined}
      aria-busy={pending ? true : undefined}
    >
      <PendingRowsKeyContext.Provider value={renderedKey}>
        {children}
      </PendingRowsKeyContext.Provider>
    </div>
  );
}

/** The list key of the nearest `PendingResults`, which its rows mount under. */
const PendingRowsKeyContext = createContext<string | undefined>(undefined);

/** The rows of a `PendingResults` list. They mount again when an answer to a new request shows. */
export function PendingRows({ children }: { children: ReactNode }) {
  return <Fragment key={useContext(PendingRowsKeyContext)}>{children}</Fragment>;
}

/** The parts of the document that `restoreFocus` reads, so a test can give a stand-in. */
interface FocusDocument {
  readonly activeElement: Element | null;
  readonly body: HTMLElement | null;
  getElementById(id: string): HTMLElement | null;
}

/**
 * Moves focus to the control with `id` in the new rows.
 *
 * It acts only when the old control took focus with it, so focus fell back to the body. If the
 * operator moved focus somewhere else in the meantime, focus stays there.
 */
export function restoreFocus(
  doc: FocusDocument,
  container: Pick<Node, "contains">,
  id: string | null,
): void {
  const active = doc.activeElement;
  if (id === null || (active !== null && active !== doc.body)) return;
  const replacement = doc.getElementById(id);
  if (replacement && container.contains(replacement)) replacement.focus({ preventScroll: true });
}

/**
 * The id to remember after a blur in the rows. A removed control blurs with no next target, so it
 * stays remembered. Only a move to a control outside the rows forgets it.
 */
export function focusAfterBlur(
  id: string | null,
  next: Node | null,
  container: Pick<Node, "contains">,
): string | null {
  return next !== null && !container.contains(next) ? null : id;
}

/** The last answered request and its result count, which a new answer is compared with. */
export interface SettledResults {
  key: string;
  count: number;
  message: string;
}

/**
 * What the polite live region says after a request is answered.
 *
 * The region speaks only when a new request settles with a different result count. A poll that
 * answers the same request again says nothing, and a request that is still in flight says nothing.
 */
export function settleResults(
  settled: SettledResults | null,
  current: { key: string; pending: boolean; count: number; message: string },
): SettledResults | null {
  if (current.pending) return settled;
  if (settled !== null && settled.key === current.key) return settled;
  const message = settled === null || settled.count === current.count ? "" : current.message;
  return { key: current.key, count: current.count, message };
}

/**
 * A polite live region that says the new result count after a control changed the request.
 *
 * The region is always in the document, so assistive technology hears the change of its text.
 */
export function ResultsAnnouncement({
  requestKey,
  pending,
  count,
  message,
}: {
  requestKey: string;
  pending: boolean;
  count: number;
  message: string;
}) {
  const [settled, setSettled] = useState<SettledResults | null>(null);
  const next = settleResults(settled, { key: requestKey, pending, count, message });
  if (next !== settled) setSettled(next);
  return (
    <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
      {next?.message ?? ""}
    </VisuallyHidden>
  );
}
