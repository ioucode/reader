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
// Only a control you type into earns the document scroll Safari gives it (to lift it above the
// keyboard). A focused checkbox, slider or button does not, or the shift would never be undone.
const NON_TEXT = /^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/;
const editable = (el: Element | null): boolean =>
  !!el &&
  (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable ||
    (el instanceof HTMLInputElement && !NON_TEXT.test(el.type)));

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
  const settleTwice = (): void => { settle(); setTimeout(settle, 350); };
  document.addEventListener('focusout', settleTwice);
  // Back/forward restores the page from bfcache without re-running anything.
  window.addEventListener('pageshow', settleTwice);
  window.addEventListener('scroll', settle, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(settle, 350));
  window.visualViewport?.addEventListener('resize', settle);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) settle(); });
}
