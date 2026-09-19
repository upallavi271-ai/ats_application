const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.get('/', requirePermission('user_role_mgmt', 'read'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.user_id, u.full_name, u.email, u.is_active, u.department_id, u.team_id,
              d.department_name, r.role_name, r.role_id
       FROM users u
       JOIN roles r ON r.role_id = u.role_id
       LEFT JOIN departments d ON d.department_id = u.department_id
       ORDER BY u.full_name`
    );

    // The Users screen reads can_edit off the first row to decide whether to
    // show "+ Add user" or fall back to view-only. Without it the button is
    // permanently disabled, so the caller's own update-permission is resolved
    // here from the same permissions table every other check uses.
    const { rows: perm } = await pool.query(
      `SELECT p.can_update
       FROM permissions p
       JOIN users u ON u.role_id = p.role_id
       JOIN modules m ON m.module_id = p.module_id
       WHERE u.user_id = $1 AND m.module_key = 'user_role_mgmt'`,
      [req.user.userId]
    );
    const canEdit = perm.length ? !!perm[0].can_update : false;
    res.json(rows.map((r) => ({ ...r, can_edit: canEdit })));
  } catch (err) { next(err); }
});

router.post('/', requirePermission('user_role_mgmt', 'create'), async (req, res, next) => {
  try {
    const { fullName, email, password, roleId, departmentId, reportsToUserId } = req.body;
    if (!fullName || !email || !password || !roleId) {
      return res.status(400).json({ error: 'fullName, email, password and roleId are required' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, department_id, reports_to_user_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING user_id, full_name, email, role_id, department_id`,
      [fullName, email.toLowerCase().trim(), hash, roleId, departmentId || null, reportsToUserId || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with that email already exists' });
    next(err);
  }
});

// PATCH /api/users/:id — used by the frontend's Edit user / pause-user flows.
router.patch('/:id', requirePermission('user_role_mgmt', 'update'), async (req, res, next) => {
  try {
    const { full_name, email, role_id, department_id, is_active } = req.body;
    const { rows } = await pool.query(
      `UPDATE users SET
         full_name     = COALESCE($1, full_name),
         email         = COALESCE($2, email),
         role_id       = COALESCE($3, role_id),
         department_id = COALESCE($4, department_id),
         is_active     = COALESCE($5, is_active)
       WHERE user_id = $6
       RETURNING user_id, full_name, email, role_id, department_id, is_active`,
      [full_name || null, email ? email.toLowerCase().trim() : null, role_id || null,
       department_id || null, (is_active === undefined ? null : is_active), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
