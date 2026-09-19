const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /api/notifications -> { unread, items: [...] }
// The frontend reads `.unread` for the header bell badge.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT notification_id, message, link_ref, is_read, created_at
       FROM notifications WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 100`,
      [req.user.userId]
    );
    res.json({ unread: rows.filter((r) => !r.is_read).length, items: rows });
  } catch (err) { next(err); }
});

router.post('/:id/read', async (req, res, next) => {
  try {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE notification_id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/read-all', async (req, res, next) => {
  try {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.user.userId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
