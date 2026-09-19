const express = require('express');
const pool = require('../db');
const { broadcast } = require('../realtime');

const router = express.Router();

// Accountant module. Reads the derived invoice_view so total/balance/status
// are always computed from the amounts, never stored and stale.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM invoice_view ORDER BY invoice_date DESC, invoice_id DESC');
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { client_id, candidate_id, base_amount, gst_amount, tds_amount, invoice_date, due_date } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id is required' });
    const { rows } = await pool.query(
      `INSERT INTO invoices (client_id, candidate_id, base_amount, gst_amount, tds_amount, invoice_date, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6, CURRENT_DATE),$7,$8) RETURNING invoice_id`,
      [client_id, candidate_id || null, base_amount || 0, gst_amount || 0, tds_amount || 0,
       invoice_date || null, due_date || null, req.user.userId]
    );
    broadcast('invoice.created', {});
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.post('/:id/payment', async (req, res, next) => {
  try {
    const { amount, method } = req.body;
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'A positive amount is required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: inv } = await client.query(
        'SELECT base_amount, gst_amount, tds_amount, amount_received FROM invoices WHERE invoice_id = $1 FOR UPDATE',
        [req.params.id]
      );
      if (!inv.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found' }); }

      // Don't let recorded payments exceed what's actually owed — an
      // over-payment here would silently corrupt every balance report.
      const payable = Number(inv[0].base_amount) + Number(inv[0].gst_amount) - Number(inv[0].tds_amount);
      const already = Number(inv[0].amount_received);
      if (already + amt > payable + 0.005) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: `Payment exceeds the balance due (₹${(payable - already).toFixed(2)} outstanding).` });
      }

      await client.query('INSERT INTO invoice_payments (invoice_id, amount, method, recorded_by) VALUES ($1,$2,$3,$4)',
        [req.params.id, amt, method || null, req.user.userId]);
      await client.query('UPDATE invoices SET amount_received = amount_received + $1 WHERE invoice_id = $2',
        [amt, req.params.id]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

    broadcast('invoice.paid', {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
