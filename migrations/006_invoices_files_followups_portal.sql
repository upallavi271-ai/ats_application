-- ============================================================================
-- 006_invoices_files_followups_portal.sql
-- Completes the last locally-stored modules: Accountant/invoices, resume
-- file storage, follow-up logs, and the identity links the Candidate and
-- Client portals need to scope a login to "only my own data".
-- ============================================================================
BEGIN;

-- --- Invoices: replace the thin 002 table with the full billing shape the
--     frontend's loadInvoicesFromBackend() maps (base/gst/tds/total/received/
--     balance/dates). Dropping is safe: nothing has written to it yet.
DROP TABLE IF EXISTS invoices;
CREATE TABLE invoices (
    invoice_id      SERIAL PRIMARY KEY,
    client_id       INT NOT NULL REFERENCES clients(client_id),
    candidate_id    INT REFERENCES candidates(candidate_id),
    base_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
    gst_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
    tds_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
    amount_received NUMERIC(12,2) NOT NULL DEFAULT 0,
    invoice_date    DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date        DATE,
    created_by      INT REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_invoices_client ON invoices (client_id);

-- total_payable / balance_due / status are DERIVED, so they can never drift
-- out of sync with the amounts the way duplicated columns would.
CREATE OR REPLACE VIEW invoice_view AS
SELECT i.*,
       cl.name AS client_name,
       c.full_name AS candidate_name,
       (i.base_amount + i.gst_amount - i.tds_amount) AS total_payable,
       (i.base_amount + i.gst_amount - i.tds_amount - i.amount_received) AS balance_due,
       CASE
         WHEN i.amount_received >= (i.base_amount + i.gst_amount - i.tds_amount) THEN 'Paid'
         WHEN i.due_date IS NOT NULL AND i.due_date < CURRENT_DATE THEN 'Overdue'
         ELSE 'Pending'
       END AS status
FROM invoices i
JOIN clients cl ON cl.client_id = i.client_id
LEFT JOIN candidates c ON c.candidate_id = i.candidate_id;

CREATE TABLE invoice_payments (
    payment_id SERIAL PRIMARY KEY,
    invoice_id INT NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
    amount     NUMERIC(12,2) NOT NULL,
    method     VARCHAR(40),
    paid_on    DATE NOT NULL DEFAULT CURRENT_DATE,
    recorded_by INT REFERENCES users(user_id)
);

-- --- Real file storage. Bytes live in the DB (bytea) rather than on disk:
--     Render's free filesystem is ephemeral, so disk-stored resumes would
--     silently vanish on every redeploy.
CREATE TABLE candidate_files (
    file_id       SERIAL PRIMARY KEY,
    candidate_id  INT NOT NULL REFERENCES candidates(candidate_id) ON DELETE CASCADE,
    original_name VARCHAR(255) NOT NULL,
    mime_type     VARCHAR(120),
    kind          VARCHAR(40),
    bytes         BYTEA NOT NULL,
    size_bytes    INT NOT NULL,
    uploaded_by   INT REFERENCES users(user_id),
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_candidate_files_candidate ON candidate_files (candidate_id);

-- --- Follow-up call log (was browser-only, so a TL never saw a recruiter's
--     follow-ups).
CREATE TABLE follow_ups (
    follow_up_id SERIAL PRIMARY KEY,
    candidate_id INT NOT NULL REFERENCES candidates(candidate_id) ON DELETE CASCADE,
    contacted    BOOLEAN NOT NULL DEFAULT TRUE,
    outcome      VARCHAR(80),
    notes        TEXT,
    due_date     DATE,
    created_by   INT REFERENCES users(user_id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_follow_ups_candidate ON follow_ups (candidate_id);
CREATE INDEX idx_follow_ups_due ON follow_ups (due_date);

-- --- Portal identity links. A Client login must see exactly one client's
--     data; a Candidate login exactly their own applications. Without these
--     the portals have no safe way to scope.
ALTER TABLE users ADD COLUMN client_id INT REFERENCES clients(client_id);
ALTER TABLE users ADD COLUMN candidate_email VARCHAR(255);

COMMIT;
