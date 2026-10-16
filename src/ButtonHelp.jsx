import React, { useEffect, useState } from 'react';

// One screen-space tooltip also covers disabled and canvas-scaled controls.
export function ButtonHelp() {
  const [tip, setTip] = useState(null);
  useEffect(() => {
    let current;
    const hide = () => { current = null; setTip(null); };
    const show = event => {
      const button = event.target.closest?.('button,[data-tooltip]');
      if (!button) return hide();
      if (button === current) return;
      const text = button.dataset.tooltip || button.getAttribute('aria-label') || button.textContent.trim();
      if (!text) return hide();
      current = button;
      const rect = button.getBoundingClientRect(), below = rect.top < 48;
      setTip({ text, below, x: Math.max(140, Math.min(innerWidth - 140, rect.left + rect.width / 2)), y: below ? rect.bottom + 8 : rect.top - 8 });
    };
    const leave = event => { if (!current?.contains(event.relatedTarget)) hide(); };
    const key = event => { if (event.key === 'Escape') hide(); };
    document.addEventListener('pointerover', show, true);
    document.addEventListener('pointerout', leave, true);
    document.addEventListener('focusin', show);
    document.addEventListener('focusout', hide);
    document.addEventListener('click', hide, true);
    document.addEventListener('wheel', hide, { passive: true });
    document.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('pointerover', show, true);
      document.removeEventListener('pointerout', leave, true);
      document.removeEventListener('focusin', show);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('click', hide, true);
      document.removeEventListener('wheel', hide);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', hide);
    };
  }, []);
  return tip && <div role="tooltip" className={`button-help ${tip.below ? 'below' : ''}`} style={{ left: tip.x, top: tip.y }}>{tip.text}</div>;
}
