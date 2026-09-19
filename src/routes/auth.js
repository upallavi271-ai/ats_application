const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();

// Response shape here is dictated by the frontend's existing login handler:
// r.token, r.user.role, r.user.full_name, r.user.department_id,
// r.user.client_id (client-portal users), r.user.email — see the `auth(e)`
// function in the ATS HTML. Changing these names breaks login silently, so
// they're kept exactly as the frontend reads them rather than restyled.
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const { rows } = await pool.query(
      `SELECT u.user_id, u.full_name, u.email, u.password_hash, u.department_id, u.is_active,
              r.role_name, r.data_scope
       FROM users u JOIN roles r ON r.role_id = u.role_id
       WHERE u.email = $1`,
      [email.toLowerCase().trim()]
    );
    const user = rows[0];
    if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid email or password' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign(
      { userId: user.user_id, role: user.role_name, dataScope: user.data_scope, departmentId: user.department_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
    );

    res.json({
      token,
      user: {
        user_id: user.user_id,
        full_name: user.full_name,
        email: user.email,
        role: user.role_name,
        department_id: user.department_id,
        client_id: null, // set once client-portal login accounts are linked to a clients row
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
