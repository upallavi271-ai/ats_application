const express = require('express');
const pool = require('../db');
const { requirePermission } = require('../middleware/permissions');
const { broadcast } = require('../realtime');

const router = express.Router();

// GET /api/clients — column names match mapBackendClient() in the frontend.
// That mapper is defensive (`b.field || ''` for almost everything), so only
// client_id / client_name / owner_name / job_count / candidate_count need to
// be real here; richer contact/agreement fields can come later without
// breaking anything in the meantime.
router.get('/', requirePermission('candidates', 'read'), async (req, res, next) => {
  try {
    const { status, owner, q } = req.query;
    const params = [];
    let sql = `
      SELECT cl.client_id, cl.name AS client_name, cl.contact AS primary_email,
             cl.industry, cl.city, cl.status, cl.agreement_status AS agreement,
             cl.gst AS gst_number, u.full_name AS owner_name,
             (SELECT count(*) FROM jobs j WHERE j.client_id = cl.client_id) AS job_count,
             (SELECT count(*) FROM jobs j WHERE j.client_id = cl.client_id AND j.status = 'Open') AS open_requirements,
             (SELECT count(*) FROM candidates c JOIN jobs j ON j.job_id = c.applied_job_id WHERE j.client_id = cl.client_id) AS candidate_count
      FROM clients cl
      LEFT JOIN users u ON u.user_id = cl.owner_user_id
      WHERE 1=1
    `;
    if (status) { params.push(status); sql += ` AND cl.status = $${params.length}`; }
    if (owner) { params.push(owner); sql += ` AND cl.owner_user_id = $${params.length}`; }
    if (q) { params.push(`%${q}%`); sql += ` AND cl.name ILIKE $${params.length}`; }
    sql += ' ORDER BY cl.created_at DESC';

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', requirePermission('candidates', 'create'), async (req, res, next) => {
  try {
    const { name, contact, industry, city, owner_user_id } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO clients (name, contact, industry, city, owner_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING client_id`,
      [name, contact || null, industry || null, city || null, owner_user_id || req.user.userId]
    );
    broadcast('client.created', {});
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// GET /api/clients/:id/picture?month=YYYY-MM — the "select client -> complete
// picture" endpoint backing the Clients & BDE workspace's client-focus panel.
router.get('/:id/picture', requirePermission('candidates', 'read'), async (req, res, next) => {
  try {
    const { month } = req.query;
    const params = [req.params.id];
    let dateFilter = '';
    if (month) { params.push(`${month}-01`); dateFilter = ` AND date_trunc('month', c.applied_date) = date_trunc('month', $2::date)`; }

    const { rows: cands } = await pool.query(
      `SELECT c.* FROM candidates c JOIN jobs j ON j.job_id = c.applied_job_id WHERE j.client_id = $1 ${dateFilter}`,
      params
    );
    const { rows: reqRows } = await pool.query('SELECT * FROM jobs WHERE client_id = $1', [req.params.id]);

    const bucket = (stage) => {
      if (stage === 'Joined') return 'Joined';
      if (['Offer Sent', 'Accepted'].includes(stage)) return 'Offer';
      if (stage === 'Selected') return 'Selected';
      if (['Interview Scheduled', 'Interview Completed'].includes(stage)) return 'Interview';
      if (['Shortlisted', 'Recruiter Reviewed', 'With BDE', 'Shared with Client'].includes(stage)) return 'Shortlisted';
      if (stage === 'Resume Screening') return 'Screening';
      return 'Applied';
    };
    const counts = { Applied: 0, Screening: 0, Shortlisted: 0, Interview: 0, Selected: 0, Offer: 0, Joined: 0 };
    const order = ['Applied', 'Screening', 'Shortlisted', 'Interview', 'Selected', 'Offer', 'Joined'];
    cands.forEach((c) => {
      if (['Rejected', 'Hold'].includes(c.stage)) return;
      const idx = order.indexOf(bucket(c.stage));
      for (let i = 0; i <= idx; i++) counts[order[i]]++;
    });

    res.json({
      openRequirements: reqRows.filter((j) => j.status === 'Open').length,
      activeRequirements: reqRows.filter((j) => j.status !== 'Closed').length,
      totalCandidates: cands.length,
      funnel: counts,
      selected: counts.Selected,
      offers: counts.Offer,
      joined: counts.Joined,
      pendingJoining: cands.filter((c) => c.stage === 'Accepted').length,
      rejected: cands.filter((c) => c.stage === 'Rejected').length,
      pendingClientDecisions: cands.filter((c) => c.stage === 'Shared with Client' && (!c.client_decision || c.client_decision === 'Pending')).length,
    });
  } catch (err) { next(err); }
});

module.exports = router;
