/**
 * Keep the document itself pinned at the top on iOS Safari.
 *
 * The reader is an app shell: `#app` fills the viewport and every page scrolls
 * inside its own container, so the document should never scroll. iOS Safari
 * does scroll it anyway — to lift a focused field above the keyboard — and often
 * leaves it scrolled after the keyboard closes or the toolbar collapses. The whole
 * shell is then shifted up, and the bottom tab bar / reader controls end up
 * partly behind Safari's own toolbar until something forces a relayout. That is
 * the "sometimes the bottom covers the content" report.
 *
 * Whenever no text field is focused, undo any document scroll.
 */
const editable = (el: Element | null): boolean =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);

export function pinViewport(): void {
  let frame = 0;
  const settle = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (editable(document.activeElement)) return;
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    });
  };
  // focusout fires before the keyboard animation ends; check again once it has.
  document.addEventListener('focusout', () => { settle(); setTimeout(settle, 350); });
  window.addEventListener('scroll', settle, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(settle, 350));
  window.visualViewport?.addEventListener('resize', settle);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) settle(); });
}
