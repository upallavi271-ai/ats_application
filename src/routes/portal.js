const express = require('express');
const pool = require('../db');

const router = express.Router();

const JOURNEY = ['Applied', 'Resume Screening', 'Shortlisted', 'Shared with Client',
                 'Interview Scheduled', 'Interview Completed', 'Selected', 'Offer Sent', 'Joined'];
const CLOSED = ['Joined', 'Rejected'];

const NEXT_ACTION = {
  'Applied': 'Your application is queued for screening. No action needed from you.',
  'Resume Screening': 'A recruiter is reviewing your profile against the role.',
  'Shortlisted': 'You have been shortlisted. Your profile is being prepared for the employer.',
  'Recruiter Reviewed': 'Your profile has been verified and is moving forward.',
  'With BDE': 'Your profile is being prepared for submission to the employer.',
  'Shared with Client': 'Your profile is with the employer. We are awaiting their response.',
  'Interview Scheduled': 'Please attend your interview at the scheduled time. Details are below.',
  'Interview Completed': 'Your interview is done. We are collecting feedback from the employer.',
  'Selected': 'Congratulations — you have been selected. An offer is being prepared.',
  'Offer Sent': 'An offer has been sent to you. Please review and respond.',
  'Accepted': 'Your offer is accepted. We will confirm your joining details shortly.',
  'Joined': 'You have joined. Welcome aboard!',
  'Hold': 'Your application is temporarily on hold.',
  'Rejected': 'This application did not progress. Your profile stays with us for other roles.',
};

// --- CANDIDATE PORTAL -------------------------------------------------------
// Scoped to the logged-in candidate's OWN email only. Note it deliberately
// does NOT use get_visible_user_ids(): a candidate is not a staff user in
// the reports_to hierarchy, so their scope is "rows whose email is mine",
// nothing wider.
async function candidateEmail(userId) {
  const { rows } = await pool.query(
    'SELECT COALESCE(candidate_email, email) AS email FROM users WHERE user_id = $1', [userId]
  );
  return rows.length ? rows[0].email : null;
}

router.get('/candidate/applications', async (req, res, next) => {
  try {
    const email = await candidateEmail(req.user.userId);
    if (!email) return res.json([]);
    const { rows } = await pool.query(
      `SELECT c.candidate_id AS application_id, c.candidate_id AS application_ref,
              COALESCE(j.role_title, c.job_title_text) AS role,
              cl.name AS employer, d.department_name AS department,
              c.stage AS status, c.applied_date AS applied_on
       FROM candidates c
       LEFT JOIN jobs j ON j.job_id = c.applied_job_id
       LEFT JOIN clients cl ON cl.client_id = j.client_id
       LEFT JOIN departments d ON d.department_id = c.department_id
       WHERE lower(c.email) = lower($1)
       ORDER BY c.applied_date DESC`,
      [email]
    );
    res.json(rows.map((r) => ({
      ...r,
      journey: JOURNEY,
      step: JOURNEY.indexOf(r.status) + 1,
      is_closed: CLOSED.includes(r.status),
    })));
  } catch (err) { next(err); }
});

router.get('/candidate/applications/:id', async (req, res, next) => {
  try {
    const email = await candidateEmail(req.user.userId);
    const { rows } = await pool.query(
      `SELECT c.candidate_id AS application_ref, COALESCE(j.role_title, c.job_title_text) AS role,
              cl.name AS employer, j.location, c.stage AS status, c.applied_date AS applied_on,
              c.interview, c.history
       FROM candidates c
       LEFT JOIN jobs j ON j.job_id = c.applied_job_id
       LEFT JOIN clients cl ON cl.client_id = j.client_id
       WHERE c.candidate_id = $1 AND lower(c.email) = lower($2)`,
      [req.params.id, email]
    );
    if (!rows.length) return res.status(404).json({ error: 'Application not found' });
    const r = rows[0];
    const stepIdx = JOURNEY.indexOf(r.status);
    res.json({
      ...r,
      journey: JOURNEY,
      completed: JOURNEY.slice(0, Math.max(0, stepIdx)).map((label) => ({ label })),
      next_action: NEXT_ACTION[r.status] || '',
      // Deliberately NOT returning internal feedback notes, match scores or
      // recruiter commentary — a candidate sees their own progress, not the
      // internal assessment of them.
      interviews: r.interview && r.interview.date ? [{
        name: r.interview.round || 'Interview', date: r.interview.date,
        time: r.interview.time, mode: r.interview.mode,
        status: r.status === 'Interview Completed' ? 'Completed' : 'Scheduled',
        link: r.interview.link || '',
      }] : [],
    });
  } catch (err) { next(err); }
});

// --- CLIENT PORTAL ----------------------------------------------------------
// Scoped strictly to the one client the login is attached to.
async function clientIdFor(userId) {
  const { rows } = await pool.query('SELECT client_id FROM users WHERE user_id = $1', [userId]);
  return rows.length ? rows[0].client_id : null;
}

router.get('/client/requirements', async (req, res, next) => {
  try {
    const clientId = await clientIdFor(req.user.userId);
    if (!clientId) return res.status(403).json({ error: 'This login is not linked to a client account.' });
    const { rows } = await pool.query(
      `SELECT j.job_id, j.role_title AS role, j.status, j.openings, j.location, j.deadline,
              (SELECT count(*) FROM candidates c WHERE c.applied_job_id = j.job_id
                 AND c.stage IN ('Shared with Client','Interview Scheduled','Interview Completed','Selected','Offer Sent','Accepted','Joined')) AS shared_candidates
       FROM jobs j WHERE j.client_id = $1 ORDER BY j.created_at DESC`,
      [clientId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/client/requirements/:jobId/candidates', async (req, res, next) => {
  try {
    const clientId = await clientIdFor(req.user.userId);
    if (!clientId) return res.status(403).json({ error: 'This login is not linked to a client account.' });

    // Only candidates actually SHARED with this client, and only on this
    // client's own requirement — never the full pipeline.
    const { rows } = await pool.query(
      `SELECT c.candidate_id, c.full_name, c.stage, c.score, c.interview, c.client_decision,
              c.location, c.notice_period, c.expected_salary
       FROM candidates c JOIN jobs j ON j.job_id = c.applied_job_id
       WHERE j.job_id = $1 AND j.client_id = $2
         AND c.stage IN ('Shared with Client','Interview Scheduled','Interview Completed','Selected','Offer Sent','Accepted','Joined','Rejected')
       ORDER BY c.score DESC NULLS LAST`,
      [req.params.jobId, clientId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
