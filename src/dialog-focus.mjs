const focusableSelector = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

export function keepDialogFocus(event) {
  if (event.key !== 'Tab') return;
  const controls = [...event.currentTarget.querySelectorAll(focusableSelector)].filter(element => element.getClientRects().length);
  if (!controls.length) return;
  const active = event.currentTarget.ownerDocument.activeElement;
  if (event.shiftKey && (active === controls[0] || !controls.includes(active))) {
    event.preventDefault(); controls.at(-1).focus();
  } else if (!event.shiftKey && (active === controls.at(-1) || !controls.includes(active))) {
    event.preventDefault(); controls[0].focus();
  }
}

export function restoreDialogFocus(element) {
  if (element?.isConnected && typeof element.focus === 'function') element.focus();
}
