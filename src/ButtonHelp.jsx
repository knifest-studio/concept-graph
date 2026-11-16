import React, { useEffect, useState } from 'react';
import { installButtonHelp } from './button-help.mjs';

// One screen-space tooltip also covers disabled and canvas-scaled controls (see button-help.mjs for when it shows).
export function ButtonHelp() {
  const [tip, setTip] = useState(null);
  useEffect(() => installButtonHelp(document, window, setTip), []);
  return tip && <div role="tooltip" className={`button-help ${tip.below ? 'below' : ''}`} style={{ left: tip.x, top: tip.y }}>{tip.text}</div>;
}
