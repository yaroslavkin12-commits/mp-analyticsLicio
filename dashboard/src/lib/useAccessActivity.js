import { useEffect, useRef } from 'react';
import { getMe } from '../api';

// Время подтверждается серверными отметками; открытая фоновая вкладка не считается работой.
export default function useAccessActivity(page, cabinet) {
  const location = useRef({ page, cabinet });
  location.current = { page, cabinet };
  useEffect(() => {
    let enabled = false, stopped = false, timer, lastInput = Date.now();
    const id = crypto.randomUUID();
    const input = () => { lastInput = Date.now(); };
    const body = close => ({ visitId: id, ...location.current, close,
      idleSeconds: Math.min(86400, Math.max(0, (Date.now() - lastInput) / 1000)),
      visible: !close && document.visibilityState === 'visible' && document.hasFocus() });
    const send = (close = false, beacon = false) => {
      if (!enabled) return;
      const text = JSON.stringify(body(close));
      if (beacon && navigator.sendBeacon?.('/api/auth/activity', new Blob([text], { type: 'application/json' }))) return;
      fetch('/api/auth/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text, credentials: 'same-origin', keepalive: true }).catch(() => {});
    };
    const visibility = () => send(false, document.visibilityState !== 'visible');
    const focus = () => { input(); send(); };
    const blur = () => send(false, true);
    const hide = event => send(!event.persisted, true);
    const show = () => { input(); send(); };
    const events = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'wheel', 'touchstart'];
    for (const event of events) document.addEventListener(event, input, { passive: true, capture: true });
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', focus); window.addEventListener('blur', blur);
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    getMe().then(r => {
      if (stopped || !r.data.data?.auth) return;
      enabled = true; send(); timer = setInterval(() => send(), 30000);
    }).catch(() => {});
    return () => {
      stopped = true; clearInterval(timer); send(true, true);
      for (const event of events) document.removeEventListener(event, input, true);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', focus); window.removeEventListener('blur', blur);
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
    };
  }, []);
}
