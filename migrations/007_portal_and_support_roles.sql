-- ============================================================================
-- 007_portal_and_support_roles.sql
-- rbac_schema.sql seeded the 10 internal STAFF roles, but the ATS frontend
-- has 12+ including external portal users (Client, Client Viewer, Candidate)
-- and two internal ones it was missing (BDE, Accountant). Without these rows
-- those logins can't exist at all.
--
-- data_scope for portal roles is 'subtree' (= self only, no subordinates).
-- That is deliberate belt-and-braces: portal endpoints scope by the login's
-- linked client_id / candidate email rather than the reports_to chain, so
-- even if a portal user somehow reached a staff endpoint, 'subtree' with no
-- subordinates returns only their own rows rather than an org-wide leak.
-- ============================================================================
BEGIN;

INSERT INTO roles (role_name, is_system_role, data_scope, hierarchy_level)
SELECT v.name, TRUE, v.scope, v.lvl
FROM (VALUES
    ('BDE',           'subtree',    55),
    ('Accountant',    'all',        45),
    ('Client',        'subtree',    90),
    ('Client Viewer', 'subtree',    95),
    ('Candidate',     'subtree',    99)
) AS v(name, scope, lvl)
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.role_name = v.name);

-- Permission matrix. Deny by default: a missing row = no access, so every
-- grant below is explicit and minimal.
INSERT INTO permissions (role_id, module_id, can_create, can_read, can_update, can_delete)
SELECT r.role_id, m.module_id, p.c, p.r, p.u, p.d
FROM (VALUES
    -- BDE: works client-side of the pipeline; no deletes, no admin modules.
    ('BDE', 'candidates',        TRUE,  TRUE,  TRUE,  FALSE),
    ('BDE', 'job_postings',      TRUE,  TRUE,  TRUE,  FALSE),
    ('BDE', 'interviews',        TRUE,  TRUE,  TRUE,  FALSE),
    ('BDE', 'reports',           FALSE, TRUE,  FALSE, FALSE),
    ('BDE', 'user_role_mgmt',    FALSE, FALSE, FALSE, FALSE),
    ('BDE', 'department_config', FALSE, FALSE, FALSE, FALSE),
    -- Accountant: billing only. No candidate pipeline access at all.
    ('Accountant', 'candidates',        FALSE, FALSE, FALSE, FALSE),
    ('Accountant', 'job_postings',      FALSE, FALSE, FALSE, FALSE),
    ('Accountant', 'interviews',        FALSE, FALSE, FALSE, FALSE),
    ('Accountant', 'reports',           FALSE, TRUE,  FALSE, FALSE),
    ('Accountant', 'user_role_mgmt',    FALSE, FALSE, FALSE, FALSE),
    ('Accountant', 'department_config', FALSE, FALSE, FALSE, FALSE)
) AS p(role_name, module_key, c, r, u, d)
JOIN roles r ON r.role_name = p.role_name
JOIN modules m ON m.module_key = p.module_key
WHERE NOT EXISTS (
    SELECT 1 FROM permissions x WHERE x.role_id = r.role_id AND x.module_id = m.module_id
);

-- Client / Client Viewer / Candidate get NO rows in `permissions` on
-- purpose: every staff module stays denied for them. Their access comes
-- solely from /api/portal/*, which authorizes by their linked client_id or
-- candidate email instead of the module matrix.

COMMIT;
