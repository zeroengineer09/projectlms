const crypto = require('crypto');
const express = require('express');
const { run, get, all } = require('../database');
const {
  calculateAndPersistResult,
  getStoredResult,
  syncAssessmentRoster
} = require('../services/assessmentResultUtils');

const router = express.Router();

function requireStudent(req, res, next) {
  if (!req.session.studentId) {
    return res.status(401).json({ error: 'Sign in with your student account before continuing.' });
  }
  if (req.session.studentMustChangePassword) {
    return res.status(403).json({ error: 'Change your initial student password before continuing.' });
  }
  next();
}

async function getOwnedAttempt(attemptId, studentId) {
  return get('SELECT * FROM examination_attempts WHERE id=? AND student_id=?', [attemptId, studentId]);
}

async function hasCompletedAssessment(studentId, assessmentId) {
  return get(
    `SELECT 1 FROM assessment_submissions
     WHERE student_id=? AND assessment_id=? AND reset_at IS NULL`,
    [studentId, assessmentId]
  );
}

function isDuplicateSubmission(error) {
  return /UNIQUE constraint failed: assessment_submissions\.student_id, assessment_submissions\.assessment_id/i
    .test(String(error.message || ''));
}

async function submitAttempt(attemptId, expired = false) {
  const attempt = await get(
    `SELECT t.*,a.title,a.passing_percentage,a.owner_teacher_id
     FROM examination_attempts t JOIN assessments a ON a.id=t.assessment_id
     WHERE t.id=? AND t.status='in_progress'`,
    [attemptId]
  );
  if (!attempt) return null;
  const completedAt = new Date().toISOString();
  const update = await run(
    "UPDATE examination_attempts SET status=?,submitted_at=? WHERE id=? AND status='in_progress'",
    [expired ? 'expired' : 'submitted', completedAt, attemptId]
  );
  if (!update.changes) return null;
  return calculateAndPersistResult(attemptId, completedAt);
}

function publicResult(result) {
  return {
    attemptId: result.attempt_id,
    candidateName: result.candidate_name,
    candidateClass: result.candidate_class || '',
    candidateDivision: result.candidate_division || '',
    assessmentTitle: result.assessment_title,
    totalQuestions: result.total_questions,
    attempted: result.attempted,
    correctAnswers: result.correct_answers,
    incorrectAnswers: result.incorrect_answers,
    unanswered: result.unanswered,
    score: result.score,
    marksObtained: result.marks_obtained,
    totalMarks: result.total_marks,
    percentage: result.percentage,
    passed: result.evaluation_status === 'complete' && Boolean(result.passed),
    evaluationStatus: result.evaluation_status,
    pendingManual: result.pending_manual,
    completedAt: result.completed_at
  };
}

router.get('/assessments', requireStudent, async (req, res) => {
  try {
    const student = await get(
      'SELECT id,academic_year FROM student_accounts WHERE id=? AND active=1',
      [req.session.studentId]
    );
    if (!student) return res.status(401).json({ error: 'Student account not found.' });
    const assessments = await all(
      `SELECT id FROM assessments WHERE enabled=1 AND academic_year IN (?, 'ALL')
       AND lower(trim(title))!=lower(?)`,
      [String(student.academic_year || '').toUpperCase(), 'Certified Web Test']
    );
    for (const assessment of assessments) await syncAssessmentRoster(assessment.id);
    res.json(await all(
      `SELECT a.id,a.title,a.description,a.duration_minutes,a.passing_percentage,
              a.max_attempts,a.academic_year,a.subject_name
       FROM assessments a JOIN assessment_students ast ON ast.assessment_id=a.id
       WHERE a.enabled=1 AND a.academic_year IN (?, 'ALL') AND ast.student_id=?
         AND lower(trim(a.title))!=lower(?)
         AND NOT EXISTS (
           SELECT 1 FROM assessment_submissions submission
           WHERE submission.assessment_id=a.id AND submission.student_id=ast.student_id
             AND submission.reset_at IS NULL
         )
       ORDER BY a.id`,
      [String(student.academic_year || '').toUpperCase(), student.id, 'Certified Web Test']
    ));
  } catch (error) {
    console.error('Assessment list failed:', error);
    res.status(500).json({ error: 'Unable to load assessments.' });
  }
});

router.post('/register', requireStudent, async (req, res) => {
  try {
    const student = await get('SELECT * FROM student_accounts WHERE id=? AND active=1', [req.session.studentId]);
    if (!student) return res.status(401).json({ error: 'Student account not found.' });
    const candidateClass = String(student.academic_year || '').trim().toUpperCase();
    const candidateDivision = String(student.division || '').trim().toUpperCase();
    const assessmentId = Number(req.body.assessmentId);
    if (student.full_name.trim().length < 2 || !['FY', 'SY', 'TY'].includes(candidateClass)
      || !['A', 'B', 'C', 'D'].includes(candidateDivision)) {
      return res.status(400).json({
        error: 'Your student roster is missing a valid class/year or division. Contact the administrator.'
      });
    }

    await syncAssessmentRoster(assessmentId);
    const assessment = await get(
      `SELECT a.*,COALESCE(a.owner_teacher_id,
        (SELECT ta.teacher_id FROM teacher_assessments ta WHERE ta.assessment_id=a.id LIMIT 1)) AS creator_teacher_id
       FROM assessments a WHERE a.id=? AND a.enabled=1 AND a.academic_year IN (?, 'ALL')`,
      [assessmentId, candidateClass]
    );
    if (!assessment) return res.status(404).json({ error: 'This assessment is not assigned to your selected year.' });
    const assigned = await get(
      'SELECT 1 FROM assessment_students WHERE assessment_id=? AND student_id=?',
      [assessment.id, student.id]
    );
    if (!assigned) return res.status(403).json({ error: 'This assessment is not assigned to your student account.' });

    const completed = await get(
      `SELECT 1 FROM assessment_submissions
       WHERE assessment_id=? AND student_id=? AND reset_at IS NULL`,
      [assessment.id, student.id]
    );
    if (completed) {
      return res.status(403).json({ error: 'Completed – Assessment Submitted. This assessment can only be attempted once.' });
    }

    const active = await get(
      "SELECT id FROM examination_attempts WHERE assessment_id=? AND student_id=? AND status='in_progress'",
      [assessment.id, student.id]
    );
    if (active) return res.json({ attemptId: active.id, resume: true });
    const count = await get(
      `SELECT COUNT(*) AS count FROM examination_attempts t
       WHERE t.assessment_id=? AND t.student_id=?
         AND NOT EXISTS (
           SELECT 1 FROM assessment_submissions submission
           WHERE submission.attempt_id=t.id AND submission.reset_at IS NOT NULL
         )`,
      [assessment.id, student.id]
    );
    if (count.count >= assessment.max_attempts) {
      return res.status(403).json({ error: 'Attempt limit reached for this assessment.' });
    }
    const questions = await get(
      'SELECT COUNT(*) AS count FROM questions WHERE assessment_id=? AND active=1',
      [assessment.id]
    );
    if (!questions.count) return res.status(400).json({ error: 'This assessment has no active questions.' });

    const id = crypto.randomUUID();
    const start = new Date();
    const deadline = new Date(start.getTime() + assessment.duration_minutes * 60000);
    await run(
      `INSERT INTO examination_attempts(
        id,assessment_id,candidate_name,candidate_email,candidate_class,candidate_division,
        student_id,teacher_id,started_at,deadline_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        id, assessment.id, student.full_name, student.email, candidateClass, candidateDivision,
        student.id, assessment.creator_teacher_id, start.toISOString(), deadline.toISOString()
      ]
    );
    try {
      const snapshotQuestions = await all(
        `SELECT id,question_text,category,question_type,marks,negative_marks,
                correct_option_id,position
         FROM questions WHERE assessment_id=? AND active=1 ORDER BY position,id`,
        [assessment.id]
      );
      for (const question of snapshotQuestions) {
        const options = await all(
          'SELECT id,option_text,position FROM options WHERE question_id=? ORDER BY position,id',
          [question.id]
        );
        await run(
          `INSERT INTO attempt_question_snapshots(
            attempt_id,question_id,question_text,category,question_type,marks,
            negative_marks,correct_option_id,options_json,position
          ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
          [
            id, question.id, question.question_text, question.category,
            question.question_type, question.marks, question.negative_marks,
            question.correct_option_id, JSON.stringify(options), question.position
          ]
        );
      }
    } catch (error) {
      await run('DELETE FROM examination_attempts WHERE id=?', [id]);
      throw error;
    }
    req.session.attemptId = id;
    res.json({ attemptId: id, resume: false });
  } catch (error) {
    console.error('Assessment registration failed:', error);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(403).json({ error: 'Completed – Assessment Submitted. This assessment can only be attempted once.' });
    }
    res.status(500).json({ error: 'Registration failed.' });
  }
});

router.get('/attempt/:id', requireStudent, async (req, res) => {
  try {
    const attempt = await getOwnedAttempt(req.params.id, req.session.studentId);
    if (!attempt) return res.status(404).json({ error: 'Attempt not found.' });
    if (await hasCompletedAssessment(attempt.student_id, attempt.assessment_id)) {
      return res.status(409).json({ error: 'Completed – Assessment Submitted.' });
    }
    if (attempt.status !== 'in_progress') {
      return res.status(409).json({ error: 'This examination has already been submitted.' });
    }
    if (Date.now() >= Date.parse(attempt.deadline_at)) {
      await submitAttempt(attempt.id, true);
      return res.status(410).json({ error: 'Time expired. Your examination was submitted.' });
    }
    const details = await get(
      `SELECT a.title,a.duration_minutes,a.auto_submit_tab_switch,
              a.auto_submit_fullscreen_exit,a.maximum_warnings
       FROM assessments a WHERE a.id=?`,
      [attempt.assessment_id]
    );
    const questions = await all(
      `SELECT question_id AS id,question_text,category,position,question_type,marks,options_json
       FROM attempt_question_snapshots WHERE attempt_id=? ORDER BY position,id`,
      [attempt.id]
    );
    const output = [];
    for (const question of questions) {
      const savedAnswer = await get(
        'SELECT option_id,text_answer FROM submitted_answers WHERE attempt_id=? AND question_id=?',
        [attempt.id, question.id]
      );
      output.push({
        ...question,
        options: question.question_type === 'subjective' ? [] : JSON.parse(question.options_json || '[]'),
        selected: savedAnswer?.option_id || null,
        selectedText: savedAnswer?.text_answer || ''
      });
    }
    res.json({
      attempt: {
        id: attempt.id,
        name: attempt.candidate_name,
        email: attempt.candidate_email,
        className: attempt.candidate_class,
        division: attempt.candidate_division,
        title: details.title,
        deadlineAt: attempt.deadline_at,
        serverNow: new Date().toISOString(),
        policy: {
          autoSubmitOnTabSwitch: Boolean(details.auto_submit_tab_switch),
          autoSubmitOnFullscreenExit: Boolean(details.auto_submit_fullscreen_exit),
          maximumWarnings: details.maximum_warnings
        }
      },
      questions: output
    });
  } catch (error) {
    if (isDuplicateSubmission(error)) {
      return res.status(409).json({ error: 'Completed – Assessment Submitted.' });
    }
    console.error('Examination load failed:', error);
    res.status(500).json({ error: 'Unable to load examination.' });
  }
});

router.put('/attempt/:id/answer', requireStudent, async (req, res) => {
  try {
    const attempt = await getOwnedAttempt(req.params.id, req.session.studentId);
    if (attempt && await hasCompletedAssessment(attempt.student_id, attempt.assessment_id)) {
      return res.status(409).json({ error: 'Completed – Assessment Submitted.' });
    }
    if (!attempt || attempt.status !== 'in_progress') {
      return res.status(409).json({ error: 'Attempt is not active.' });
    }
    if (Date.now() >= Date.parse(attempt.deadline_at)) {
      await submitAttempt(attempt.id, true);
      return res.status(410).json({ error: 'Time expired.' });
    }
    const questionId = Number(req.body.questionId);
    const question = await get(
      `SELECT question_id AS id,question_type,options_json
       FROM attempt_question_snapshots WHERE attempt_id=? AND question_id=?`,
      [attempt.id, questionId]
    );
    if (!question) return res.status(400).json({ error: 'Invalid question.' });
    let optionId = null;
    let textAnswer = '';
    if (question.question_type === 'subjective') {
      textAnswer = String(req.body.textAnswer || '').slice(0, 10000);
    } else {
      optionId = req.body.optionId === null ? null : Number(req.body.optionId);
      if (optionId !== null) {
        const options = JSON.parse(question.options_json || '[]');
        if (!options.some(option => Number(option.id) === optionId)) {
          return res.status(400).json({ error: 'Invalid option.' });
        }
      }
    }
    await run(
      `INSERT INTO submitted_answers(attempt_id,question_id,option_id,text_answer,updated_at)
       VALUES(?,?,?,?,?) ON CONFLICT(attempt_id,question_id) DO UPDATE SET
       option_id=excluded.option_id,text_answer=excluded.text_answer,
       marks_awarded=NULL,manual_feedback='',evaluated_at=NULL,updated_at=excluded.updated_at`,
      [attempt.id, question.id, optionId, textAnswer, new Date().toISOString()]
    );
    res.json({ ok: true });
  } catch (error) {
    if (isDuplicateSubmission(error)) {
      return res.status(409).json({ error: 'Completed – Assessment Submitted.' });
    }
    console.error('Assessment answer save failed:', error);
    res.status(500).json({ error: 'Unable to save answer.' });
  }
});

router.post('/attempt/:id/violation', requireStudent, async (req, res) => {
  try {
    const attempt = await getOwnedAttempt(req.params.id, req.session.studentId);
    if (attempt && await hasCompletedAssessment(attempt.student_id, attempt.assessment_id)) {
      return res.status(409).json({ error: 'Completed – Assessment Submitted.' });
    }
    if (!attempt || attempt.status !== 'in_progress') {
      return res.status(409).json({ error: 'Attempt is not active.' });
    }
    const policy = await get(
      `SELECT auto_submit_tab_switch,auto_submit_fullscreen_exit,maximum_warnings
       FROM assessments WHERE id=?`,
      [attempt.assessment_id]
    );
    const type = String(req.body.type || '').slice(0, 40);
    if (!['tab_switch', 'fullscreen_exit'].includes(type)) {
      return res.status(400).json({ error: 'Invalid violation type.' });
    }
    await run('INSERT INTO violation_logs(attempt_id,violation_type) VALUES(?,?)', [attempt.id, type]);
    const warnings = Number(attempt.warnings) + 1;
    await run('UPDATE examination_attempts SET warnings=? WHERE id=?', [warnings, attempt.id]);
    const autoSubmit = type === 'tab_switch'
      ? policy.auto_submit_tab_switch
      : policy.auto_submit_fullscreen_exit;
    let result = null;
    if (autoSubmit && (policy.maximum_warnings === 0 || warnings > policy.maximum_warnings)) {
      result = await submitAttempt(attempt.id);
    }
    res.json({ submitted: Boolean(result), result: result ? publicResult(result) : null, warnings });
  } catch (error) {
    if (isDuplicateSubmission(error)) {
      return res.status(409).json({ error: 'Completed – Assessment Submitted.' });
    }
    console.error('Assessment violation recording failed:', error);
    res.status(500).json({ error: 'Unable to record violation.' });
  }
});

router.post('/attempt/:id/submit', requireStudent, async (req, res) => {
  try {
    const attempt = await getOwnedAttempt(req.params.id, req.session.studentId);
    if (!attempt) return res.status(404).json({ error: 'Attempt not found.' });
    if (await hasCompletedAssessment(attempt.student_id, attempt.assessment_id)) {
      return res.status(409).json({ error: 'Completed – Assessment Submitted. This assessment can only be attempted once.' });
    }
    if (attempt.status !== 'in_progress') {
      return res.status(409).json({ error: 'Completed – Assessment Submitted. This attempt cannot be submitted again.' });
    }
    const expired = Date.now() >= Date.parse(attempt.deadline_at);
    const result = await submitAttempt(attempt.id, expired);
    if (!result) return res.status(409).json({ error: 'Attempt could not be submitted.' });
    res.json(publicResult(result));
  } catch (error) {
    if (isDuplicateSubmission(error)) {
      return res.status(409).json({ error: 'Completed – Assessment Submitted. This assessment can only be attempted once.' });
    }
    console.error('Assessment submission failed:', error);
    res.status(500).json({ error: 'Submission failed.' });
  }
});

router.get('/result/:id', requireStudent, async (req, res) => {
  try {
    const attempt = await getOwnedAttempt(req.params.id, req.session.studentId);
    if (!attempt || !['submitted', 'expired'].includes(attempt.status)) {
      return res.status(404).json({ error: 'Result not found.' });
    }
    const result = await getStoredResult(attempt.id);
    if (!result) return res.status(404).json({ error: 'Result not found.' });
    res.json(publicResult(result));
  } catch (error) {
    console.error('Assessment result lookup failed:', error);
    res.status(500).json({ error: 'Unable to load result.' });
  }
});

module.exports = router;
