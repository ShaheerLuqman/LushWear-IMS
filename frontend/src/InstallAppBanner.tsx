// Desktop "Install app" (PWA) banner - registers the service worker and prompts to
// add a desktop shortcut. Ported 1:1 from app-core.js's initInstallPrompt/showInstallBanner.
import { useEffect, useState } from 'react';

const INSTALL_PROMPT_DISMISSED_KEY = 'lushwear_install_prompt_dismissed';

// Safari (macOS) has no beforeinstallprompt/install API - "Add to Dock" is a manual
// File-menu action only the user can trigger, so we just point them at it.
function isMacSafari(): boolean {
  const ua = navigator.userAgent;
  return /Macintosh/.test(ua) && /^((?!chrome|android|crios|edg|opr).)*safari/i.test(ua);
}

export function InstallAppBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return !!localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY); } catch { return false; }
  });

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch(() => { /* installability only - safe to ignore */ });
    }
    function onBeforeInstall(event: Event) {
      event.preventDefault();
      setDeferredPrompt(event);
    }
    function onInstalled() {
      setDeferredPrompt(null);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const macSafari = isMacSafari();
  if (dismissed || (!deferredPrompt && !macSafari)) return null;

  async function install() {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
  }

  function dismiss() {
    try { localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, '1'); } catch { /* ignore */ }
    setDismissed(true);
  }

  return (
    <div className="install-app-banner">
      <img src="/assets/Logo.png" alt="" className="install-app-banner-icon" />
      <div className="install-app-banner-text">
        <p className="install-app-banner-title">Install SoftLush IMS</p>
        <p className="install-app-banner-subtitle">
          {macSafari ? 'In the Safari menu bar: File → Add to Dock' : 'Add a desktop shortcut for quicker access'}
        </p>
      </div>
      {!macSafari && <button type="button" className="btn btn-primary" onClick={install}>Install</button>}
      <button type="button" className="install-app-banner-dismiss" aria-label="Dismiss" onClick={dismiss}>&times;</button>
    </div>
  );
}
