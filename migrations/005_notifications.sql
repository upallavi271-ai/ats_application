-- ============================================================================
-- 005_notifications.sql
-- Server-side notifications. Previously the frontend kept alerts in
-- S.alerts (browser-only), so one person's notification was invisible to
-- everyone else. These rows are per-recipient and drive the header bell
-- count via /api/notifications.
-- ============================================================================
BEGIN;

CREATE TABLE notifications (
    notification_id SERIAL PRIMARY KEY,
    user_id         INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    message         TEXT NOT NULL,
    link_ref        VARCHAR(60),          -- e.g. the application/candidate id it refers to
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user   ON notifications (user_id, is_read);
CREATE INDEX idx_notifications_created ON notifications (created_at DESC);

COMMIT;
