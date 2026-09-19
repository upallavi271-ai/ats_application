const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /api/roles -> { roles: [...], departments: [...] }
// Shape matches __admin.roles usage in the frontend's user form.
router.get('/', async (req, res, next) => {
  try {
    const { rows: roles } = await pool.query(
      'SELECT role_id, role_name, data_scope, hierarchy_level FROM roles ORDER BY hierarchy_level, role_name'
    );
    const { rows: departments } = await pool.query(
      'SELECT department_id, department_name FROM departments WHERE is_active ORDER BY department_name'
    );
    res.json({ roles, departments });
  } catch (err) { next(err); }
});

module.exports = router;
