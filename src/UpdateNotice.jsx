import React, { useEffect, useRef, useState } from 'react';
import { watchVersion } from './version-check.mjs';
import { t } from './i18n.mjs';
import './update-notice.css';

export function UpdateNotice() {
  const [version, setVersion] = useState(''), dismissed = useRef('');
  useEffect(() => watchVersion({ page: document.querySelector('meta[name="concept-graph-version"]')?.content, document, window, fetch,
    updated: next => { if (next !== dismissed.current) setVersion(next); }
  }), []);
  return version && <aside className="update-notice" role="status" data-analytics-area="update-notice">
    <span>{t('Concept Graph has been updated. Reload to get the new version.')}</span>
    <button type="button" onClick={() => location.reload()}>{t('Reload')}</button>
    <button type="button" onClick={() => { dismissed.current = version; setVersion(''); }}>{t('Later')}</button>
  </aside>;
}
