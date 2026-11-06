import { registerSW } from 'virtual:pwa-register';
import { toast } from '../state/toast';

/** Registers the service worker and offers a one-tap refresh when a new version has been deployed. */
export function initPwa() {
  if (!('serviceWorker' in navigator)) return;
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      toast('A new version of Bills Planner is ready.', {
        duration: 0,
        action: { label: 'Refresh', run: () => void updateSW(true) },
      });
    },
    onOfflineReady() {
      toast('Saved for offline use.');
    },
  });
}

/** Ask the browser not to evict our storage when the device is low on space. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* not supported */
  }
  return false;
}
