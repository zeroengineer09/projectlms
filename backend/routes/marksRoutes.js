const express = require('express');
const { all, get, run } = require('../database');

const router = express.Router();

function teacherOnly(req, res, next) {
  if (!req.session.teacherId) return res.status(401).json({ error: 'Teacher login required.' });
  if (req.session.mustChangePassword) {
    return res.status(403).json({ error: 'Change your initial password before continuing.' });
  }
  next();
}

function studentOnly(req, res, next) {
  if (!req.session.studentId) return res.status(401).json({ error: 'Student login required.' });
  next();
}

function adminOnly(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: 'Administrator login required.' });
  if (req.session.mustChangePassword) {
    return res.status(403).json({ error: 'Change your initial administrator password before continuing.' });
  }
  next();
}

function readMarkInput(body) {
  const category = String(body.category || '');
  const title = String(body.title || '').trim();
  const subject = String(body.subject_name || '').trim();
  const academicYear = String(body.academic_year || '').toUpperCase();
  const semester = String(body.semester || '').trim();
  const examDate = String(body.exam_date || '').trim();
  const studentId = Number(body.student_id);
  const marks = Number(body.marks_obtained);
  const maxMarks = Number(body.max_marks);
  const published = body.published === true || body.published === 1 || body.published === '1' ? 1 : 0;

  if (!['credit', 'semester'].includes(category) || !title || title.length > 120
    || !subject || subject.length > 120 || !['FY', 'SY', 'TY'].includes(academicYear)
    || !Number.isInteger(studentId) || studentId < 1
    || !Number.isFinite(marks) || !Number.isFinite(maxMarks)
    || maxMarks <= 0 || marks < 0 || marks > maxMarks
    || (category === 'semester' && (!semester || semester.length > 60))
    || (examDate && (!/^\d{4}-\d{2}-\d{2}$/.test(examDate)
      || Number.isNaN(Date.parse(`${examDate}T00:00:00`)))) ) {
    return { error: 'Enter valid exam, student, subject, and marks details.' };
  }
  return {
    value: {
      category,
      title,
      subject,
      academicYear,
      semester: category === 'semester' ? semester : '',
      examDate,
      studentId,
      marks,
      maxMarks,
      published
    }
  };
}

async function validateMarkAccess(input, teacherId) {
  const student = await get(
    'SELECT id,academic_year,division FROM student_accounts WHERE id=? AND active=1',
    [input.studentId]
  );
  if (!student || String(student.academic_year).toUpperCase() !== input.academicYear) {
    return { error: 'Student does not belong to the selected academic year.' };
  }
  if (teacherId) {
    const assigned = await get(
      `SELECT id FROM teacher_subjects
       WHERE teacher_id=? AND lower(subject_name)=lower(?) AND upper(academic_year)=?`,
      [teacherId, input.subject, input.academicYear]
    );
    if (!assigned) return { error: 'You can only manage marks for your assigned subject and year.', status: 403 };
  }
  return { student };
}

async function auditMark(markId, action, actorType, actorId, before, after) {
  await run(
    `INSERT INTO academic_marks_audit(
      mark_id,action,actor_type,actor_id,before_json,after_json
    ) VALUES(?,?,?,?,?,?)`,
    [
      markId,
      action,
      actorType,
      actorId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null
    ]
  );
}

async function getMark(id) {
  return get(
    `SELECT m.*,s.full_name AS student_name,s.email AS student_email,s.roll_number,
            t.full_name AS teacher_name
     FROM academic_marks m
     JOIN student_accounts s ON s.id=m.student_id
     JOIN teachers t ON t.id=m.teacher_id
     WHERE m.id=?`,
    [id]
  );
}

async function updateMark(req, res, actorType, actorId, teacherId) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid marks record ID.' });
  const before = await get('SELECT * FROM academic_marks WHERE id=? AND deleted_at IS NULL', [id]);
  if (!before) return res.status(404).json({ error: 'Marks record not found.' });
  if (teacherId && Number(before.teacher_id) !== Number(teacherId)) {
    return res.status(404).json({ error: 'Marks record not found.' });
  }

  const parsed = readMarkInput(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const input = parsed.value;
  const access = await validateMarkAccess(input, teacherId);
  if (access.error) return res.status(access.status || 403).json({ error: access.error });

  const conflict = await get(
    `SELECT id FROM academic_marks
     WHERE category=? AND title=? AND subject_name=? AND semester=? AND student_id=?
       AND id<>?`,
    [input.category, input.title, input.subject, input.semester, input.studentId, id]
  );
  if (conflict) return res.status(409).json({ error: 'A marks record already exists for these details.' });

  try {
    await run(
      `UPDATE academic_marks SET category=?,title=?,subject_name=?,academic_year=?,division=?,
       semester=?,exam_date=?,student_id=?,marks_obtained=?,max_marks=?,published=?,
       published_at=CASE WHEN ?=1 THEN COALESCE(published_at,datetime('now')) ELSE NULL END,
       updated_at=datetime('now') WHERE id=?`,
      [
        input.category, input.title, input.subject, input.academicYear, access.student.division,
        input.semester, input.examDate, input.studentId, input.marks, input.maxMarks,
        input.published, input.published, id
      ]
    );
    const after = await get('SELECT * FROM academic_marks WHERE id=?', [id]);
    await auditMark(id, 'edited', actorType, actorId, before, after);
    res.json({ ok: true, message: 'Marks updated successfully.', record: after });
  } catch (error) {
    console.error('Update academic marks failed:', error);
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: 'A marks record already exists for these details.' });
    }
    res.status(500).json({ error: 'Unable to update marks.' });
  }
}

async function deleteMark(req, res, actorType, actorId, teacherId) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid marks record ID.' });
  const before = await get('SELECT * FROM academic_marks WHERE id=? AND deleted_at IS NULL', [id]);
  if (!before || (teacherId && Number(before.teacher_id) !== Number(teacherId))) {
    return res.status(404).json({ error: 'Marks record not found.' });
  }
  try {
    const deletedAt = new Date().toISOString();
    await run(
      `UPDATE academic_marks SET deleted_at=?,deleted_by_type=?,deleted_by_id=?,
       published=0,updated_at=? WHERE id=? AND deleted_at IS NULL`,
      [deletedAt, actorType, actorId, deletedAt, id]
    );
    const after = await get('SELECT * FROM academic_marks WHERE id=?', [id]);
    await auditMark(id, 'deleted', actorType, actorId, before, after);
    res.json({ ok: true, message: 'Marks deleted successfully.' });
  } catch (error) {
    console.error('Delete academic marks failed:', error);
    res.status(500).json({ error: 'Unable to delete marks.' });
  }
}

router.get('/teacher/subjects', teacherOnly, async (req, res) => {
  try {
    res.json(await all(
      'SELECT id,subject_name,academic_year FROM teacher_subjects WHERE teacher_id=? ORDER BY academic_year,subject_name',
      [req.session.teacherId]
    ));
  } catch (error) {
    console.error('Teacher marks subjects failed:', error);
    res.status(500).json({ error: 'Unable to load assigned subjects.' });
  }
});

router.get('/teacher/roster', teacherOnly, async (req, res) => {
  try {
    const subject = String(req.query.subject || '').trim();
    const year = String(req.query.year || '').toUpperCase();
    if (!subject || !['FY', 'SY', 'TY'].includes(year)) {
      return res.status(400).json({ error: 'Choose an assigned subject and academic year.' });
    }
    const assigned = await get(
      'SELECT id FROM teacher_subjects WHERE teacher_id=? AND lower(subject_name)=lower(?) AND academic_year=?',
      [req.session.teacherId, subject, year]
    );
    if (!assigned) return res.status(403).json({ error: 'This subject is not assigned to you.' });
    res.json(await all(
      `SELECT id,full_name,email,roll_number,division,practical_batch FROM student_accounts
       WHERE active=1 AND academic_year=? ORDER BY division,CAST(roll_number AS INTEGER),full_name`,
      [year]
    ));
  } catch (error) {
    console.error('Teacher marks roster failed:', error);
    res.status(500).json({ error: 'Unable to load students.' });
  }
});

router.get('/teacher', teacherOnly, async (req, res) => {
  try {
    res.json(await all(
      `SELECT m.*,s.full_name AS student_name,s.email AS student_email,s.roll_number
       FROM academic_marks m JOIN student_accounts s ON s.id=m.student_id
       WHERE m.teacher_id=? AND m.deleted_at IS NULL ORDER BY m.created_at DESC,m.id DESC`,
      [req.session.teacherId]
    ));
  } catch (error) {
    console.error('Teacher marks list failed:', error);
    res.status(500).json({ error: 'Unable to load marks.' });
  }
});

router.post('/teacher', teacherOnly, async (req, res) => {
  try {
    const parsed = readMarkInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const input = parsed.value;
    const access = await validateMarkAccess(input, req.session.teacherId);
    if (access.error) return res.status(access.status || 403).json({ error: access.error });

    const existing = await get(
      `SELECT * FROM academic_marks
       WHERE category=? AND title=? AND subject_name=? AND semester=? AND student_id=?`,
      [input.category, input.title, input.subject, input.semester, input.studentId]
    );
    if (existing?.deleted_at) {
      return res.status(409).json({ error: 'A deleted marks record already uses these details.' });
    }
    if (existing && Number(existing.teacher_id) !== Number(req.session.teacherId)) {
      return res.status(403).json({ error: 'You are not authorized to change this marks record.' });
    }
    if (existing) {
      const before = existing;
      await run(
        `UPDATE academic_marks SET division=?,exam_date=?,marks_obtained=?,max_marks=?,published=?,
         published_at=CASE WHEN ?=1 THEN COALESCE(published_at,datetime('now')) ELSE NULL END,
         updated_at=datetime('now') WHERE id=?`,
        [access.student.division, input.examDate, input.marks, input.maxMarks, input.published, input.published, existing.id]
      );
      await auditMark(existing.id, 'edited', 'teacher', req.session.teacherId, before,
        await get('SELECT * FROM academic_marks WHERE id=?', [existing.id]));
      return res.status(200).json({
        ok: true,
        message: input.published ? 'Marks saved and published.' : 'Marks saved as draft.'
      });
    }

    const inserted = await run(
      `INSERT INTO academic_marks(
        category,title,subject_name,academic_year,division,semester,exam_date,
        student_id,teacher_id,marks_obtained,max_marks,published,published_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ?=1 THEN datetime('now') ELSE NULL END)`,
      [
        input.category, input.title, input.subject, input.academicYear, access.student.division,
        input.semester, input.examDate, input.studentId, req.session.teacherId,
        input.marks, input.maxMarks, input.published, input.published
      ]
    );
    await auditMark(inserted.lastID, 'created', 'teacher', req.session.teacherId, null,
      await get('SELECT * FROM academic_marks WHERE id=?', [inserted.lastID]));
    res.status(201).json({
      ok: true,
      message: input.published ? 'Marks saved and published.' : 'Marks saved as draft.'
    });
  } catch (error) {
    console.error('Save academic marks failed:', error);
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: 'A marks record already exists for these details.' });
    }
    res.status(500).json({ error: 'Unable to save marks.' });
  }
});

router.patch('/teacher/:id', teacherOnly, (req, res) =>
  updateMark(req, res, 'teacher', req.session.teacherId, req.session.teacherId)
    .catch(error => {
      console.error('Teacher marks update failed:', error);
      res.status(500).json({ error: 'Unable to update marks.' });
    }));

router.delete('/teacher/:id', teacherOnly, (req, res) =>
  deleteMark(req, res, 'teacher', req.session.teacherId, req.session.teacherId)
    .catch(error => {
      console.error('Teacher marks deletion failed:', error);
      res.status(500).json({ error: 'Unable to delete marks.' });
    }));

router.patch('/teacher/:id/publish', teacherOnly, async (req, res) => {
  try {
    const mark = await get(
      'SELECT id FROM academic_marks WHERE id=? AND teacher_id=? AND deleted_at IS NULL',
      [Number(req.params.id), req.session.teacherId]
    );
    if (!mark) return res.status(404).json({ error: 'Marks record not found.' });
    await run("UPDATE academic_marks SET published=1,published_at=COALESCE(published_at,datetime('now')),updated_at=datetime('now') WHERE id=?", [mark.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Publish academic marks failed:', error);
    res.status(500).json({ error: 'Unable to publish marks.' });
  }
});

router.get('/admin', adminOnly, async (req, res) => {
  try {
    res.json(await all(
      `SELECT m.*,s.full_name AS student_name,s.email AS student_email,s.roll_number,
              t.full_name AS teacher_name
       FROM academic_marks m JOIN student_accounts s ON s.id=m.student_id
       JOIN teachers t ON t.id=m.teacher_id ORDER BY m.created_at DESC,m.id DESC`
    ));
  } catch (error) {
    console.error('Administrator marks list failed:', error);
    res.status(500).json({ error: 'Unable to load academic marks.' });
  }
});

router.get('/admin/students', adminOnly, async (req, res) => {
  try {
    res.json(await all(
      'SELECT id,full_name,roll_number,academic_year,division FROM student_accounts WHERE active=1 ORDER BY full_name COLLATE NOCASE'
    ));
  } catch (error) {
    console.error('Administrator marks student list failed:', error);
    res.status(500).json({ error: 'Unable to load students.' });
  }
});

router.get('/admin/:id/audit', adminOnly, async (req, res) => {
  try {
    res.json(await all(
      'SELECT * FROM academic_marks_audit WHERE mark_id=? ORDER BY created_at DESC,id DESC',
      [Number(req.params.id)]
    ));
  } catch (error) {
    console.error('Academic marks audit retrieval failed:', error);
    res.status(500).json({ error: 'Unable to load the marks audit history.' });
  }
});

router.patch('/admin/:id', adminOnly, (req, res) =>
  updateMark(req, res, 'admin', req.session.adminId, null)
    .catch(error => {
      console.error('Administrator marks update failed:', error);
      res.status(500).json({ error: 'Unable to update marks.' });
    }));

router.delete('/admin/:id', adminOnly, (req, res) =>
  deleteMark(req, res, 'admin', req.session.adminId, null)
    .catch(error => {
      console.error('Administrator marks deletion failed:', error);
      res.status(500).json({ error: 'Unable to delete marks.' });
    }));

router.get('/student/:category', studentOnly, async (req, res) => {
  try {
    if (!['credit', 'semester'].includes(req.params.category)) {
      return res.status(400).json({ error: 'Invalid marks category.' });
    }
    res.json(await all(
      `SELECT category,title,subject_name,academic_year,semester,exam_date,
              COALESCE(published_at,created_at) AS publication_date,
              marks_obtained,max_marks,ROUND(marks_obtained*100.0/max_marks,1) percentage,created_at
       FROM academic_marks WHERE student_id=? AND category=? AND published=1 AND deleted_at IS NULL
       ORDER BY exam_date DESC,subject_name`,
      [req.session.studentId, req.params.category]
    ));
  } catch (error) {
    console.error('Student published marks failed:', error);
    res.status(500).json({ error: 'Unable to load published marks.' });
  }
});

router.get('/hod/all', teacherOnly, async (req, res) => {
  try {
    const teacher = await get(
      'SELECT email FROM teachers WHERE id=? AND active=1',
      [req.session.teacherId]
    );
    if (!teacher || String(teacher.email).toLowerCase() !== 'tushar.patel@rcpimrd.ac.in') {
      return res.status(403).json({ error: 'HOD access only.' });
    }
    res.json(await all(
      `SELECT m.category,m.title,m.subject_name,m.academic_year,m.division,m.semester,m.exam_date,
              m.marks_obtained,m.max_marks,ROUND(m.marks_obtained*100.0/m.max_marks,1) percentage,
              s.full_name student_name,s.email student_email,m.created_at
       FROM academic_marks m JOIN student_accounts s ON s.id=m.student_id
       WHERE m.published=1 AND m.deleted_at IS NULL
       UNION ALL
       SELECT 'online' category,a.title subject_name,a.title,a.candidate_class academic_year,
              a.candidate_division division,'' semester,r.completed_at exam_date,r.score marks_obtained,
              r.total_questions max_marks,r.percentage,s.full_name student_name,s.email student_email,
              r.completed_at created_at
       FROM results r JOIN examination_attempts a ON a.id=r.attempt_id
       JOIN student_accounts s ON lower(s.email)=lower(a.candidate_email)
       ORDER BY created_at DESC`
    ));
  } catch (error) {
    console.error('HOD marks overview failed:', error);
    res.status(500).json({ error: 'Unable to load all student marks.' });
  }
});

module.exports = router;
