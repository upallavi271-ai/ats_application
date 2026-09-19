const pool = require('./db');

// Writes a notification row for every user who should hear about a change.
// Recipients = everyone whose RBAC scope can already see the actor's records
// (their managers up the reports_to chain, plus admins) — reusing the same
// visibility function the data layer uses, rather than inventing a second
// notion of "who cares about this".
async function notifyAboutCandidate(actorUserId, message, linkRef) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, message, link_ref)
       SELECT u.user_id, $2, $3
       FROM users u
       WHERE u.is_active
         AND u.user_id <> $1
         AND $1 IN (SELECT visible_user_id FROM get_visible_user_ids(u.user_id))`,
      [actorUserId, message, linkRef || null]
    );
  } catch (err) {
    // A notification failing must never fail the business action that
    // triggered it — log and move on.
    console.error('notify failed:', err.message);
  }
}

module.exports = { notifyAboutCandidate };
