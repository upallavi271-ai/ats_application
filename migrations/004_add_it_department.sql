-- ============================================================================
-- 004_add_it_department.sql
-- rbac_schema.sql seeded 4 departments (BDE, Medical, Manufacturing,
-- Education) — but the ATS frontend's demo data and filters already assume
-- an IT department too (e.g. the Java Developer / Nexawave requirement used
-- throughout Requirements & Hiring). Adding it here rather than reordering
-- the existing 4 (which already have candidates/jobs/users pointing at
-- their ids from migrations 002/003's flow) is the non-destructive fix.
-- ============================================================================
BEGIN;

INSERT INTO departments (department_name)
SELECT 'IT'
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE department_name = 'IT');

COMMIT;
