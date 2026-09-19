const express = require('express');
const pool = require('../db');

const router = express.Router();
const MAX_BYTES = 5 * 1024 * 1024;

// POST /api/candidates/:id/files  { original_name, mime_type, kind, data_base64 }
async function upload(req, res, next) {
  try {
    const { original_name, mime_type, kind, data_base64, data } = req.body;
    const b64 = data_base64 || data;
    if (!original_name || !b64) return res.status(400).json({ error: 'original_name and file data are required' });

    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length > MAX_BYTES) return res.status(413).json({ error: 'File is larger than 5 MB' });

    const { rows } = await pool.query(
      `INSERT INTO candidate_files (candidate_id, original_name, mime_type, kind, bytes, size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING file_id, original_name, size_bytes, uploaded_at`,
      [req.params.id, original_name, mime_type || 'application/octet-stream', kind || 'resume',
       bytes, bytes.length, req.user.userId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function list(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT file_id, original_name, mime_type, kind, size_bytes, uploaded_at
       FROM candidate_files WHERE candidate_id = $1 ORDER BY uploaded_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

module.exports = { upload, list };
