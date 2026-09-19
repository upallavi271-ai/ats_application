const express = require('express');
const pool = require('../db');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

// GET /api/dashboard/summary — the numbers the Dashboard workspace needs,
// all scoped by the same get_visible_user_ids() rule every other module uses.
router.get('/summary', requirePermission('reports', 'read'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         count(*) FILTER (WHERE true) AS total_candidates,
         count(*) FILTER (WHERE stage = 'Applied') AS applied,
         count(*) FILTER (WHERE stage IN ('Interview Scheduled','Interview Completed')) AS interviewing,
         count(*) FILTER (WHERE stage = 'Selected') AS selected,
         count(*) FILTER (WHERE stage IN ('Offer Sent','Accepted')) AS offers,
         count(*) FILTER (WHERE stage = 'Joined') AS joined,
         count(*) FILTER (WHERE stage = 'Rejected') AS rejected
       FROM candidates
       WHERE created_by IN (SELECT visible_user_id FROM get_visible_user_ids($1))`,
      [req.user.userId]
    );
    const { rows: jobRows } = await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'Open') AS open_requirements
       FROM jobs WHERE owner_user_id IN (SELECT visible_user_id FROM get_visible_user_ids($1)) OR owner_user_id IS NULL`,
      [req.user.userId]
    );
    res.json({ ...rows[0], ...jobRows[0] });
  } catch (err) { next(err); }
});

// GET /api/dashboard/departments — { "1": "BDE", "2": "Medical", ... }
// Department IDs are auto-incremented by Postgres, so they won't always be
// 1..5 in the order the frontend originally assumed (e.g. a fresh deploy
// vs. one that's re-run migrations a few times). The frontend fetches this
// once at login and merges it into its DEPT_ID_TO_NAME map instead of
// trusting a hardcoded guess.
router.get('/departments', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT department_id, department_name FROM departments ORDER BY department_id');
    const map = {};
    rows.forEach((r) => { map[r.department_id] = r.department_name; });
    res.json(map);
  } catch (err) { next(err); }
});

// GET /api/dashboard/kpis — the numbers the Super Admin/Admin dashboard
// cards show. Field names match window.__kpiOverride in the frontend
// exactly; everything is scoped through get_visible_user_ids() so a TL's
// dashboard shows their team's numbers, not the company's.
router.get('/kpis', requirePermission('reports', 'read'), async (req, res, next) => {
  try {
    const uid = [req.user.userId];
    const { rows: c } = await pool.query(
      `SELECT
         count(*) AS total_candidates,
         count(*) FILTER (WHERE stage NOT IN ('Rejected','Joined','Hold')) AS active,
         count(*) FILTER (WHERE stage IN ('Rejected','Hold')) AS inactive,
         count(*) FILTER (WHERE applied_date = CURRENT_DATE) AS new_today,
         count(*) FILTER (WHERE stage IN ('Interview Scheduled','Interview Completed')) AS interviews,
         count(*) FILTER (WHERE stage = 'Shared with Client' AND (client_decision IS NULL OR client_decision = 'Pending')) AS pending_approvals,
         count(*) FILTER (WHERE stage = 'Joined') AS placements,
         count(*) FILTER (WHERE stage = 'Rejected') AS rejected
       FROM candidates
       WHERE created_by IN (SELECT visible_user_id FROM get_visible_user_ids($1))`, uid);
    const { rows: j } = await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'Open') AS open_requirements
       FROM jobs WHERE owner_user_id IN (SELECT visible_user_id FROM get_visible_user_ids($1)) OR owner_user_id IS NULL`, uid);
    const { rows: s } = await pool.query(
      `SELECT count(*) AS total_staff FROM users
       WHERE is_active AND user_id IN (SELECT visible_user_id FROM get_visible_user_ids($1))`, uid);
    const { rows: byDept } = await pool.query(
      `SELECT d.department_name, count(c.candidate_id) AS count
       FROM departments d
       LEFT JOIN candidates c ON c.department_id = d.department_id
         AND c.created_by IN (SELECT visible_user_id FROM get_visible_user_ids($1))
       GROUP BY d.department_name ORDER BY d.department_name`, uid);

    res.json({ ...c[0], ...j[0], ...s[0], by_department: byDept });
  } catch (err) { next(err); }
});

module.exports = router;
