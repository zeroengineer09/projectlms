const { get, all, run } = require('./database');

async function syncAssessmentRoster(assessmentId) {
  const assessment = await get(
    'SELECT id,academic_year,subject_name,owner_teacher_id FROM assessments WHERE id=?',
    [assessmentId]
  );
  if (!assessment) return;

  let divisions = '';
  if (assessment.owner_teacher_id) {
    const subject = await get(
      `SELECT divisions FROM teacher_subjects
       WHERE teacher_id=? AND academic_year=? AND lower(subject_name)=lower(?)
       ORDER BY id LIMIT 1`,
      [assessment.owner_teacher_id, assessment.academic_year, assessment.subject_name]
    );
    divisions = String(subject?.divisions || '').trim().toUpperCase();
  }
  const students = await all(
    `SELECT id,academic_year,division FROM student_accounts
     WHERE active=1 AND (?='ALL' OR upper(academic_year)=upper(?))`,
    [assessment.academic_year, assessment.academic_year]
  );
  const allowedDivisions = divisions
    ? new Set(divisions.split(/[,\s|/]+/).filter(Boolean))
    : null;
  for (const student of students) {
    if (allowedDivisions && !allowedDivisions.has(String(student.division || '').toUpperCase())) continue;
    await run(
      'INSERT OR IGNORE INTO assessment_students(assessment_id,student_id) VALUES(?,?)',
      [assessment.id, student.id]
    );
  }
}

async function calculateAndPersistResult(attemptId, completedAt) {
  const attempt = await get(
    `SELECT t.*,a.title AS assessment_title,a.subject_name,a.passing_percentage,
            a.result_release_at,a.owner_teacher_id
     FROM examination_attempts t JOIN assessments a ON a.id=t.assessment_id
     WHERE t.id=?`,
    [attemptId]
  );
  if (!attempt) throw new Error('Attempt not found while calculating its result.');

  const questions = await all(
    `SELECT question_id AS id,question_type,correct_option_id,marks,negative_marks
     FROM attempt_question_snapshots WHERE attempt_id=?`,
    [attemptId]
  );
  const answers = await all(
    `SELECT question_id,option_id,text_answer,marks_awarded
     FROM submitted_answers WHERE attempt_id=?`,
    [attemptId]
  );
  const answerByQuestion = new Map(answers.map(answer => [answer.question_id, answer]));
  let attempted = 0;
  let correct = 0;
  let incorrect = 0;
  let unanswered = 0;
  let pendingManual = 0;
  let marksObtained = 0;
  const totalMarks = questions.reduce((sum, question) => sum + Number(question.marks || 0), 0);

  for (const question of questions) {
    const answer = answerByQuestion.get(question.id);
    const isSubjective = question.question_type === 'subjective';
    const hasAnswer = isSubjective
      ? Boolean(String(answer?.text_answer || '').trim())
      : answer?.option_id !== null && answer?.option_id !== undefined;
    if (!hasAnswer) {
      unanswered += 1;
      continue;
    }

    attempted += 1;
    if (isSubjective) {
      if (answer.marks_awarded === null || answer.marks_awarded === undefined) {
        pendingManual += 1;
      } else {
        const awarded = Number(answer.marks_awarded);
        marksObtained += awarded;
        if (awarded >= Number(question.marks)) correct += 1;
        else incorrect += 1;
      }
    } else if (Number(answer.option_id) === Number(question.correct_option_id)) {
      correct += 1;
      marksObtained += Number(question.marks);
    } else {
      incorrect += 1;
      marksObtained -= Number(question.negative_marks || 0);
    }
  }

  const percentage = totalMarks
    ? Math.round((marksObtained / totalMarks) * 10000) / 100
    : 0;
  const evaluationStatus = pendingManual ? 'pending' : 'complete';
  const passed = evaluationStatus === 'complete' && percentage >= Number(attempt.passing_percentage);
  const completionTime = completedAt || attempt.submitted_at || new Date().toISOString();
  await run(
    `INSERT INTO results(
       attempt_id,total_questions,correct_answers,incorrect_answers,unanswered,score,
       percentage,passed,completed_at,attempted,marks_obtained,total_marks,pending_manual,evaluation_status
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(attempt_id) DO UPDATE SET
       total_questions=excluded.total_questions,
       correct_answers=excluded.correct_answers,
       incorrect_answers=excluded.incorrect_answers,
       unanswered=excluded.unanswered,
       score=excluded.score,
       percentage=excluded.percentage,
       passed=excluded.passed,
       completed_at=excluded.completed_at,
       attempted=excluded.attempted,
       marks_obtained=excluded.marks_obtained,
       total_marks=excluded.total_marks,
       pending_manual=excluded.pending_manual,
       evaluation_status=excluded.evaluation_status`,
    [
      attemptId, questions.length, correct, incorrect, unanswered, correct, percentage,
      passed ? 1 : 0, completionTime, attempted, marksObtained, totalMarks,
      pendingManual, evaluationStatus
    ]
  );

  return getStoredResult(attemptId);
}

function getStoredResult(attemptId) {
  return get(
    `SELECT r.*,t.candidate_name,t.candidate_email,t.candidate_class,t.candidate_division,
            t.student_id,t.teacher_id,t.assessment_id,a.title AS assessment_title,
            a.subject_name,a.result_release_at,a.passing_percentage
     FROM results r JOIN examination_attempts t ON t.id=r.attempt_id
     JOIN assessments a ON a.id=t.assessment_id
     WHERE r.attempt_id=?`,
    [attemptId]
  );
}

module.exports = { syncAssessmentRoster, calculateAndPersistResult, getStoredResult };
