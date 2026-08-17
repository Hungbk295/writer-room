import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type JobDoneNotification } from '../api.ts';
import { href } from '../router.ts';

const POLL_MS = 5_000;

function notificationHref(notification: JobDoneNotification): string {
  switch (notification.kind) {
    case 'training-lab':
      return href({ name: 'training-lab-run', id: notification.jobId });
    case 'writer':
      return href({ name: 'writer-run', id: notification.jobId });
    case 'writer-v2':
      return href({ name: 'writer-v2-run', id: notification.jobId });
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** Global bell for durable job-completion records. */
export function JobNotificationCenter() {
  const [notifications, setNotifications] = useState<JobDoneNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<JobDoneNotification | null>(null);
  const hydrated = useRef(false);
  const knownIds = useRef(new Set<string>());

  useEffect(() => {
    let disposed = false;
    let toastTimer: number | undefined;
    const refresh = async () => {
      try {
        const next = (await api.listJobNotifications()).notifications;
        if (disposed) return;
        if (hydrated.current) {
          const newest = next.find((notification) => !knownIds.current.has(notification.id));
          if (newest) {
            setToast(newest);
            if (toastTimer !== undefined) window.clearTimeout(toastTimer);
            toastTimer = window.setTimeout(() => setToast(null), 7_000);
          }
        }
        knownIds.current = new Set(next.map((notification) => notification.id));
        hydrated.current = true;
        setNotifications(next);
      } catch {
        // A transient offline daemon should not disturb the current app view.
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    };
  }, []);

  const unreadCount = notifications.filter((notification) => notification.readAt === null).length;
  const markRead = (notification: JobDoneNotification) => {
    if (notification.readAt) return;
    void api.markJobNotificationRead(notification.id)
      .then((updated) => {
        setNotifications((current) => current.map((item) => item.id === updated.id ? updated : item));
      })
      .catch(() => undefined);
  };

  return (
    <div class="notification-center">
      <button
        type="button"
        class="notification-button"
        aria-label={`Thông báo${unreadCount ? ` (${unreadCount} chưa đọc)` : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        Thông báo
        {unreadCount > 0 && <span class="nav-badge">{unreadCount}</span>}
      </button>
      {open && (
        <div class="notification-popover" role="status" aria-live="polite">
          <div class="notification-heading">Job hoàn tất</div>
          {notifications.length === 0 ? (
            <p class="muted notification-empty">Chưa có job nào hoàn tất.</p>
          ) : notifications.map((notification) => (
            <a
              key={notification.id}
              href={notificationHref(notification)}
              class={`notification-item${notification.readAt ? '' : ' unread'}`}
              onClick={() => markRead(notification)}
            >
              <strong>{notification.title}</strong>
              <span>{notification.detail}</span>
              <small>{formatTime(notification.createdAt)}</small>
            </a>
          ))}
        </div>
      )}
      {toast && (
        <a
          class="notification-toast"
          href={notificationHref(toast)}
          onClick={() => markRead(toast)}
        >
          <strong>{toast.title}</strong>
          <span>{toast.detail}</span>
        </a>
      )}
    </div>
  );
}
