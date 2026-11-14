// A click on a dialog's dimmed backdrop (not on its card) acts like Escape, so every dialog keeps its single close
// path with its own busy checks; dialogs that ignore Escape (sign-in in progress) stay open. A press that starts in
// the card and ends on the backdrop, such as selecting text, does not count.
export function installBackdropClose(doc = document, selector = '.board-modal') {
  let pressed = null;
  const down = event => { pressed = event.button === 0 && event.target?.matches?.(selector) ? event.target : null; };
  const click = event => {
    const backdrop = pressed;
    pressed = null;
    if (!backdrop || event.target !== backdrop) return;
    const KeyboardEvent = doc.defaultView.KeyboardEvent;
    backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  };
  doc.addEventListener('pointerdown', down, true);
  doc.addEventListener('click', click, true);
  return () => { doc.removeEventListener('pointerdown', down, true); doc.removeEventListener('click', click, true); };
}
