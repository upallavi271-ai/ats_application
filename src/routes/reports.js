const express = require('express');
const pool = require('../db');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

// Period -> days back. 'overall' means no cutoff.
function cutoffClause(period, params) {
  const days = { today: 1, week: 7, month: 30, quarter: 90, year: 365 }[String(period || '').toLowerCase()];
  if (!days) return '';
  params.push(days);
  return ` AND c.applied_date >= CURRENT_DATE - ($${params.length}::int - 1)`;
}

const METRICS = `
  count(*) AS total,
  count(*) FILTER (WHERE c.stage IN ('Interview Scheduled','Interview Completed')) AS interviews,
  count(*) FILTER (WHERE c.stage IN ('Selected','Offer Sent','Accepted')) AS selected,
  count(*) FILTER (WHERE c.stage = 'Joined') AS joined,
  count(*) FILTER (WHERE c.stage = 'Rejected') AS rejected,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM follow_ups f WHERE f.candidate_id = c.candidate_id)) AS followed_up
`;

// GET /api/reports?period=  — overall + per-recruiter + per-department, all
// aggregated server-side over the caller's RBAC-scoped rows. Computing this
// in the browser only ever saw one browser's data.
router.get('/', requirePermission('reports', 'read'), async (req, res, next) => {
  try {
    const params = [req.user.userId];
    const scope = `WHERE c.created_by IN (SELECT visible_user_id FROM get_visible_user_ids($1))`;
    const cut = cutoffClause(req.query.period, params);

    const [overall, byRecruiter, byDept] = await Promise.all([
      pool.query(`SELECT ${METRICS} FROM candidates c ${scope}${cut}`, params),
      pool.query(`SELECT COALESCE(u.full_name,'Unassigned') AS recruiter, ${METRICS}
                  FROM candidates c LEFT JOIN users u ON u.user_id = c.owner_user_id
                  ${scope}${cut} GROUP BY u.full_name ORDER BY total DESC`, params),
      pool.query(`SELECT COALESCE(d.department_name,'—') AS department, ${METRICS}
                  FROM candidates c LEFT JOIN departments d ON d.department_id = c.department_id
                  ${scope}${cut} GROUP BY d.department_name ORDER BY total DESC`, params),
    ]);

    res.json({
      period: req.query.period || 'overall',
      overall: overall.rows[0],
      by_recruiter: byRecruiter.rows,
      by_department: byDept.rows,
    });
  } catch (err) { next(err); }
});

// GET /api/reports/:dimension?period=   dimension = recruiter | department | stage | source
router.get('/:dimension', requirePermission('reports', 'read'), async (req, res, next) => {
  try {
    const dims = {
      recruiter: ["COALESCE(u.full_name,'Unassigned')", 'LEFT JOIN users u ON u.user_id = c.owner_user_id'],
      department: ["COALESCE(d.department_name,'—')", 'LEFT JOIN departments d ON d.department_id = c.department_id'],
      stage: ['c.stage', ''],
      source: ["COALESCE(c.source,'Unknown')", ''],
    };
    const dim = dims[req.params.dimension];
    if (!dim) return res.status(400).json({ error: 'Unknown report dimension' });

    const params = [req.user.userId];
    const cut = cutoffClause(req.query.period, params);
    const { rows } = await pool.query(
      `SELECT ${dim[0]} AS label, ${METRICS}
       FROM candidates c ${dim[1]}
       WHERE c.created_by IN (SELECT visible_user_id FROM get_visible_user_ids($1))${cut}
       GROUP BY ${dim[0]} ORDER BY total DESC`, params
    );
    res.json({ dimension: req.params.dimension, period: req.query.period || 'overall', rows });
  } catch (err) { next(err); }
});

module.exports = router;
