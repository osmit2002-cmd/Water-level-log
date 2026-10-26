import { useState } from 'react';

const KEY = 'wll-install-tip-dismissed';
export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
export function isStandalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
}

export default function InstallTip() {
  const [hidden, setHidden] = useState(() => localStorage.getItem(KEY) === '1' || !isIos() || isStandalone());
  if (hidden) return null;
  return (
    <div className="tip" role="note" data-testid="install-tip">
      <span>Install: in Safari tap <b>Share</b> <span aria-hidden>⎋</span> then <b>Add to Home Screen</b>. It then works offline.</span>
      <button className="small" onClick={() => { localStorage.setItem(KEY, '1'); setHidden(true); }} aria-label="Dismiss install tip">✕</button>
    </div>
  );
}
