-- ============================================================================
-- TeamLink ATS — RBAC + Hierarchical Data Scoping
-- PostgreSQL 13+ DDL
--
-- Design principles (per spec):
--   1. Module/action permissions are DATA (rows), editable by Admin via UI.
--   2. Row-level data visibility is SEPARATE from module permissions and is
--      driven by the reports_to_user_id chain via a RECURSIVE CTE — never by
--      per-role hardcoded filters. Adding a new level (e.g. "Assistant TL")
--      requires zero code changes.
--   3. Roles carry a data_scope MODE (data, not code):
--        'subtree'    -> self + everyone below via reports_to (Recruiter, TL, STL)
--                        (a Recruiter is simply a subtree with no children = self)
--        'department' -> self + everyone in the user's assigned department(s)
--                        (Manager, Assistant Manager)
--        'all'        -> no scoping filter (Admin, Super Admin)
--      New custom roles pick one of these modes; the recursion itself is generic.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. departments — extensible; not an enum
-- ---------------------------------------------------------------------------
CREATE TABLE departments (
    department_id   SERIAL PRIMARY KEY,
    department_name VARCHAR(100) NOT NULL UNIQUE,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. roles — is_system_role protects defaults; Admin may add custom roles
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
    role_id        SERIAL PRIMARY KEY,
    role_name      VARCHAR(100) NOT NULL UNIQUE,
    is_system_role BOOLEAN      NOT NULL DEFAULT FALSE,
    -- Row-level visibility mode (see header). Data, not code.
    data_scope     VARCHAR(20)  NOT NULL DEFAULT 'subtree'
                   CHECK (data_scope IN ('subtree', 'department', 'all')),
    -- Optional: rank for UI ordering / "can only manage roles below mine"
    hierarchy_level SMALLINT    NOT NULL DEFAULT 100,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. modules — the permissionable feature areas; extensible
-- ---------------------------------------------------------------------------
CREATE TABLE modules (
    module_id   SERIAL PRIMARY KEY,
    module_key  VARCHAR(60)  NOT NULL UNIQUE,   -- stable key used in code
    module_name VARCHAR(120) NOT NULL
);

-- ---------------------------------------------------------------------------
-- 4. permissions — module-wise, action-wise, per role. Admin-editable rows.
--    (module/action permissions ONLY — row visibility is handled separately)
-- ---------------------------------------------------------------------------
CREATE TABLE permissions (
    permission_id SERIAL  PRIMARY KEY,
    role_id       INT     NOT NULL REFERENCES roles(role_id)     ON DELETE CASCADE,
    module_id     INT     NOT NULL REFERENCES modules(module_id) ON DELETE CASCADE,
    can_create    BOOLEAN NOT NULL DEFAULT FALSE,
    can_read      BOOLEAN NOT NULL DEFAULT FALSE,
    can_update    BOOLEAN NOT NULL DEFAULT FALSE,
    can_delete    BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by    INT,                            -- FK added after users exists
    UNIQUE (role_id, module_id)
);

-- ---------------------------------------------------------------------------
-- 5. users — reports_to_user_id drives the ENTIRE hierarchy
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    user_id            SERIAL PRIMARY KEY,
    full_name          VARCHAR(150) NOT NULL,
    email              VARCHAR(255) NOT NULL UNIQUE,
    password_hash      VARCHAR(255) NOT NULL,
    role_id            INT NOT NULL REFERENCES roles(role_id),
    -- NULL for STL / Admin / Super Admin (cross-department by design).
    department_id      INT NULL REFERENCES departments(department_id),
    -- Self-referencing FK: the org chart. NULL only for the top (Super Admin).
    reports_to_user_id INT NULL REFERENCES users(user_id),
    is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (reports_to_user_id IS NULL OR reports_to_user_id <> user_id)
);

CREATE INDEX idx_users_reports_to  ON users (reports_to_user_id);
CREATE INDEX idx_users_department  ON users (department_id);
CREATE INDEX idx_users_role        ON users (role_id);

ALTER TABLE permissions
    ADD CONSTRAINT fk_permissions_updated_by
    FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 5b. user_departments — extra department assignments for department-scoped
--     roles ("entire assigned department(s)" — a Manager may hold several).
--     users.department_id remains the primary assignment; rows here extend it.
-- ---------------------------------------------------------------------------
CREATE TABLE user_departments (
    user_id       INT NOT NULL REFERENCES users(user_id)             ON DELETE CASCADE,
    department_id INT NOT NULL REFERENCES departments(department_id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, department_id)
);

-- ---------------------------------------------------------------------------
-- 6. candidates — every core record carries created_by + department_id
-- ---------------------------------------------------------------------------
CREATE TABLE candidates (
    candidate_id  SERIAL PRIMARY KEY,
    full_name     VARCHAR(150) NOT NULL,
    email         VARCHAR(255),
    phone         VARCHAR(30),
    current_stage VARCHAR(60)  NOT NULL DEFAULT 'Sourced',
    job_title     VARCHAR(150),
    -- REQUIRED on every row: who created it and which department it belongs to.
    created_by    INT NOT NULL REFERENCES users(user_id),
    department_id INT NOT NULL REFERENCES departments(department_id),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- These two indexes are what make the scoping filter cheap at scale.
CREATE INDEX idx_candidates_created_by ON candidates (created_by);
CREATE INDEX idx_candidates_department ON candidates (department_id);

-- ============================================================================
-- SEED DATA — defaults only; all of it is editable via Admin UI afterwards
-- ============================================================================

INSERT INTO departments (department_name) VALUES
    ('BDE'), ('Medical'), ('Manufacturing'), ('Education');

INSERT INTO roles (role_name, is_system_role, data_scope, hierarchy_level) VALUES
    ('Super Admin',        TRUE, 'all',        0),
    ('Admin',              TRUE, 'all',        10),
    ('Manager',            TRUE, 'department', 20),
    ('Assistant Manager',  TRUE, 'department', 30),
    ('STL',                TRUE, 'subtree',    40),  -- cross-dept oversight via reports_to
    ('TL - BDE',           TRUE, 'subtree',    50),
    ('TL - Medical',       TRUE, 'subtree',    50),
    ('TL - Manufacturing', TRUE, 'subtree',    50),
    ('TL - Education',     TRUE, 'subtree',    50),
    ('Recruiter',          TRUE, 'subtree',    60);  -- no subordinates => self only

INSERT INTO modules (module_key, module_name) VALUES
    ('candidates',        'Candidate Profiles'),
    ('job_postings',      'Job Postings'),
    ('interviews',        'Interview Scheduling'),
    ('reports',           'Reports / Analytics'),
    ('user_role_mgmt',    'User & Role Management'),
    ('department_config', 'Department Config');

-- Default permission matrix (rows, not code — Admin toggles these via UI).
-- NOTE on STL: seeded VIEW-ONLY on operational modules per spec
--   ("view-only oversight — confirm with product owner before granting edit
--    rights"); flipping can_update to TRUE later is a data change, no deploy.
INSERT INTO permissions (role_id, module_id, can_create, can_read, can_update, can_delete)
SELECT r.role_id, m.module_id, p.c, p.r, p.u, p.d
FROM (VALUES
    -- role_name,            module_key,          C,     R,     U,     D
    -- Super Admin & Admin: full CRUD everywhere
    ('Super Admin', 'candidates',        TRUE,  TRUE,  TRUE,  TRUE ),
    ('Super Admin', 'job_postings',      TRUE,  TRUE,  TRUE,  TRUE ),
    ('Super Admin', 'interviews',        TRUE,  TRUE,  TRUE,  TRUE ),
    ('Super Admin', 'reports',           TRUE,  TRUE,  TRUE,  TRUE ),
    ('Super Admin', 'user_role_mgmt',    TRUE,  TRUE,  TRUE,  TRUE ),
    ('Super Admin', 'department_config', TRUE,  TRUE,  TRUE,  TRUE ),
    ('Admin',       'candidates',        TRUE,  TRUE,  TRUE,  TRUE ),
    ('Admin',       'job_postings',      TRUE,  TRUE,  TRUE,  TRUE ),
    ('Admin',       'interviews',        TRUE,  TRUE,  TRUE,  TRUE ),
    ('Admin',       'reports',           TRUE,  TRUE,  TRUE,  TRUE ),
    ('Admin',       'user_role_mgmt',    TRUE,  TRUE,  TRUE,  TRUE ),
    ('Admin',       'department_config', TRUE,  TRUE,  TRUE,  TRUE ),
    -- Manager / Assistant Manager: CRUD inside department scope
    ('Manager',           'candidates',        TRUE,  TRUE,  TRUE,  TRUE ),
    ('Manager',           'job_postings',      TRUE,  TRUE,  TRUE,  TRUE ),
    ('Manager',           'interviews',        TRUE,  TRUE,  TRUE,  TRUE ),
    ('Manager',           'reports',           FALSE, TRUE,  FALSE, FALSE),
    ('Manager',           'user_role_mgmt',    FALSE, TRUE,  FALSE, FALSE),
    ('Manager',           'department_config', FALSE, TRUE,  FALSE, FALSE),
    ('Assistant Manager', 'candidates',        TRUE,  TRUE,  TRUE,  TRUE ),
    ('Assistant Manager', 'job_postings',      TRUE,  TRUE,  TRUE,  TRUE ),
    ('Assistant Manager', 'interviews',        TRUE,  TRUE,  TRUE,  TRUE ),
    ('Assistant Manager', 'reports',           FALSE, TRUE,  FALSE, FALSE),
    ('Assistant Manager', 'user_role_mgmt',    FALSE, TRUE,  FALSE, FALSE),
    ('Assistant Manager', 'department_config', FALSE, TRUE,  FALSE, FALSE),
    -- STL: view/report access across departments (view-only oversight)
    ('STL', 'candidates',        FALSE, TRUE,  FALSE, FALSE),
    ('STL', 'job_postings',      FALSE, TRUE,  FALSE, FALSE),
    ('STL', 'interviews',        FALSE, TRUE,  FALSE, FALSE),
    ('STL', 'reports',           FALSE, TRUE,  FALSE, FALSE),
    ('STL', 'user_role_mgmt',    FALSE, FALSE, FALSE, FALSE),
    ('STL', 'department_config', FALSE, TRUE,  FALSE, FALSE),
    -- Recruiter: C/R/U on own records, NO delete, no admin modules
    ('Recruiter', 'candidates',        TRUE,  TRUE,  TRUE,  FALSE),
    ('Recruiter', 'job_postings',      FALSE, TRUE,  FALSE, FALSE),
    ('Recruiter', 'interviews',        TRUE,  TRUE,  TRUE,  FALSE),
    ('Recruiter', 'reports',           FALSE, FALSE, FALSE, FALSE),
    ('Recruiter', 'user_role_mgmt',    FALSE, FALSE, FALSE, FALSE),
    ('Recruiter', 'department_config', FALSE, FALSE, FALSE, FALSE)
) AS p(role_name, module_key, c, r, u, d)
JOIN roles   r ON r.role_name  = p.role_name
JOIN modules m ON m.module_key = p.module_key;

-- All four TL roles share the same matrix: CRUD on own team's records,
-- view-only on org-wide config.
INSERT INTO permissions (role_id, module_id, can_create, can_read, can_update, can_delete)
SELECT r.role_id, m.module_id, p.c, p.r, p.u, p.d
FROM (VALUES
    ('candidates',        TRUE,  TRUE,  TRUE,  TRUE ),
    ('job_postings',      TRUE,  TRUE,  TRUE,  FALSE),
    ('interviews',        TRUE,  TRUE,  TRUE,  TRUE ),
    ('reports',           FALSE, TRUE,  FALSE, FALSE),
    ('user_role_mgmt',    FALSE, FALSE, FALSE, FALSE),
    ('department_config', FALSE, TRUE,  FALSE, FALSE)
) AS p(module_key, c, r, u, d)
JOIN modules m ON m.module_key = p.module_key
CROSS JOIN roles r
WHERE r.role_name IN ('TL - BDE', 'TL - Medical', 'TL - Manufacturing', 'TL - Education');

-- ============================================================================
-- THE REUSABLE SCOPING FUNCTION (database-side canonical implementation)
--
-- get_visible_user_ids(p_user_id) returns the set of user_ids whose records
-- the given user may see. Every data-fetch query then filters:
--     WHERE created_by IN (SELECT * FROM get_visible_user_ids($current_user))
--
-- 'all'-scope roles return ALL user ids (equivalent to no filter; callers may
-- skip the join entirely for those roles as an optimization).
-- ============================================================================
CREATE OR REPLACE FUNCTION get_visible_user_ids(p_user_id INT)
RETURNS TABLE (visible_user_id INT)
LANGUAGE sql STABLE AS
$$
WITH me AS (
    SELECT u.user_id, u.department_id, r.data_scope
    FROM users u
    JOIN roles r ON r.role_id = u.role_id
    WHERE u.user_id = p_user_id
),
-- Recursive walk DOWN the reports_to_user_id chain from the current user.
-- Generic for ANY depth: STL -> TL -> (future Assistant TL) -> Recruiter all
-- resolve with the same query. Cycle-safe via path tracking.
subordinates AS (
    WITH RECURSIVE tree AS (
        SELECT u.user_id, ARRAY[u.user_id] AS path
        FROM users u
        WHERE u.user_id = p_user_id
        UNION ALL
        SELECT c.user_id, t.path || c.user_id
        FROM users c
        JOIN tree t ON c.reports_to_user_id = t.user_id
        WHERE NOT c.user_id = ANY(t.path)          -- cycle guard
    )
    SELECT user_id FROM tree
),
my_departments AS (
    SELECT department_id FROM me WHERE department_id IS NOT NULL
    UNION
    SELECT ud.department_id FROM user_departments ud
    WHERE ud.user_id = p_user_id
)
SELECT u.user_id
FROM users u, me
WHERE
    CASE me.data_scope
        WHEN 'all'        THEN TRUE
        WHEN 'department' THEN u.user_id = me.user_id
                               OR u.department_id IN (SELECT department_id FROM my_departments)
        ELSE                   u.user_id IN (SELECT user_id FROM subordinates)  -- 'subtree'
    END;
$$;

-- Convenience: candidates already scoped for a given viewer. API layer calls
-- this (or the service-layer equivalent) — NEVER a bare SELECT ... FROM candidates.
CREATE OR REPLACE FUNCTION get_visible_candidates(p_user_id INT)
RETURNS SETOF candidates
LANGUAGE sql STABLE AS
$$
    SELECT c.*
    FROM candidates c
    WHERE c.created_by IN (SELECT visible_user_id FROM get_visible_user_ids(p_user_id));
$$;

-- ============================================================================
-- OPTIONAL, RECOMMENDED: enforce at the database itself with Row-Level
-- Security, so even a buggy endpoint cannot leak rows. The app sets
--   SET LOCAL app.current_user_id = '<user_id>';
-- on every transaction (e.g. in the DB middleware).
-- ============================================================================
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY candidates_visibility ON candidates
    USING (
        created_by IN (
            SELECT visible_user_id
            FROM get_visible_user_ids(current_setting('app.current_user_id', TRUE)::INT)
        )
    );

COMMIT;
