const express = require('express');
const pool = require('../db');
const { requirePermission } = require('../middleware/permissions');
const { broadcast } = require('../realtime');

const router = express.Router();

// GET /api/jobs — column names match mapBackendJob() in the frontend exactly
// (role_title, job_description, client_name, owner_name, department_name).
router.get('/', requirePermission('job_postings', 'read'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT j.job_id, j.role_title, j.job_description, j.status, j.priority,
              j.openings, j.location, j.salary_min, j.salary_max, j.deadline,
              j.posted_at, j.active_date, j.created_at,
              cl.client_id, cl.name AS client_name,
              d.department_name, u.full_name AS owner_name,
              (SELECT count(*) FROM candidates c WHERE c.applied_job_id = j.job_id) AS candidate_count
       FROM jobs j
       JOIN clients cl ON cl.client_id = j.client_id
       LEFT JOIN departments d ON d.department_id = j.department_id
       LEFT JOIN users u ON u.user_id = j.owner_user_id
       WHERE (j.owner_user_id IN (SELECT visible_user_id FROM get_visible_user_ids($1)) OR j.owner_user_id IS NULL)
       ORDER BY j.created_at DESC`,
      [req.user.userId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/jobs — matches the exact payload the frontend sends.
router.post('/', requirePermission('job_postings', 'create'), async (req, res, next) => {
  try {
    const { client_id, role_title, job_description, openings, deadline, priority,
            department_id, location, active_date, salary_min, salary_max } = req.body;
    if (!client_id || !role_title) return res.status(400).json({ error: 'client_id and role_title are required' });

    const { rows } = await pool.query(
      `INSERT INTO jobs (client_id, role_title, job_description, priority, owner_user_id, department_id,
                          openings, location, deadline, active_date, salary_min, salary_max)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING job_id`,
      [client_id, role_title, job_description || null, priority || null, req.user.userId, department_id || null,
       openings || 1, location || null, deadline || null, active_date || null, salary_min || null, salary_max || null]
    );
    broadcast('job.created', {});
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.patch('/:id/status', requirePermission('job_postings', 'update'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['Open', 'On Hold', 'Closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { rows } = await pool.query('UPDATE jobs SET status = $1 WHERE job_id = $2 RETURNING *', [status, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    broadcast('job.updated', {});
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
