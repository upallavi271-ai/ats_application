const pool = require('../db');

// Layer 1 (per rbac/README.md): module/action permission, driven entirely by
// the `permissions` table rows — never hardcoded per role. A missing row
// means no access (deny by default). Super Admin / Admin still go through
// this the same as everyone else; their access comes from their seeded rows,
// not a bypass here.
function requirePermission(moduleKey, action) {
  const column = { create: 'can_create', read: 'can_read', update: 'can_update', delete: 'can_delete' }[action];
  if (!column) throw new Error(`Unknown permission action: ${action}`);

  return async function (req, res, next) {
    try {
      const { rows } = await pool.query(
        `SELECT p.${column} AS allowed
         FROM permissions p
         JOIN users u ON u.role_id = p.role_id
         JOIN modules m ON m.module_id = p.module_id
         WHERE u.user_id = $1 AND m.module_key = $2`,
        [req.user.userId, moduleKey]
      );
      if (!rows.length || !rows[0].allowed) {
        return res.status(403).json({ error: `Not permitted: ${action} on ${moduleKey}` });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requirePermission };
