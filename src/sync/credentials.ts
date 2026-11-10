/**
 * Chrome's password manager (Credential Management API). Saved passwords live outside the site's storage, so they
 * survive Chrome clearing it; that's what lets a wiped app restore itself. Every call here is optional: browsers
 * without the API simply fall back to the sign-in form, which their own autofill can fill.
 */
type PasswordCredentialInit = { id: string; password: string; name?: string };
type PasswordCredentialCtor = new (init: PasswordCredentialInit) => Credential;
type PasswordLike = Credential & { password?: string };

function ctor(): PasswordCredentialCtor | null {
  if (typeof window === 'undefined' || !navigator.credentials) return null;
  return (window as unknown as { PasswordCredential?: PasswordCredentialCtor }).PasswordCredential ?? null;
}

/** Offers to save the sync name and password in the browser's password manager. */
export async function rememberCredential(name: string, password: string): Promise<void> {
  const Ctor = ctor();
  if (!Ctor) return;
  try {
    await navigator.credentials.store(new Ctor({ id: name, password, name: 'Bills Planner cloud sync' }));
  } catch { /* refused or unsupported */ }
}

/**
 * The saved sync password, if any. 'silent' never shows anything (used to restore a wiped app automatically);
 * 'optional' may show Chrome's account picker.
 */
export async function savedCredential(mediation: 'silent' | 'optional'): Promise<{ name: string; password: string } | null> {
  if (!ctor()) return null;
  try {
    const c = (await navigator.credentials.get({ password: true, mediation } as unknown as CredentialRequestOptions)) as PasswordLike | null;
    return c && c.type === 'password' && c.password ? { name: c.id, password: c.password } : null;
  } catch {
    return null;
  }
}

/** After sync is turned off or the app erased, don't restore automatically until the person picks the account again. */
export function stopAutoRestore(): void {
  try { void navigator.credentials?.preventSilentAccess?.(); } catch { /* unsupported */ }
}
