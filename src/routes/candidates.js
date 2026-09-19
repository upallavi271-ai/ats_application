const express = require('express');
const pool = require('../db');
const { requirePermission } = require('../middleware/permissions');
const { broadcast } = require('../realtime');
const { notifyAboutCandidate } = require('../notify');

const router = express.Router();

// Matches stageOrder in the frontend. Forward transitions move one step at a
// time (or jump straight to Rejected/Hold from any active stage) — the same
// rule the single-file app's own stage() function enforces client-side,
// re-enforced here so the API can't be used to skip the workflow.
const STAGE_ORDER = [
  'Applied', 'Resume Screening', 'Shortlisted', 'Recruiter Reviewed', 'With BDE',
  'Shared with Client', 'Interview Scheduled', 'Interview Completed', 'Selected',
  'Offer Sent', 'Accepted', 'Joined',
];
function isLegalTransition(from, to) {
  if (to === 'Rejected' || to === 'Hold') return true;
  if (from === 'Hold') return true;
  const fromIdx = STAGE_ORDER.indexOf(from);
  const toIdx = STAGE_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return false;
  return toIdx === fromIdx + 1;
}

// Column list shared by every SELECT below, aliased to exactly what
// mapBackendCandidate() in the frontend reads.
const CANDIDATE_SELECT = `
  SELECT
    c.candidate_id, c.candidate_id AS application_ref, c.person_ref,
    c.full_name, c.email, c.phone,
    COALESCE(j.role_title, c.job_title_text) AS job_title,
    cl.name AS client_name,
    c.stage, c.score AS ai_score,
    u.full_name AS owner_name,
    d.department_name, d.department_name AS requirement_department,
    c.specialization, c.source, c.location,
    c.expected_salary, c.notice_period,
    c.applied_job_id AS job_id,
    c.client_decision, c.recruiter_verified, c.bde_verified,
    c.rejected_by, c.rejection_reason,
    c.resume_text, c.original_resume, c.edited_resume, c.resume_file_name,
    c.skills, c.created_at,
    c.interview->>'date' AS interview_date, c.interview->>'time' AS interview_time,
    c.interview->>'round' AS interview_round, c.interview->>'mode' AS interview_mode,
    c.interview->>'panel' AS interviewer, c.interview->>'link' AS meeting_link,
    c.feedback->>'rating' AS feedback_rating,
    c.feedback->>'recommendation' AS feedback_recommendation,
    c.feedback->>'notes' AS feedback_notes,
    (CASE WHEN c.stage IN ('Offer Sent','Accepted') THEN c.stage END) AS offer_status,
    (CASE WHEN c.stage = 'Joined' THEN 'Joined' WHEN c.stage = 'Accepted' THEN 'Pending' END) AS joining_status,
    (SELECT count(*) FROM candidates p2 WHERE p2.person_ref = COALESCE(c.person_ref, c.candidate_id) OR p2.candidate_id = COALESCE(c.person_ref, c.candidate_id)) AS person_application_count
  FROM candidates c
  LEFT JOIN jobs j ON j.job_id = c.applied_job_id
  LEFT JOIN clients cl ON cl.client_id = j.client_id
  LEFT JOIN users u ON u.user_id = c.owner_user_id
  LEFT JOIN departments d ON d.department_id = c.department_id
`;

// GET /api/candidates — the frontend fetches the whole (RBAC-scoped) list
// and filters client-side, so no query params are required here.
router.get('/', requirePermission('candidates', 'read'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      CANDIDATE_SELECT + ` WHERE c.created_by IN (SELECT visible_user_id FROM get_visible_user_ids($1)) ORDER BY c.created_at DESC`,
      [req.user.userId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/candidates — matches the exact payload the frontend already
// sends (full_name, email, phone, job_title, job_id, department_id, source,
// specialization, location, expected_salary, skills, resume_text,
// original_resume, resume_file_name, stage).
router.post('/', requirePermission('candidates', 'create'), async (req, res, next) => {
  try {
    const {
      full_name, email, phone, job_title, job_id, department_id, source,
      specialization, location, expected_salary, skills, resume_text,
      original_resume, resume_file_name,
    } = req.body;
    if (!full_name) return res.status(400).json({ error: 'full_name is required' });

    // Lightweight person/application dedup: if this email already applied
    // before, link the new row to that first application via person_ref so
    // the UI can show "N applications" instead of it reading as a stranger.
    let personRef = null;
    let linkedToExisting = false;
    if (email) {
      const existing = await pool.query(
        `SELECT candidate_id, COALESCE(person_ref, candidate_id) AS root FROM candidates WHERE email = $1 ORDER BY created_at LIMIT 1`,
        [email]
      );
      if (existing.rows.length) { personRef = existing.rows[0].root; linkedToExisting = true; }
    }

    const resolvedDept = department_id || (job_id
      ? (await pool.query('SELECT department_id FROM jobs WHERE job_id = $1', [job_id])).rows[0]?.department_id
      : null);
    if (!resolvedDept) return res.status(400).json({ error: 'department_id (or a job_id with a department) is required' });

    const { rows } = await pool.query(
      `INSERT INTO candidates
         (full_name, email, phone, created_by, department_id, applied_job_id, owner_user_id,
          job_title_text, source, specialization, location, expected_salary, skills,
          resume_text, original_resume, resume_file_name, person_ref, stage, history)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'Applied',$18::jsonb)
       RETURNING candidate_id, full_name`,
      [full_name, email || null, phone || null, req.user.userId, resolvedDept, job_id || null, req.user.userId,
       job_title || null, source || null, specialization || null, location || null, expected_salary || null,
       skills || null, resume_text || null, original_resume || null, resume_file_name || null, personRef,
       JSON.stringify([['Applied', 'Application received', new Date().toISOString().slice(0, 10)]])]
    );
    await notifyAboutCandidate(req.user.userId, `New candidate added: ${full_name}`, String(rows[0].candidate_id));
    broadcast('candidate.created', { application_ref: String(rows[0].candidate_id), status: 'Applied' });
    res.status(201).json({ ...rows[0], linked_to_existing_person: linkedToExisting });
  } catch (err) { next(err); }
});

// POST /api/applications/:id/transition — the single endpoint the frontend
// uses for every stage change (rejection, interview scheduling, selection,
// offer, joining...). Body: { to_status, reason?, rejected_by?, notes?,
// interview_date?, interview_time? }.
router.post('/:id/transition', requirePermission('candidates', 'update'), async (req, res, next) => {
  try {
    const { to_status, reason, rejected_by, notes, interview_date, interview_time } = req.body;
    if (!to_status) return res.status(400).json({ error: 'to_status is required' });

    const { rows: current } = await pool.query('SELECT stage, interview FROM candidates WHERE candidate_id = $1', [req.params.id]);
    if (!current.length) return res.status(404).json({ error: 'Candidate not found' });

    if (!isLegalTransition(current[0].stage, to_status)) {
      return res.status(422).json({ error: `Cannot move from "${current[0].stage}" to "${to_status}" — stages advance one step at a time (or to Hold/Rejected).` });
    }

    const historyNote = reason || notes || (interview_date ? `${interview_date} ${interview_time || ''}`.trim() : '');
    const interviewJson = interview_date
      ? JSON.stringify({ ...(current[0].interview || {}), date: interview_date, time: interview_time || '' })
      : null;

    const { rows } = await pool.query(
      `UPDATE candidates SET
         stage = $1,
         rejection_reason = COALESCE($2, rejection_reason),
         rejected_by = COALESCE($3, rejected_by),
         interview = COALESCE($4::jsonb, interview),
         history = history || $5::jsonb,
         updated_at = now()
       WHERE candidate_id = $6
       RETURNING candidate_id`,
      [to_status, reason || null, rejected_by || null, interviewJson,
       JSON.stringify([[to_status, historyNote, new Date().toISOString().slice(0, 10)]]), req.params.id]
    );
    await notifyAboutCandidate(req.user.userId, `Stage changed to ${to_status}`, String(rows[0].candidate_id));
    broadcast('candidate.transitioned', { application_ref: String(rows[0].candidate_id), status: to_status });
    res.json({ ok: true, candidate_id: rows[0].candidate_id, stage: to_status });
  } catch (err) { next(err); }
});

// GET /api/applications/:id/allowed — legal next stages from where this
// candidate is right now, so the UI never offers a move the server would
// refuse.
router.get('/:id/allowed', requirePermission('candidates', 'read'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT stage FROM candidates WHERE candidate_id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Candidate not found' });
    const from = rows[0].stage;
    const next = [...STAGE_ORDER, 'Rejected', 'Hold'].filter((s) => isLegalTransition(from, s));
    res.json({ from, allowed: next });
  } catch (err) { next(err); }
});

// GET /api/applications/:id/history
router.get('/:id/history', requirePermission('candidates', 'read'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT history FROM candidates WHERE candidate_id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Candidate not found' });
    res.json(rows[0].history || []);
  } catch (err) { next(err); }
});

// POST /api/applications/:id/interviews — dedicated interview-scheduling
// endpoint (the generic /transition also accepts interview_date/time for
// the common case; this is for scheduling without necessarily changing stage).
router.post('/:id/interviews', requirePermission('candidates', 'update'), async (req, res, next) => {
  try {
    const { date, time, round, mode, panel, link } = req.body;
    if (!date || !time) return res.status(400).json({ error: 'date and time are required' });
    const { rows } = await pool.query(
      `UPDATE candidates SET interview = $1::jsonb, history = history || $2::jsonb, updated_at = now()
       WHERE candidate_id = $3 RETURNING candidate_id`,
      [JSON.stringify({ date, time, round: round || '', mode: mode || '', panel: panel || '', link: link || '' }),
       JSON.stringify([['Interview Scheduled', `${round || 'Interview'} on ${date} ${time}`, new Date().toISOString().slice(0, 10)]]),
       req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Candidate not found' });
    await notifyAboutCandidate(req.user.userId, `Interview scheduled for ${date} ${time}`, String(req.params.id));
    broadcast('interview.scheduled', { application_ref: String(req.params.id), status: 'Interview Scheduled' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
