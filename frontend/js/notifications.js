// ============================================
// Notifications
// ============================================
// In-memory only, never written to storage - history resets on reload/new
// session, same lifetime as the toasts it's captured from.

const NOTIFICATIONS_MAX = 50;
let _notifications = [];

/** Fed from showToast() (see delivery-status.js) for every non-silent toast - that's
 * the funnel for actual action outcomes (saves, syncs, exports, generations, fetches).
 * Instant client-side guard/validation toasts pass `{ silent: true }` and skip this,
 * since the user already sees and fixes those in the still-open form. */
function addNotification(message, type = 'info') {
    _notifications.unshift({ id: `${Date.now()}-${Math.random()}`, message, type, time: Date.now(), read: false });
    if (_notifications.length > NOTIFICATIONS_MAX) _notifications.length = NOTIFICATIONS_MAX;
    renderNotifications();
}

function renderNotifications() {
    const list = document.getElementById('notifList');
    const badge = document.getElementById('notifBadge');
    const clearBtn = document.getElementById('notifClearBtn');
    if (!list || !badge) return;

    const unreadCount = _notifications.filter((n) => !n.read).length;
    badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
    badge.style.display = unreadCount > 0 ? 'flex' : 'none';
    if (clearBtn) clearBtn.disabled = _notifications.length === 0;

    if (_notifications.length === 0) {
        list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
        return;
    }

    list.innerHTML = _notifications.map((n) => `
        <div class="notif-item ${n.type}${n.read ? '' : ' unread'}">
            <div class="notif-item-body">
                <div class="notif-item-message">${escapeHtml(n.message)}</div>
                <div class="notif-item-time">${formatRelativeTime(n.time)}</div>
            </div>
        </div>
    `).join('');
}

function initNotifications() {
    const wrap = document.getElementById('notifWrap');
    const btn = document.getElementById('notifBtn');
    const panel = document.getElementById('notifPanel');
    const clearBtn = document.getElementById('notifClearBtn');
    if (!wrap || !btn || !panel) return;

    function closePanel() {
        wrap.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const opening = !wrap.classList.contains('open');
        wrap.classList.toggle('open', opening);
        btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
        if (opening) {
            const rect = btn.getBoundingClientRect();
            panel.style.top = `${rect.bottom + 8}px`;
            panel.style.right = `${window.innerWidth - rect.right}px`;
            if (_notifications.some((n) => !n.read)) {
                _notifications.forEach((n) => { n.read = true; });
                renderNotifications();
            }
        }
    });

    document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) closePanel();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closePanel();
    });

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            _notifications = [];
            renderNotifications();
        });
    }

    renderNotifications();
}
