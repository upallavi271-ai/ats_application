-- ============================================================================
-- 003_frontend_contract_alignment.sql
-- The ATS frontend already has a full apiCall()/mapBackendCandidate()/
-- mapBackendJob() integration layer built in, expecting specific field names
-- (role_title, job_description, ai_score, application_ref, person_ref, etc).
-- This migration adds what candidates/jobs were missing so the existing
-- frontend code can talk to this backend with ZERO frontend changes for the
-- core Hiring / Requirements / Clients & BDE flows.
-- ============================================================================
BEGIN;

ALTER TABLE candidates
    ADD COLUMN job_title_text   VARCHAR(150),      -- 'job_title' in the API payload — free-text role when there's no linked requirement
    ADD COLUMN specialization   VARCHAR(120),
    ADD COLUMN location         VARCHAR(120),
    ADD COLUMN skills           TEXT,
    ADD COLUMN resume_text      TEXT,
    ADD COLUMN original_resume  TEXT,
    ADD COLUMN edited_resume    TEXT,
    ADD COLUMN resume_file_name VARCHAR(200),
    -- application_ref / person_ref: the frontend's mapper already expects a
    -- lightweight person/application distinction (so re-applying the same
    -- person to a second requirement doesn't read as a brand-new person).
    -- Implemented here as a simple self-reference rather than a full second
    -- table — every candidate row still IS one application; person_ref just
    -- points every application from the same email at the first one.
    ADD COLUMN person_ref       INT REFERENCES candidates(candidate_id);

-- jobs: the frontend's mapBackendJob() reads role_title / job_description,
-- not role / jd (those names were fine for the API I originally wrote, but
-- the frontend was built against this naming).
ALTER TABLE jobs RENAME COLUMN role TO role_title;
ALTER TABLE jobs RENAME COLUMN jd TO job_description;

COMMIT;
