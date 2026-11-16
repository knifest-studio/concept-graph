// One screen-space tooltip also covers disabled and canvas-scaled controls. It shows on hover and on keyboard focus.
// A focus the browser does not mark as keyboard focus (a tap, a click, or a dialog's autofocus after one) shows no tip:
// on a phone that tip would cover the controls around the focused button until the next tap.
export function installButtonHelp(doc, win, setTip) {
  let current;
  const hide = () => { current = null; setTip(null); };
  const show = event => {
    if (event.type === 'focusin' && !keyboardFocus(event.target)) return;
    const button = event.target.closest?.('button,[data-tooltip]');
    if (!button) return hide();
    if (button.closest('[role="menu"]')) return hide();
    if (button === current) return;
    const text = button.dataset.tooltip || button.getAttribute('aria-label') || button.textContent.trim();
    if (!text) return hide();
    current = button;
    const rect = button.getBoundingClientRect(), below = rect.top < 48;
    setTip({ text, below, x: Math.max(140, Math.min(win.innerWidth - 140, rect.left + rect.width / 2)), y: below ? rect.bottom + 8 : rect.top - 8 });
  };
  const leave = event => { if (!current?.contains(event.relatedTarget)) hide(); };
  const key = event => { if (event.key === 'Escape') hide(); };
  doc.addEventListener('pointerover', show, true);
  doc.addEventListener('pointerout', leave, true);
  doc.addEventListener('focusin', show);
  doc.addEventListener('focusout', hide);
  doc.addEventListener('click', hide, true);
  doc.addEventListener('wheel', hide, { passive: true });
  doc.addEventListener('scroll', hide, true);
  doc.addEventListener('keydown', key);
  win.addEventListener('resize', hide);
  return () => {
    doc.removeEventListener('pointerover', show, true);
    doc.removeEventListener('pointerout', leave, true);
    doc.removeEventListener('focusin', show);
    doc.removeEventListener('focusout', hide);
    doc.removeEventListener('click', hide, true);
    doc.removeEventListener('wheel', hide);
    doc.removeEventListener('scroll', hide, true);
    doc.removeEventListener('keydown', key);
    win.removeEventListener('resize', hide);
  };
}

// Browsers without :focus-visible keep the old behaviour: every focus explains its button.
function keyboardFocus(element) {
  if (typeof element?.matches !== 'function') return true;
  try { return element.matches(':focus-visible'); } catch { return true; }
}
