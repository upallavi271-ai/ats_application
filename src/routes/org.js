const express = require('express');
const pool = require('../db');
const { requirePermission } = require('../middleware/permissions');
const { broadcast } = require('../realtime');

const router = express.Router();

// --- Departments ---
router.get('/departments', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM departments ORDER BY department_name');
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/departments', requirePermission('department_config', 'create'), async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      'INSERT INTO departments (department_name) VALUES ($1) RETURNING *', [name.trim()]
    );
    broadcast('department.created', {});
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That department already exists' });
    next(err);
  }
});

// Deactivate rather than hard-delete: users, jobs and candidates point at
// department_id, so removing the row would orphan real records.
router.patch('/departments/:id', requirePermission('department_config', 'update'), async (req, res, next) => {
  try {
    const { is_active, name } = req.body;
    const { rows } = await pool.query(
      `UPDATE departments SET
         is_active = COALESCE($1, is_active),
         department_name = COALESCE($2, department_name)
       WHERE department_id = $3 RETURNING *`,
      [is_active === undefined ? null : is_active, name || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Department not found' });
    broadcast('department.updated', {});
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// --- Teams ---
router.get('/teams', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, d.department_name FROM teams t
       LEFT JOIN departments d ON d.department_id = t.department_id
       ORDER BY d.department_name, t.team_name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/teams', requirePermission('department_config', 'create'), async (req, res, next) => {
  try {
    const { name, department_id, department_name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    let deptId = department_id;
    if (!deptId && department_name) {
      const d = await pool.query('SELECT department_id FROM departments WHERE department_name = $1', [department_name]);
      deptId = d.rows.length ? d.rows[0].department_id : null;
    }
    const { rows } = await pool.query(
      'INSERT INTO teams (team_name, department_id) VALUES ($1,$2) RETURNING *', [name.trim(), deptId]
    );
    broadcast('team.created', {});
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That team already exists in this department' });
    next(err);
  }
});

router.patch('/teams/:id', requirePermission('department_config', 'update'), async (req, res, next) => {
  try {
    const { active, name } = req.body;
    const { rows } = await pool.query(
      `UPDATE teams SET active = COALESCE($1, active), team_name = COALESCE($2, team_name)
       WHERE team_id = $3 RETURNING *`,
      [active === undefined ? null : active, name || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Team not found' });
    broadcast('team.updated', {});
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
