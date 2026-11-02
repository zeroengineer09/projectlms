const express = require('express');
const JSZip = require('jszip');
const { get, all, run } = require('./database');
const { calculateAndPersistResult, syncAssessmentRoster } = require('./assessmentResultUtils');
const { requireAdmin } = require('./auth');

const router = express.Router();

function requireStudent(req, res, next) {
  if (!req.session.studentId) return res.status(401).json({ error: 'Student login required.' });
  if (req.session.studentMustChangePassword) {
    return res.status(403).json({ error: 'Change your initial password before continuing.' });
  }
  next();
}

function requireTeacher(req, res, next) {
  if (!req.session.teacherId) return res.status(401).json({ error: 'Teacher login required.' });
  if (req.session.mustChangePassword) {
    return res.status(403).json({ error: 'Change your initial password before continuing.' });
  }
  next();
}

const resultColumns = `
  t.id AS attempt_id,t.assessment_id,t.candidate_name,t.candidate_email,t.candidate_class,
  t.candidate_division,t.started_at,t.submitted_at,t.student_id,t.teacher_id,
  a.title AS assessment_title,a.subject_name,a.passing_percentage,a.result_release_at,
  r.total_questions,r.attempted,r.correct_answers,r.incorrect_answers,r.unanswered,
  r.score,r.marks_obtained,r.total_marks,r.percentage,r.passed,r.pending_manual,
  r.evaluation_status,r.completed_at,
  EXISTS(SELECT 1 FROM assessment_submissions submission
    WHERE submission.attempt_id=t.id AND submission.reset_at IS NOT NULL) AS attempt_reset,
  COALESCE(s.full_name,t.candidate_name) AS student_name,
  COALESCE(s.roll_number,'') AS roll_number,COALESCE(th.full_name,'Unassigned') AS teacher_name
`;
const resultJoins = `
  FROM examination_attempts t
  JOIN assessments a ON a.id=t.assessment_id
  JOIN results r ON r.attempt_id=t.id
  LEFT JOIN student_accounts s ON s.id=t.student_id
  LEFT JOIN teachers th ON th.id=COALESCE(t.teacher_id,a.owner_teacher_id)
`;

function resultFilter(query, params, filters) {
  const search = String(filters.search || '').trim();
  if (search) {
    const like = `%${search}%`;
    query += ` AND (s.full_name LIKE ? OR t.candidate_name LIKE ? OR s.roll_number LIKE ?
      OR a.subject_name LIKE ? OR a.title LIKE ? OR th.full_name LIKE ?)`;
    params.push(like, like, like, like, like, like);
  }
  if (filters.assessment) {
    query += ' AND a.id=?';
    params.push(Number(filters.assessment));
  }
  if (filters.subject) {
    query += ' AND lower(a.subject_name) LIKE lower(?)';
    params.push(`%${String(filters.subject).trim()}%`);
  }
  if (filters.student) {
    query += ' AND (lower(COALESCE(s.full_name,t.candidate_name)) LIKE lower(?) OR lower(COALESCE(s.roll_number,\'\')) LIKE lower(?))';
    const like = `%${String(filters.student).trim()}%`;
    params.push(like, like);
  }
  if (filters.teacher) {
    query += ' AND COALESCE(t.teacher_id,a.owner_teacher_id)=?';
    params.push(Number(filters.teacher));
  }
  if (filters.year) {
    query += ' AND t.candidate_class=?';
    params.push(String(filters.year).toUpperCase());
  }
  if (filters.division) {
    query += ' AND t.candidate_division=?';
    params.push(String(filters.division).toUpperCase());
  }
  return { query, params };
}

async function getAttempt(attemptId) {
  return get(
    `SELECT ${resultColumns},a.id AS assessment_id
     ${resultJoins}
     WHERE t.id=? AND t.status IN ('submitted','expired')`,
    [attemptId]
  );
}

async function getAttemptDetails(attemptId) {
  const attempt = await getAttempt(attemptId);
  if (!attempt) return null;
  const questions = await all(
    `SELECT snap.question_id AS id,snap.question_text,snap.category,snap.position,
            snap.question_type,snap.marks,snap.negative_marks,snap.correct_option_id,
            snap.options_json,sa.option_id,sa.text_answer,sa.marks_awarded,sa.manual_feedback
     FROM attempt_question_snapshots snap
     LEFT JOIN submitted_answers sa ON sa.question_id=snap.question_id AND sa.attempt_id=snap.attempt_id
     WHERE snap.attempt_id=?
     ORDER BY snap.position,snap.question_id`,
    [attemptId]
  );
  return {
    ...attempt,
    questions: questions.map(question => {
      const options = JSON.parse(question.options_json || '[]');
      const selectedOption = options.find(option => Number(option.id) === Number(question.option_id));
      const correctOption = options.find(option => Number(option.id) === Number(question.correct_option_id));
      const subjective = question.question_type === 'subjective';
      const answered = subjective
        ? Boolean(String(question.text_answer || '').trim())
        : question.option_id !== null;
      const correct = !subjective && answered
        && Number(question.option_id) === Number(question.correct_option_id);
      return {
        id: question.id,
        question: question.question_text,
        category: question.category,
        type: question.question_type,
        marks: Number(question.marks),
        selectedAnswer: subjective ? question.text_answer || '' : selectedOption?.option_text || '',
        correctAnswer: subjective ? '' : correctOption?.option_text || '',
        status: !answered
          ? 'unanswered'
          : subjective
            ? question.marks_awarded === null
              ? 'manual'
              : Number(question.marks_awarded) >= Number(question.marks) ? 'correct' : 'incorrect'
            : correct ? 'correct' : 'incorrect',
        marksAwarded: question.marks_awarded === null
          ? (!subjective && correct ? Number(question.marks) : !subjective && answered ? -Number(question.negative_marks || 0) : null)
          : Number(question.marks_awarded),
        feedback: question.manual_feedback || ''
      };
    })
  };
}

function csvSafe(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[<>&'"]/g, character => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  })[character]);
}

function spreadsheetColumn(index) {
  let name = '';
  for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}

async function createWorkbook(rows, questionRows) {
  const headings = [
    'Teacher', 'Assessment', 'Subject', 'Student', 'Roll Number', 'Email',
    'Total Questions', 'Attempted', 'Unanswered', 'Correct', 'Wrong',
    'Marks Obtained', 'Total Marks', 'Percentage', 'Result', 'Submitted At'
  ];
  const summaryValues = [headings, ...rows.map(row => [
    row.teacher_name, row.assessment_title, row.subject_name, row.student_name,
    row.roll_number, row.candidate_email, row.total_questions, row.attempted,
    row.unanswered, row.correct_answers, row.incorrect_answers, row.marks_obtained,
    row.total_marks, row.percentage, row.evaluation_status === 'pending'
      ? 'Pending evaluation' : row.passed ? 'Pass' : 'Fail', row.completed_at
  ])];
  const detailValues = [[
    'Teacher', 'Assessment', 'Subject', 'Student', 'Roll Number', 'Question',
    'Selected Answer', 'Correct Answer', 'Answer Status', 'Marks Awarded', 'Maximum Marks', 'Feedback'
  ], ...questionRows.map(row => [
    row.teacher_name, row.assessment_title, row.subject_name, row.student_name,
    row.roll_number, row.question_text, row.selected_answer, row.correct_answer,
    row.answer_status, row.marks_awarded, row.maximum_marks, row.manual_feedback
  ])];
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Assessment Results" sheetId="1" r:id="rId1"/><sheet name="Question Details" sheetId="2" r:id="rId2"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>');
  const sheetXml = values => {
    const sheetRows = values.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => {
      const reference = `${spreadsheetColumn(columnIndex)}${rowIndex + 1}`;
      if (typeof cell === 'number' && Number.isFinite(cell)) return `<c r="${reference}"><v>${cell}</v></c>`;
      return `<c r="${reference}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`;
    }).join('')}</row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  };
  zip.file('xl/worksheets/sheet1.xml', sheetXml(summaryValues));
  zip.file('xl/worksheets/sheet2.xml', sheetXml(detailValues));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

router.get('/student', requireStudent, async (req, res) => {
  try {
    const rows = await all(
      `SELECT ${resultColumns}
       ${resultJoins}
       WHERE (t.student_id=? OR (t.student_id IS NULL AND lower(t.candidate_email)=lower(?)))
         AND t.status IN ('submitted','expired')
       ORDER BY r.completed_at DESC`,
      [req.session.studentId, req.session.studentEmail || '']
    );
    res.json(rows.map(row => ({
      ...row,
      detailsReleased: !row.result_release_at || Date.parse(row.result_release_at) <= Date.now()
    })));
  } catch (error) {
    console.error('Student assessment results failed:', error);
    res.status(500).json({ error: 'Unable to load your assessment results.' });
  }
});

router.get('/student/:attemptId', requireStudent, async (req, res) => {
  try {
    const attempt = await getAttempt(req.params.attemptId);
    if (!attempt) return res.status(404).json({ error: 'Assessment result not found.' });
    const belongsToStudent = attempt.student_id === req.session.studentId
      || (attempt.student_id === null
        && String(attempt.candidate_email).toLowerCase() === String(req.session.studentEmail || '').toLowerCase());
    if (!belongsToStudent) return res.status(404).json({ error: 'Assessment result not found.' });
    if (attempt.result_release_at && Date.parse(attempt.result_release_at) > Date.now()) {
      return res.status(403).json({ error: 'Detailed answers are not available until the result release time.' });
    }
    res.json(await getAttemptDetails(req.params.attemptId));
  } catch (error) {
    console.error('Student detailed result failed:', error);
    res.status(500).json({ error: 'Unable to load the detailed result.' });
  }
});

router.get('/teacher', requireTeacher, async (req, res) => {
  try {
    const assessments = await all(
      `SELECT DISTINCT a.id,a.title,a.subject_name,a.academic_year,a.passing_percentage,a.result_release_at
       FROM assessments a LEFT JOIN teacher_assessments ta ON ta.assessment_id=a.id
       WHERE a.owner_teacher_id=? OR ta.teacher_id=?
       ORDER BY a.id DESC`,
      [req.session.teacherId, req.session.teacherId]
    );
    for (const assessment of assessments) await syncAssessmentRoster(assessment.id);
    const filters = { ...req.query, teacher: req.session.teacherId };
    const filtered = resultFilter(
      `SELECT ${resultColumns},a.id AS assessment_id ${resultJoins}
       WHERE (COALESCE(t.teacher_id,a.owner_teacher_id)=?
         OR EXISTS(SELECT 1 FROM teacher_assessments ta WHERE ta.assessment_id=a.id AND ta.teacher_id=?))
         AND t.status IN ('submitted','expired')`,
      [req.session.teacherId, req.session.teacherId],
      { ...filters, teacher: undefined }
    );
    filtered.query += ' ORDER BY r.completed_at DESC';
    const attempts = await all(filtered.query, filtered.params);
    const summaries = await Promise.all(assessments.map(async assessment => {
      const assigned = await get(
        'SELECT COUNT(*) AS count FROM assessment_students WHERE assessment_id=?',
        [assessment.id]
      );
      const attempted = await get(
        `SELECT COUNT(DISTINCT t.student_id) AS count FROM examination_attempts t
         WHERE t.assessment_id=? AND t.teacher_id=? AND t.status IN ('submitted','expired')`,
        [assessment.id, req.session.teacherId]
      );
      const stats = await get(
        `SELECT MAX(r.marks_obtained) AS highest,MIN(r.marks_obtained) AS lowest,
                AVG(r.marks_obtained) AS average
         FROM results r JOIN examination_attempts t ON t.id=r.attempt_id
         WHERE t.assessment_id=? AND (t.teacher_id=? OR t.teacher_id IS NULL)`,
        [assessment.id, req.session.teacherId]
      );
      return {
        ...assessment,
        assignedStudents: Number(assigned.count || 0),
        attemptedStudents: Number(attempted.count || 0),
        notAttemptedStudents: Math.max(0, Number(assigned.count || 0) - Number(attempted.count || 0)),
        highestMarks: stats.highest,
        lowestMarks: stats.lowest,
        averageMarks: stats.average === null ? null : Math.round(Number(stats.average) * 100) / 100
      };
    }));
    res.json({ assessments: summaries, attempts });
  } catch (error) {
    console.error('Teacher assessment results failed:', error);
    res.status(500).json({ error: 'Unable to load your assessment results.' });
  }
});

router.get('/teacher/:attemptId', requireTeacher, async (req, res) => {
  try {
    const attempt = await getAttempt(req.params.attemptId);
    if (!attempt) return res.status(404).json({ error: 'Assessment result not found.' });
    const ownsAssessment = Number(attempt.teacher_id) === Number(req.session.teacherId)
      || Boolean(await get(
        'SELECT 1 FROM teacher_assessments WHERE assessment_id=? AND teacher_id=?',
        [attempt.assessment_id, req.session.teacherId]
      ));
    if (!ownsAssessment) return res.status(404).json({ error: 'Assessment result not found.' });
    res.json(await getAttemptDetails(req.params.attemptId));
  } catch (error) {
    console.error('Teacher detailed result failed:', error);
    res.status(500).json({ error: 'Unable to load the detailed result.' });
  }
});

router.post('/teacher/:attemptId/evaluate', requireTeacher, async (req, res) => {
  try {
    const attempt = await getAttempt(req.params.attemptId);
    if (!attempt) return res.status(404).json({ error: 'Assessment result not found.' });
    const ownsAssessment = Number(attempt.teacher_id) === Number(req.session.teacherId)
      || Boolean(await get(
        'SELECT 1 FROM teacher_assessments WHERE assessment_id=? AND teacher_id=?',
        [attempt.assessment_id, req.session.teacherId]
      ));
    if (!ownsAssessment) return res.status(404).json({ error: 'Assessment result not found.' });
    if (!Array.isArray(req.body.evaluations)) {
      return res.status(400).json({ error: 'Provide the subjective-question evaluations.' });
    }
    for (const evaluation of req.body.evaluations) {
      const questionId = Number(evaluation.questionId);
      const marksAwarded = Number(evaluation.marksAwarded);
      const question = await get(
        `SELECT snap.marks FROM attempt_question_snapshots snap
         JOIN submitted_answers sa ON sa.question_id=snap.question_id AND sa.attempt_id=snap.attempt_id
         WHERE snap.attempt_id=? AND snap.question_id=? AND snap.question_type='subjective'
           AND trim(sa.text_answer)<>''`,
        [req.params.attemptId, questionId]
      );
      if (!question || !Number.isFinite(marksAwarded) || marksAwarded < 0
        || marksAwarded > Number(question.marks)) {
        return res.status(400).json({ error: 'A subjective question or awarded mark is invalid.' });
      }
      await run(
        `UPDATE submitted_answers SET marks_awarded=?,manual_feedback=?,evaluated_at=?
         WHERE attempt_id=? AND question_id=?`,
        [
          marksAwarded,
          String(evaluation.feedback || '').slice(0, 1000),
          new Date().toISOString(),
          req.params.attemptId,
          questionId
        ]
      );
    }
    const result = await calculateAndPersistResult(req.params.attemptId);
    res.json(result);
  } catch (error) {
    console.error('Manual assessment evaluation failed:', error);
    res.status(500).json({ error: 'Unable to save the manual evaluation.' });
  }
});

router.get('/admin/export.xlsx', requireAdmin, async (req, res) => {
  try {
    let query = `SELECT ${resultColumns},a.id AS assessment_id ${resultJoins}
      WHERE t.status IN ('submitted','expired')`;
    const filtered = resultFilter(query, [], req.query);
    filtered.query += ' ORDER BY r.completed_at DESC';
    const rows = await all(filtered.query, filtered.params);
    const attemptIds = rows.map(row => row.attempt_id);
    const questionRows = [];
    for (let offset = 0; offset < attemptIds.length; offset += 400) {
      const batch = attemptIds.slice(offset, offset + 400);
      const placeholders = batch.map(() => '?').join(',');
      const batchRows = await all(
        `SELECT COALESCE(th.full_name,'Unassigned') AS teacher_name,a.title AS assessment_title,
                a.subject_name,COALESCE(s.full_name,t.candidate_name) AS student_name,
                COALESCE(s.roll_number,'') AS roll_number,q.question_text,q.options_json,
                q.question_type,q.correct_option_id,q.marks,q.negative_marks,
                sa.option_id,sa.text_answer,sa.marks_awarded,sa.manual_feedback
         FROM examination_attempts t JOIN assessments a ON a.id=t.assessment_id
         JOIN attempt_question_snapshots q ON q.attempt_id=t.id
         LEFT JOIN student_accounts s ON s.id=t.student_id
         LEFT JOIN teachers th ON th.id=COALESCE(t.teacher_id,a.owner_teacher_id)
         LEFT JOIN submitted_answers sa ON sa.attempt_id=t.id AND sa.question_id=q.question_id
         WHERE t.id IN (${placeholders}) ORDER BY t.submitted_at,q.position,q.question_id`,
        batch
      );
      questionRows.push(...batchRows.map(row => {
        const options = JSON.parse(row.options_json || '[]');
        const subjective = row.question_type === 'subjective';
        const answered = subjective
          ? Boolean(String(row.text_answer || '').trim())
          : row.option_id !== null;
        const correct = !subjective && answered
          && Number(row.option_id) === Number(row.correct_option_id);
        const selected = options.find(option => Number(option.id) === Number(row.option_id));
        const correctOption = options.find(option => Number(option.id) === Number(row.correct_option_id));
        return {
          ...row,
          selected_answer: subjective ? row.text_answer || '' : selected?.option_text || '',
          correct_answer: subjective ? '' : correctOption?.option_text || '',
          answer_status: !answered ? 'Unanswered'
            : subjective
              ? row.marks_awarded === null ? 'Pending evaluation'
                : Number(row.marks_awarded) >= Number(row.marks) ? 'Correct' : 'Evaluated'
              : correct ? 'Correct' : 'Incorrect',
          marks_awarded: subjective ? row.marks_awarded
            : correct ? Number(row.marks) : answered ? -Number(row.negative_marks || 0) : 0,
          maximum_marks: row.marks,
          manual_feedback: row.manual_feedback || ''
        };
      }));
    }
    const workbook = await createWorkbook(rows, questionRows);
    const parts = ['assessment-results'];
    if (req.query.teacher) parts.push(`teacher-${Number(req.query.teacher)}`);
    if (req.query.assessment) parts.push(`assessment-${Number(req.query.assessment)}`);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${parts.join('-')}.xlsx"`
    });
    res.send(workbook);
  } catch (error) {
    console.error('Assessment result export failed:', error);
    res.status(500).json({ error: 'Unable to export assessment results.' });
  }
});

router.get('/admin/summary', requireAdmin, async (req, res) => {
  try {
    let query = `
      SELECT a.id AS assessment_id,a.title AS assessment_title,a.subject_name,a.academic_year,
             COALESCE(th.id,(SELECT ta.teacher_id FROM teacher_assessments ta
               WHERE ta.assessment_id=a.id LIMIT 1)) AS teacher_id,
             COALESCE(th.full_name,'Unassigned') AS teacher_name,
             (SELECT COUNT(*) FROM assessment_students ast WHERE ast.assessment_id=a.id) AS assigned_students,
             (SELECT COUNT(DISTINCT COALESCE(t.student_id,lower(t.candidate_email)))
                FROM examination_attempts t WHERE t.assessment_id=a.id
                  AND t.status IN ('submitted','expired')) AS attempted_students,
             (SELECT COUNT(*) FROM results r JOIN examination_attempts t ON t.id=r.attempt_id
                WHERE t.assessment_id=a.id) AS result_count,
             (SELECT MAX(r.marks_obtained) FROM results r JOIN examination_attempts t ON t.id=r.attempt_id
                WHERE t.assessment_id=a.id) AS highest_marks,
             (SELECT MIN(r.marks_obtained) FROM results r JOIN examination_attempts t ON t.id=r.attempt_id
                WHERE t.assessment_id=a.id) AS lowest_marks,
             (SELECT AVG(r.marks_obtained) FROM results r JOIN examination_attempts t ON t.id=r.attempt_id
                WHERE t.assessment_id=a.id) AS average_marks
      FROM assessments a
      LEFT JOIN teachers th ON th.id=a.owner_teacher_id
      WHERE 1=1`;
    const params = [];
    if (req.query.teacher) {
      query += ` AND COALESCE(th.id,(SELECT ta.teacher_id FROM teacher_assessments ta
        WHERE ta.assessment_id=a.id LIMIT 1))=?`;
      params.push(Number(req.query.teacher));
    }
    if (req.query.assessment) {
      query += ' AND a.id=?';
      params.push(Number(req.query.assessment));
    }
    if (req.query.subject) {
      query += ' AND lower(a.subject_name) LIKE lower(?)';
      params.push(`%${String(req.query.subject).trim()}%`);
    }
    query += ' ORDER BY teacher_name COLLATE NOCASE,a.title COLLATE NOCASE';
    const rows = await all(query, params);
    res.json(rows.map(row => ({
      ...row,
      not_attempted_students: Math.max(0, Number(row.assigned_students) - Number(row.attempted_students)),
      average_marks: row.average_marks === null ? null : Math.round(Number(row.average_marks) * 100) / 100
    })));
  } catch (error) {
    console.error('Administrator assessment summaries failed:', error);
    res.status(500).json({ error: 'Unable to load teacher-wise assessment summaries.' });
  }
});

router.post('/admin/:attemptId/reset', requireAdmin, async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 8 || reason.length > 500) {
      return res.status(400).json({ error: 'Provide a reset reason between 8 and 500 characters.' });
    }
    const submission = await get(
      `SELECT id,student_id,assessment_id,attempt_id
       FROM assessment_submissions WHERE attempt_id=? AND reset_at IS NULL`,
      [req.params.attemptId]
    );
    if (!submission) {
      return res.status(404).json({ error: 'Active submission record not found.' });
    }
    const resetAt = new Date().toISOString();
    const updated = await run(
      `UPDATE assessment_submissions
       SET reset_at=?,reset_by_admin_id=?,reset_reason=?
       WHERE id=? AND reset_at IS NULL`,
      [resetAt, req.session.adminId, reason, submission.id]
    );
    if (!updated.changes) {
      return res.status(409).json({ error: 'This submission has already been reset.' });
    }
    res.json({
      ok: true,
      message: 'Attempt reset. The student may start this assessment again.',
      studentId: submission.student_id,
      assessmentId: submission.assessment_id,
      attemptId: submission.attempt_id
    });
  } catch (error) {
    console.error('Administrator assessment reset failed:', error);
    res.status(500).json({ error: 'Unable to reset the assessment attempt.' });
  }
});

router.get('/admin', requireAdmin, async (req, res) => {
  try {
    let query = `SELECT ${resultColumns},a.id AS assessment_id ${resultJoins}
      WHERE t.status IN ('submitted','expired')`;
    const filtered = resultFilter(query, [], req.query);
    filtered.query += ' ORDER BY r.completed_at DESC';
    res.json(await all(filtered.query, filtered.params));
  } catch (error) {
    console.error('Administrator assessment results failed:', error);
    res.status(500).json({ error: 'Unable to load assessment results.' });
  }
});

router.get('/admin/:attemptId', requireAdmin, async (req, res) => {
  try {
    const attempt = await getAttemptDetails(req.params.attemptId);
    if (!attempt) return res.status(404).json({ error: 'Assessment result not found.' });
    res.json(attempt);
  } catch (error) {
    console.error('Administrator detailed result failed:', error);
    res.status(500).json({ error: 'Unable to load the detailed result.' });
  }
});

module.exports = router;
