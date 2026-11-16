// While a notification shows, an open dialog keeps the strip under it free (style.css: --toast-room), so the notification
// never covers the dialog's buttons. Returns a React ref callback for every notification element: it records the
// tallest one shown, plus the gaps around it, and clears the room when the last one goes.
export const toastGap = 12;

export function toastRoom(root = globalThis.document?.documentElement, Observer = globalThis.ResizeObserver) {
  const shown = new Set();
  const update = () => {
    const height = Math.max(0, ...[...shown].map(element => element.getBoundingClientRect().height));
    if (height > 0) root?.style.setProperty('--toast-room', `${Math.ceil(height) + toastGap * 2}px`);
    else root?.style.removeProperty('--toast-room');
  };
  const observer = Observer ? new Observer(update) : null;
  return element => {
    if (!element) return;
    shown.add(element); observer?.observe(element); update();
    return () => { shown.delete(element); observer?.unobserve(element); update(); };
  };
}
