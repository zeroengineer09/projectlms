const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { all, get, run } = require('../database');
const { requireAdmin } = require('./auth');

const router = express.Router();
router.use(requireAdmin);

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function temporaryPassword() {
  return `Aa1!${crypto.randomBytes(18).toString('hex')}`;
}

router.get('/', async (req, res) => {
  try {
    const search = String(req.query.q || '').trim().slice(0, 100);
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const students = await all(
      `SELECT id,full_name,email,student_number,roll_number,academic_year,division,
        practical_batch,active,must_change_password,created_at,password_changed_at
       FROM student_accounts
       WHERE ?='' OR full_name LIKE ? ESCAPE '\\'
         OR roll_number LIKE ? ESCAPE '\\' OR student_number LIKE ? ESCAPE '\\'
         OR email LIKE ? ESCAPE '\\'
       ORDER BY full_name COLLATE NOCASE LIMIT 500`,
      [search, pattern, pattern, pattern, pattern]
    );
    res.json(students);
  } catch (error) {
    console.error('Student account directory failed:', error);
    res.status(500).json({ error: 'Unable to load student accounts.' });
  }
});

router.get('/attendance', async (req, res) => {
  try {
    const records = await all(
      `SELECT a.id,a.student_id,s.full_name,s.email,s.roll_number,s.division,
        s.practical_batch,a.attendance_date,a.status,a.note,a.updated_at
       FROM student_attendance a JOIN student_accounts s ON s.id=a.student_id
       ORDER BY a.attendance_date DESC,s.full_name COLLATE NOCASE LIMIT 500`
    );
    res.json(records);
  } catch (error) {
    console.error('Student attendance directory failed:', error);
    res.status(500).json({ error: 'Unable to load attendance records.' });
  }
});

router.post('/attendance', async (req, res) => {
  try {
    const studentId = Number(req.body.studentId);
    const date = String(req.body.date || '');
    const status = String(req.body.status || '').toLowerCase();
    const note = String(req.body.note || '').trim();
    if (!Number.isInteger(studentId) || studentId < 1 || !validDate(date)
      || !['present', 'absent', 'late'].includes(status) || note.length > 300) {
      return res.status(400).json({ error: 'Enter a student, valid date, attendance status and a note of at most 300 characters.' });
    }
    const student = await get('SELECT id FROM student_accounts WHERE id=?', [studentId]);
    if (!student) return res.status(404).json({ error: 'Student account not found.' });
    await run(
      `INSERT INTO student_attendance(student_id,attendance_date,status,note,recorded_by_admin_id)
       VALUES(?,?,?,?,?)
       ON CONFLICT(student_id,attendance_date) DO UPDATE SET status=excluded.status,
         note=excluded.note,recorded_by_admin_id=excluded.recorded_by_admin_id,
         updated_at=datetime('now')`,
      [studentId, date, status, note, req.session.adminId]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Student attendance update failed:', error);
    res.status(500).json({ error: 'Unable to save attendance.' });
  }
});

router.get('/notices', async (req, res) => {
  try {
    res.json(await all(
      `SELECT id,title,body,published,created_at,updated_at
       FROM student_notices ORDER BY created_at DESC LIMIT 200`
    ));
  } catch (error) {
    console.error('Student notices failed:', error);
    res.status(500).json({ error: 'Unable to load student notices.' });
  }
});

router.post('/notices', async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    const body = String(req.body.body || '').trim();
    if (!title || title.length > 120 || !body || body.length > 2000) {
      return res.status(400).json({ error: 'Notice title is required (up to 120 characters) and notice text must be 1–2000 characters.' });
    }
    const published = req.body.published === undefined ? 1 : Number(req.body.published);
    if (![0, 1].includes(published)) return res.status(400).json({ error: 'Invalid notice publication status.' });
    const result = await run(
      'INSERT INTO student_notices(title,body,published,created_by_admin_id) VALUES(?,?,?,?)',
      [title, body, published, req.session.adminId]
    );
    res.status(201).json(await get(
      'SELECT id,title,body,published,created_at,updated_at FROM student_notices WHERE id=?',
      [result.lastID]
    ));
  } catch (error) {
    console.error('Student notice creation failed:', error);
    res.status(500).json({ error: 'Unable to create student notice.' });
  }
});

router.patch('/notices/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const published = Number(req.body.published);
    if (!Number.isInteger(id) || id < 1 || ![0, 1].includes(published)) {
      return res.status(400).json({ error: 'Invalid notice or publication status.' });
    }
    const result = await run(
      "UPDATE student_notices SET published=?,updated_at=datetime('now') WHERE id=?",
      [published, id]
    );
    if (!result.changes) return res.status(404).json({ error: 'Student notice not found.' });
    res.json({ ok: true, published });
  } catch (error) {
    console.error('Student notice update failed:', error);
    res.status(500).json({ error: 'Unable to update student notice.' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid student ID.' });
    const current = await get('SELECT * FROM student_accounts WHERE id=?', [id]);
    if (!current) return res.status(404).json({ error: 'Student account not found.' });

    const fullName = req.body.fullName === undefined ? current.full_name : String(req.body.fullName).trim();
    const email = req.body.email === undefined ? current.email : String(req.body.email).trim();
    const rollNumber = req.body.rollNumber === undefined
      ? current.roll_number
      : String(req.body.rollNumber).trim();
    const division = req.body.division === undefined
      ? current.division
      : String(req.body.division).trim().toUpperCase();
    const practicalBatch = req.body.practicalBatch === undefined
      ? current.practical_batch
      : String(req.body.practicalBatch).trim();
    const academicYear = req.body.academicYear === undefined
      ? current.academic_year
      : String(req.body.academicYear).trim().toUpperCase();
    const active = req.body.active === undefined ? Number(current.active) : Number(req.body.active);

    if (!fullName || fullName.length > 120 || !isEmail(email) || email.length > 254
      || rollNumber.length > 40 || division.length > 20 || practicalBatch.length > 40
      || !['', 'FY', 'SY', 'TY'].includes(academicYear) || ![0, 1].includes(active)) {
      return res.status(400).json({ error: 'Check the student name, email, roll number, division, batch, year and account status.' });
    }

    if (rollNumber) {
      const conflict = await get(
        `SELECT id FROM student_accounts
         WHERE id<>? AND (lower(student_number)=lower(?) OR lower(roll_number)=lower(?)) LIMIT 1`,
        [id, rollNumber, rollNumber]
      );
      if (conflict) return res.status(409).json({ error: 'That roll number is already assigned to another student.' });
    }

    await run(
      `UPDATE student_accounts SET full_name=?,email=?,student_number=?,roll_number=?,
       division=?,practical_batch=?,academic_year=?,active=? WHERE id=?`,
      [fullName, email, rollNumber || current.student_number, rollNumber, division, practicalBatch, academicYear, active, id]
    );
    const student = await get(
      `SELECT id,full_name,email,student_number,roll_number,academic_year,division,
        practical_batch,active,must_change_password,created_at,password_changed_at
       FROM student_accounts WHERE id=?`,
      [id]
    );
    res.json(student);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ error: 'Email or roll number is already assigned to another student.' });
    console.error('Student account update failed:', error);
    res.status(500).json({ error: 'Unable to update student account.' });
  }
});

router.post('/:id/reset-password', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid student ID.' });
    const student = await get('SELECT id FROM student_accounts WHERE id=?', [id]);
    if (!student) return res.status(404).json({ error: 'Student account not found.' });

    const password = temporaryPassword();
    await run(
      `UPDATE student_accounts SET password_hash=?,must_change_password=1,
       password_changed_at=NULL WHERE id=?`,
      [await bcrypt.hash(password, 12), id]
    );
    res.json({ ok: true, temporaryPassword: password, mustChangePassword: true });
  } catch (error) {
    console.error('Student password reset failed:', error);
    res.status(500).json({ error: 'Unable to reset student password.' });
  }
});

module.exports = router;
