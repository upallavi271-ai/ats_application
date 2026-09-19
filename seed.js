// Run once after migrations: node seed.js
// Creates a working Super Admin login plus a tiny real dataset so the API
// can be smoke-tested end-to-end (not just "the tables exist").
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./src/db');

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const superAdminRole = await client.query(`SELECT role_id FROM roles WHERE role_name = 'Super Admin'`);
    const itDept = await client.query(`SELECT department_id FROM departments WHERE department_name = 'BDE'`);
    const passwordHash = await bcrypt.hash('Teamlink@2026', 10);

    const admin = await client.query(
      `INSERT INTO users (full_name, email, password_hash, role_id)
       VALUES ('Founder Admin', 'superadmin@teamlink.com', $1, $2)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING user_id`,
      [passwordHash, superAdminRole.rows[0].role_id]
    );
    const adminId = admin.rows[0].user_id;

    const client1 = await client.query(
      `INSERT INTO clients (name, contact, industry, city, owner_user_id) VALUES
       ('Apollo Health Group', 'hr@apollohealth.in', 'Healthcare', 'Hyderabad', $1)
       RETURNING client_id`,
      [adminId]
    );
    const clientId = client1.rows[0].client_id;

    const job1 = await client.query(
      `INSERT INTO jobs (client_id, role_title, job_description, priority, owner_user_id, department_id, openings)
       VALUES ($1, 'Staff Nurse', 'ICU experience preferred', 'High', $2, $3, 6)
       RETURNING job_id`,
      [clientId, adminId, itDept.rows[0].department_id]
    );
    const jobId = job1.rows[0].job_id;

    await client.query(
      `INSERT INTO candidates (full_name, email, department_id, created_by, owner_user_id, applied_job_id, stage, score)
       VALUES ('Anitha Rao', 'anitha@example.com', $1, $2, $2, $3, 'Applied', 77)
       ON CONFLICT DO NOTHING`,
      [itDept.rows[0].department_id, adminId, jobId]
    );

    await client.query('COMMIT');
    console.log('Seed complete. Login: superadmin@teamlink.com / Teamlink@2026');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => { console.error(err); process.exit(1); });
