const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { auth } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const candidateRoutes = require('./routes/candidates');
const jobRoutes = require('./routes/jobs');
const clientRoutes = require('./routes/clients');
const userRoutes = require('./routes/users');
const dashboardRoutes = require('./routes/dashboard');
const notificationRoutes = require('./routes/notifications');
const roleRoutes = require('./routes/roles');
const invoiceRoutes = require('./routes/invoices');
const portalRoutes = require('./routes/portal');
const reportRoutes = require('./routes/reports');
const followupRoutes = require('./routes/followups');
const files = require('./routes/files');
const orgRoutes = require('./routes/org');
const pool = require('./db');

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '8mb' })); // base64-encoded 5MB files inflate ~33%

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/api/health', (req, res) => res.json({ ok: true })); // this is the one probeBackend() in the frontend actually calls

app.use('/api/auth', authRoutes);
// Everything below here requires a valid token.
app.use('/api/candidates', auth, candidateRoutes);
// The frontend calls candidate-list/create as /api/candidates but every
// stage-transition/allowed/history/interview call as /api/applications/:id/...
// — both point at the same candidates table row, so the same router serves
// both prefixes rather than duplicating the logic.
app.use('/api/applications', auth, candidateRoutes);
app.use('/api/jobs', auth, jobRoutes);
app.use('/api/clients', auth, clientRoutes);
app.use('/api/users', auth, userRoutes);
app.use('/api/dashboard', auth, dashboardRoutes);
app.use('/api/notifications', auth, notificationRoutes);
app.use('/api/roles', auth, roleRoutes);
app.use('/api/invoices', auth, invoiceRoutes);
app.use('/api/portal', auth, portalRoutes);
app.use('/api/reports', auth, reportRoutes);
app.use('/api/followups', auth, followupRoutes);
app.use('/api/org', auth, orgRoutes);

// Resume/document storage. Mounted here (rather than inside candidates.js)
// because the frontend uses /api/candidates/:id/files for upload+list and a
// bare /api/files/:id for download.
app.post('/api/candidates/:id/files', auth, files.upload);
app.get('/api/candidates/:id/files', auth, files.list);
app.get('/api/files/:fileId', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT original_name, mime_type, bytes FROM candidate_files WHERE file_id = $1',
      [req.params.fileId]
    );
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', rows[0].mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${rows[0].original_name.replace(/"/g, '')}"`);
    res.send(rows[0].bytes);
  } catch (err) { next(err); }
});

// Serve the ATS frontend from this same service, at this same origin, so
// the frontend's API_BASE = location.origin default just works — one Render
// URL for both the app and its API, no separate frontend host needed.
// Drop the file at backend/public/index.html (see DEPLOY_FULLSTACK.md).
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  res.sendFile(path.join(publicDir, 'index.html'), (err) => { if (err) next(); });
});

// Centralized error handler — keeps stack traces out of API responses.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
