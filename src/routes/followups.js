const express = require('express');
const pool = require('../db');
const { broadcast } = require('../realtime');

const router = express.Router();

// GET /api/followups/pending/today — the escalation list, aggregated over
// the caller's scoped rows (was browser-only, so a TL never saw a
// recruiter's pending follow-ups).
router.get('/pending/today', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.follow_up_id, f.candidate_id, c.full_name, f.due_date, f.outcome, f.notes,
              u.full_name AS owner_name
       FROM follow_ups f
       JOIN candidates c ON c.candidate_id = f.candidate_id
       LEFT JOIN users u ON u.user_id = c.owner_user_id
       WHERE f.due_date IS NOT NULL AND f.due_date <= CURRENT_DATE
         AND c.created_by IN (SELECT visible_user_id FROM get_visible_user_ids($1))
       ORDER BY f.due_date`,
      [req.user.userId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:candidateId', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, u.full_name AS created_by_name
       FROM follow_ups f LEFT JOIN users u ON u.user_id = f.created_by
       WHERE f.candidate_id = $1 ORDER BY f.created_at DESC`,
      [req.params.candidateId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/:candidateId', async (req, res, next) => {
  try {
    const { contacted, outcome, notes, due_date } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO follow_ups (candidate_id, contacted, outcome, notes, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING follow_up_id`,
      [req.params.candidateId, contacted !== false, outcome || null, notes || null,
       due_date || null, req.user.userId]
    );
    broadcast('followup.logged', { application_ref: String(req.params.candidateId) });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
