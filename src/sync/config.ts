/**
 * Where the cloud copy lives: the `bills-sync` Worker in `worker/`.
 * For local development, run the Worker (`npm run dev` in `worker/`) and start the app with
 * VITE_SYNC_URL=http://127.0.0.1:8787 npm run dev
 */
const DEPLOYED_URL = '';

export const SYNC_URL: string = String(import.meta.env.VITE_SYNC_URL || DEPLOYED_URL).replace(/\/+$/, '');

/** False when this build has no sync server configured; every sync control is hidden then. */
export const syncAvailable = (): boolean => /^https?:\/\//.test(SYNC_URL);
