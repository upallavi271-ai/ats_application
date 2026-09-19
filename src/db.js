const { Pool } = require('pg');
require('dotenv').config();

// Managed Postgres providers (Neon, Render, Supabase, RDS...) require SSL
// and use certs that aren't in Node's default trust store, so a plain
// `ssl: true` fails locally-signed-cert verification. Set DATABASE_SSL=true
// in .env for any hosted DB; leave it unset for a local/VPS-self-hosted one.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  // A background client (not one actively serving a request) died — log and
  // keep the process alive rather than crashing the whole API.
  console.error('Unexpected error on idle Postgres client', err);
});

module.exports = pool;
