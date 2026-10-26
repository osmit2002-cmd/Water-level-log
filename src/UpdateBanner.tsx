import { useRegisterSW } from 'virtual:pwa-register/react';

/** Registers the service worker. Updates wait for a tap so a reading being typed is never lost to a reload. */
export default function UpdateBanner() {
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW();
  if (!needRefresh) return null;
  return (
    <div className="tip" role="status">
      <span>An update is ready.</span>
      <button className="small primary" onClick={() => void updateServiceWorker(true)}>Update</button>
      <button className="small" onClick={() => setNeedRefresh(false)} aria-label="Later">Later</button>
    </div>
  );
}
