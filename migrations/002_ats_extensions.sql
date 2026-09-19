-- ============================================================================
-- 002_ats_extensions.sql
-- Builds on 001_rbac_core.sql (your existing RBAC schema, unchanged).
-- Adds everything the TeamLink ATS frontend needs that the RBAC schema didn't
-- yet cover: teams (TL grouping), clients, job requirements, invoices, and
-- the extra candidate fields the UI already reads/writes (stage machine,
-- interview, feedback, history, match score, etc).
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- teams — groups recruiters/BDE under a TL, within a department.
-- (users.team in the old single-file app was a free-text match on this name.)
-- ---------------------------------------------------------------------------
CREATE TABLE teams (
    team_id       SERIAL PRIMARY KEY,
    team_name     VARCHAR(100) NOT NULL,
    department_id INT REFERENCES departments(department_id),
    tl_user_id    INT REFERENCES users(user_id),
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (team_name, department_id)
);

ALTER TABLE users ADD COLUMN team_id INT REFERENCES teams(team_id);

-- ---------------------------------------------------------------------------
-- clients — company records; BDE-owned.
-- ---------------------------------------------------------------------------
CREATE TABLE clients (
    client_id        SERIAL PRIMARY KEY,
    name             VARCHAR(200) NOT NULL,
    contact          VARCHAR(150),
    industry         VARCHAR(100),
    city             VARCHAR(100),
    status           VARCHAR(20) NOT NULL DEFAULT 'Active'
                     CHECK (status IN ('Active','Paused','Archived')),
    agreement_status VARCHAR(30) NOT NULL DEFAULT 'Draft'
                     CHECK (agreement_status IN ('Draft','Pending Signature','Signed & Active','Declined','Expired')),
    gst              VARCHAR(20),
    tds              VARCHAR(20),
    owner_user_id    INT REFERENCES users(user_id),   -- the BDE who owns this account
    active_date      DATE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_clients_owner ON clients (owner_user_id);

-- ---------------------------------------------------------------------------
-- jobs — requirements raised against a client.
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
    job_id        SERIAL PRIMARY KEY,
    client_id     INT NOT NULL REFERENCES clients(client_id),
    role          VARCHAR(200) NOT NULL,
    jd            TEXT,
    status        VARCHAR(20) NOT NULL DEFAULT 'Open'
                  CHECK (status IN ('Open','On Hold','Closed')),
    priority      VARCHAR(10) CHECK (priority IN ('High','Medium','Low')),
    owner_user_id INT REFERENCES users(user_id),       -- recruiter/TL responsible
    department_id INT REFERENCES departments(department_id),
    openings      INT NOT NULL DEFAULT 1,
    location      VARCHAR(120),
    salary_min    NUMERIC(12,2),
    salary_max    NUMERIC(12,2),
    deadline      DATE,
    posted_at     DATE NOT NULL DEFAULT CURRENT_DATE,
    active_date   DATE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_jobs_client ON jobs (client_id);
CREATE INDEX idx_jobs_owner  ON jobs (owner_user_id);
CREATE INDEX idx_jobs_status ON jobs (status);

-- ---------------------------------------------------------------------------
-- candidates — extend the RBAC schema's table with the real stage machine
-- and the fields the frontend already reads (interview, feedback, history…).
-- current_stage (from 001) is left in place but superseded by `stage` below,
-- which is the column the API actually uses.
-- ---------------------------------------------------------------------------
ALTER TABLE candidates
    ADD COLUMN applied_job_id     INT REFERENCES jobs(job_id),
    ADD COLUMN owner_user_id      INT REFERENCES users(user_id),   -- recruiter who owns this candidate
    ADD COLUMN stage              VARCHAR(30) NOT NULL DEFAULT 'Applied'
                                   CHECK (stage IN (
                                     'Applied','Resume Screening','Shortlisted','Recruiter Reviewed',
                                     'With BDE','Shared with Client','Interview Scheduled','Interview Completed',
                                     'Selected','Offer Sent','Accepted','Joined','Hold','Rejected'
                                   )),
    ADD COLUMN score              SMALLINT CHECK (score BETWEEN 0 AND 100),
    ADD COLUMN source             VARCHAR(60),
    ADD COLUMN college            VARCHAR(150),
    ADD COLUMN expected_salary    NUMERIC(12,2),
    ADD COLUMN notice_period      VARCHAR(40),
    ADD COLUMN client_decision    VARCHAR(20) DEFAULT 'Pending'
                                   CHECK (client_decision IN ('Pending','Approved','Rejected')),
    ADD COLUMN interview          JSONB,       -- {date,time,round,mode,panel,link,dateISO}
    ADD COLUMN feedback           JSONB,       -- {recommendation,notes,ratedBy,ratedAt}
    ADD COLUMN history            JSONB NOT NULL DEFAULT '[]', -- [[stage,note,date], ...]
    ADD COLUMN rejection_reason   TEXT,
    ADD COLUMN rejected_by        VARCHAR(150),
    ADD COLUMN recruiter_verified BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN bde_verified       BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN applied_date       DATE NOT NULL DEFAULT CURRENT_DATE;

CREATE INDEX idx_candidates_stage      ON candidates (stage);
CREATE INDEX idx_candidates_owner_user ON candidates (owner_user_id);
CREATE INDEX idx_candidates_job        ON candidates (applied_job_id);

-- ---------------------------------------------------------------------------
-- invoices — for the Accountant/Clients & BDE revenue figures.
-- ---------------------------------------------------------------------------
CREATE TABLE invoices (
    invoice_id SERIAL PRIMARY KEY,
    client_id  INT NOT NULL REFERENCES clients(client_id),
    base       NUMERIC(12,2) NOT NULL DEFAULT 0,
    gst        NUMERIC(12,2) NOT NULL DEFAULT 0,
    tds        NUMERIC(12,2) NOT NULL DEFAULT 0,
    status     VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Paid','Overdue')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_invoices_client ON invoices (client_id);

-- ---------------------------------------------------------------------------
-- Extend get_visible_user_ids-based helpers to jobs/clients too, so every
-- module reuses the SAME scoping rule from 001 — no per-module hardcoding.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_visible_jobs(p_user_id INT)
RETURNS SETOF jobs
LANGUAGE sql STABLE AS
$$
    SELECT j.*
    FROM jobs j
    WHERE j.owner_user_id IN (SELECT visible_user_id FROM get_visible_user_ids(p_user_id))
       OR j.owner_user_id IS NULL;
$$;

COMMIT;
