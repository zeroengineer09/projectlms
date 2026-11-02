const fs = require('fs');
const path = require('path');
const { exec, all, get, run } = require('./database');

async function ensureColumn(table, column, definition) {
  const columns = await all(`PRAGMA table_info(${table})`);
  if (!columns.some((c) => c.name === column)) {
    await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function ensurePasswordResetTable() {
  const existing = await get(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='password_reset_otps'"
  );
  const sql = existing?.sql || '';
  if (!sql.includes("'admin'") || !sql.includes('last_sent_at') || !sql.includes('used_at')) {
    await exec(`BEGIN IMMEDIATE;
      DROP TABLE IF EXISTS password_reset_otps;
      CREATE TABLE password_reset_otps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL COLLATE NOCASE,
        account_type TEXT NOT NULL CHECK(account_type IN ('student','teacher','admin')),
        otp_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_sent_at TEXT NOT NULL DEFAULT (datetime('now')),
        used_at TEXT,
        UNIQUE(email,account_type)
      );
      CREATE INDEX idx_password_reset_email ON password_reset_otps(email,account_type);
      COMMIT;`);
    return;
  }
  await exec('CREATE INDEX IF NOT EXISTS idx_password_reset_email ON password_reset_otps(email,account_type)');
}

async function ensureSchema() {
  const schemaPath = path.resolve(__dirname, '../database/schema.sql');
  await exec(fs.readFileSync(schemaPath, 'utf8'));

  // Backward-compatible migrations for databases created by earlier versions.
  await ensureColumn('administrators', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('assessments', 'academic_year', "TEXT NOT NULL DEFAULT 'ALL'");
  await ensureColumn('assessments', 'subject_name', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('assessments', 'result_release_at', 'TEXT');
  await ensureColumn('examination_attempts', 'candidate_class', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('examination_attempts', 'candidate_division', "TEXT NOT NULL DEFAULT ''");
  await exec("CREATE TABLE IF NOT EXISTS teachers (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1 CHECK(must_change_password IN(0,1)), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), created_at TEXT NOT NULL DEFAULT (datetime('now')), password_changed_at TEXT)");
  await ensureColumn('teachers', 'teacher_number', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('teachers', 'department', "TEXT NOT NULL DEFAULT ''");
  await exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_teachers_number ON teachers(teacher_number COLLATE NOCASE) WHERE teacher_number<>''");
  await exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_administrators_username_nocase ON administrators(lower(username))");
  await ensurePasswordResetTable();

  await exec(`CREATE TABLE IF NOT EXISTS teacher_subjects (id INTEGER PRIMARY KEY, teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, subject_name TEXT NOT NULL, academic_year TEXT NOT NULL DEFAULT 'FY', divisions TEXT NOT NULL DEFAULT '', UNIQUE(teacher_id, subject_name, academic_year));
  CREATE TABLE IF NOT EXISTS teacher_assessments (teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE, PRIMARY KEY(teacher_id, assessment_id));`);
  await ensureColumn('assessments', 'owner_teacher_id', 'INTEGER REFERENCES teachers(id)');
  await ensureColumn('questions', 'question_type', "TEXT NOT NULL DEFAULT 'objective'");
  await ensureColumn('questions', 'marks', 'REAL NOT NULL DEFAULT 1');
  await ensureColumn('questions', 'negative_marks', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn('examination_attempts', 'student_id', 'INTEGER REFERENCES student_accounts(id)');
  await ensureColumn('examination_attempts', 'teacher_id', 'INTEGER REFERENCES teachers(id)');
  await ensureColumn('submitted_answers', 'text_answer', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('submitted_answers', 'marks_awarded', 'REAL');
  await ensureColumn('submitted_answers', 'manual_feedback', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('submitted_answers', 'evaluated_at', 'TEXT');
  await ensureColumn('results', 'attempted', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('results', 'marks_obtained', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn('results', 'total_marks', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn('results', 'pending_manual', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('results', 'evaluation_status', "TEXT NOT NULL DEFAULT 'complete'");
  await exec(`CREATE TABLE IF NOT EXISTS assessment_students (
    assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES student_accounts(id) ON DELETE CASCADE,
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (assessment_id, student_id)
  );
  CREATE INDEX IF NOT EXISTS idx_assessment_students_student ON assessment_students(student_id, assessment_id);
  CREATE INDEX IF NOT EXISTS idx_attempt_student_assessment ON examination_attempts(student_id, assessment_id);
  CREATE INDEX IF NOT EXISTS idx_attempt_teacher_assessment ON examination_attempts(teacher_id, assessment_id);
  UPDATE examination_attempts
     SET student_id=(SELECT s.id FROM student_accounts s WHERE lower(s.email)=lower(examination_attempts.candidate_email) LIMIT 1)
   WHERE student_id IS NULL;
  UPDATE examination_attempts
     SET teacher_id=COALESCE(
       (SELECT a.owner_teacher_id FROM assessments a WHERE a.id=examination_attempts.assessment_id),
       (SELECT ta.teacher_id FROM teacher_assessments ta WHERE ta.assessment_id=examination_attempts.assessment_id LIMIT 1)
     )
   WHERE teacher_id IS NULL;
  UPDATE assessments
     SET owner_teacher_id=(SELECT ta.teacher_id FROM teacher_assessments ta WHERE ta.assessment_id=assessments.id LIMIT 1)
   WHERE owner_teacher_id IS NULL;
  UPDATE results
     SET attempted=MAX(0,total_questions-unanswered),
         marks_obtained=score,
         total_marks=total_questions
   WHERE total_marks=0;
  INSERT OR IGNORE INTO assessment_students(assessment_id,student_id)
    SELECT a.id,s.id FROM assessments a CROSS JOIN student_accounts s
    WHERE (a.academic_year='ALL' OR upper(a.academic_year)=upper(s.academic_year))
      AND NOT EXISTS(SELECT 1 FROM teacher_assessments ta WHERE ta.assessment_id=a.id);
  INSERT OR IGNORE INTO assessment_students(assessment_id,student_id)
    SELECT ta.assessment_id,s.id
      FROM teacher_assessments ta
      JOIN assessments a ON a.id=ta.assessment_id
      JOIN student_accounts s ON upper(a.academic_year)=upper(s.academic_year)
      LEFT JOIN teacher_subjects ts ON ts.teacher_id=ta.teacher_id
        AND upper(ts.academic_year)=upper(a.academic_year)
        AND lower(ts.subject_name)=lower(a.subject_name)
     WHERE COALESCE(trim(ts.divisions),'')=''
        OR instr(','||replace(upper(ts.divisions),' ','')||',',','||upper(s.division)||',')>0;
  CREATE TABLE IF NOT EXISTS attempt_question_snapshots (
    attempt_id TEXT NOT NULL REFERENCES examination_attempts(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL,
    question_text TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    question_type TEXT NOT NULL DEFAULT 'objective',
    marks REAL NOT NULL DEFAULT 1,
    negative_marks REAL NOT NULL DEFAULT 0,
    correct_option_id INTEGER,
    options_json TEXT NOT NULL DEFAULT '[]',
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (attempt_id,question_id)
  )`);

  const attemptsWithoutSnapshots = await all(
    `SELECT t.id,t.assessment_id FROM examination_attempts t
     WHERE NOT EXISTS(SELECT 1 FROM attempt_question_snapshots s WHERE s.attempt_id=t.id)`
  );
  for (const attempt of attemptsWithoutSnapshots) {
    const questions = await all(
      `SELECT id,question_text,category,question_type,marks,negative_marks,
              correct_option_id,position
       FROM questions WHERE assessment_id=? AND active=1 ORDER BY position,id`,
      [attempt.assessment_id]
    );
    for (const question of questions) {
      const options = await all(
        'SELECT id,option_text,position FROM options WHERE question_id=? ORDER BY position,id',
        [question.id]
      );
      await run(
        `INSERT OR IGNORE INTO attempt_question_snapshots(
           attempt_id,question_id,question_text,category,question_type,marks,
           negative_marks,correct_option_id,options_json,position
         ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          attempt.id, question.id, question.question_text, question.category,
          question.question_type || 'objective', Number(question.marks || 1),
          Number(question.negative_marks || 0), question.correct_option_id,
          JSON.stringify(options), question.position
        ]
      );
    }
  }

  await exec(`CREATE TABLE IF NOT EXISTS student_accounts (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    academic_year TEXT NOT NULL DEFAULT '',
    division TEXT NOT NULL DEFAULT '',
    roll_number TEXT NOT NULL DEFAULT '',
    admission_year TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 1 CHECK(must_change_password IN(0,1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
    profile_photo_data TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    password_changed_at TEXT
  )`);
  await ensureColumn('student_accounts', 'practical_batch', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('student_accounts', 'student_number', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('student_accounts', 'profile_updated_at', 'TEXT');
  await exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_student_accounts_number ON student_accounts(student_number COLLATE NOCASE) WHERE student_number<>''");
  await exec(`CREATE TABLE IF NOT EXISTS student_attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES student_accounts(id) ON DELETE CASCADE,
    attendance_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('present','absent','late')),
    note TEXT NOT NULL DEFAULT '',
    recorded_by_admin_id INTEGER REFERENCES administrators(id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(student_id, attendance_date)
  );
  CREATE INDEX IF NOT EXISTS idx_student_attendance_date ON student_attendance(attendance_date,student_id);
  CREATE TABLE IF NOT EXISTS student_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 1 CHECK(published IN (0,1)),
    created_by_admin_id INTEGER REFERENCES administrators(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_student_notices_published ON student_notices(published,created_at)`);

  await exec(`CREATE TABLE IF NOT EXISTS assessment_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES student_accounts(id),
    assessment_id INTEGER NOT NULL REFERENCES assessments(id),
    attempt_id TEXT NOT NULL UNIQUE REFERENCES examination_attempts(id),
    submitted_at TEXT NOT NULL,
    reset_at TEXT,
    reset_by_admin_id INTEGER REFERENCES administrators(id),
    reset_reason TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_assessment_submissions_student_assessment
    ON assessment_submissions(student_id,assessment_id) WHERE reset_at IS NULL;
  CREATE TABLE IF NOT EXISTS assessment_submission_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES assessment_submissions(id),
    action TEXT NOT NULL CHECK(action='reset'),
    admin_id INTEGER NOT NULL REFERENCES administrators(id),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_assessment_submission_audit
    ON assessment_submission_audit(submission_id,created_at);
  CREATE TRIGGER IF NOT EXISTS trg_audit_assessment_submission_reset
  AFTER UPDATE OF reset_at ON assessment_submissions
  WHEN OLD.reset_at IS NULL AND NEW.reset_at IS NOT NULL AND NEW.reset_by_admin_id IS NOT NULL
  BEGIN
    INSERT INTO assessment_submission_audit(submission_id,action,admin_id,reason)
    VALUES(NEW.id,'reset',NEW.reset_by_admin_id,NEW.reset_reason);
  END;
  INSERT OR IGNORE INTO assessment_submissions(student_id,assessment_id,attempt_id,submitted_at)
    SELECT t.student_id,t.assessment_id,t.id,COALESCE(t.submitted_at,t.created_at)
    FROM examination_attempts t
    WHERE t.student_id IS NOT NULL AND t.status IN ('submitted','expired')
    ORDER BY COALESCE(t.submitted_at,t.created_at),t.id;
  CREATE TRIGGER IF NOT EXISTS trg_register_assessment_submission
  AFTER UPDATE OF status ON examination_attempts
  WHEN OLD.status='in_progress' AND NEW.status IN ('submitted','expired') AND NEW.student_id IS NOT NULL
  BEGIN
    INSERT INTO assessment_submissions(student_id,assessment_id,attempt_id,submitted_at)
    VALUES(NEW.student_id,NEW.assessment_id,NEW.id,COALESCE(NEW.submitted_at,datetime('now')));
  END;`);

  await exec(`CREATE TABLE IF NOT EXISTS academic_marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL CHECK(category IN ('credit','semester')),
    title TEXT NOT NULL,
    subject_name TEXT NOT NULL,
    academic_year TEXT NOT NULL,
    division TEXT NOT NULL DEFAULT '',
    semester TEXT NOT NULL DEFAULT '',
    exam_date TEXT NOT NULL DEFAULT '',
    student_id INTEGER NOT NULL REFERENCES student_accounts(id) ON DELETE CASCADE,
    teacher_id INTEGER NOT NULL REFERENCES teachers(id),
    marks_obtained REAL NOT NULL CHECK(marks_obtained >= 0),
    max_marks REAL NOT NULL CHECK(max_marks > 0 AND marks_obtained <= max_marks),
    published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
    published_at TEXT,
    deleted_at TEXT,
    deleted_by_type TEXT,
    deleted_by_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(category,title,subject_name,semester,student_id)
  );
  CREATE INDEX IF NOT EXISTS idx_academic_marks_student ON academic_marks(student_id,category,published);
  CREATE INDEX IF NOT EXISTS idx_academic_marks_teacher ON academic_marks(teacher_id,category,subject_name);
  CREATE TABLE IF NOT EXISTS academic_marks_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mark_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('created','edited','deleted')),
    actor_type TEXT NOT NULL CHECK(actor_type IN ('teacher','admin')),
    actor_id INTEGER NOT NULL,
    before_json TEXT,
    after_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_academic_marks_audit_mark ON academic_marks_audit(mark_id,created_at);`);
  await ensureColumn('academic_marks', 'deleted_at', 'TEXT');
  await ensureColumn('academic_marks', 'published_at', 'TEXT');
  await ensureColumn('academic_marks', 'deleted_by_type', 'TEXT');
  await ensureColumn('academic_marks', 'deleted_by_id', 'INTEGER');
  await run(
    "UPDATE academic_marks SET published_at=created_at WHERE published=1 AND published_at IS NULL"
  );

}

module.exports = { ensureSchema };
