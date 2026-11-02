PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS administrators (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN(0,1)), created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS assessments (id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', subject_name TEXT NOT NULL DEFAULT '', academic_year TEXT NOT NULL DEFAULT 'ALL' CHECK(academic_year IN('FY','SY','TY','ALL')), duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK(duration_minutes>0), passing_percentage REAL NOT NULL DEFAULT 60 CHECK(passing_percentage BETWEEN 0 AND 100), max_attempts INTEGER NOT NULL DEFAULT 1 CHECK(max_attempts>0), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)), auto_submit_tab_switch INTEGER NOT NULL DEFAULT 1, auto_submit_fullscreen_exit INTEGER NOT NULL DEFAULT 1, maximum_warnings INTEGER NOT NULL DEFAULT 0, result_release_at TEXT, owner_teacher_id INTEGER REFERENCES teachers(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY, assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE, question_text TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General', question_type TEXT NOT NULL DEFAULT 'objective' CHECK(question_type IN('objective','subjective')), marks REAL NOT NULL DEFAULT 1 CHECK(marks>0), negative_marks REAL NOT NULL DEFAULT 0 CHECK(negative_marks>=0), correct_option_id INTEGER, position INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS options (id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE, option_text TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS examination_attempts (id TEXT PRIMARY KEY, assessment_id INTEGER NOT NULL REFERENCES assessments(id), candidate_name TEXT NOT NULL, candidate_email TEXT NOT NULL DEFAULT '', candidate_class TEXT NOT NULL DEFAULT '', candidate_division TEXT NOT NULL DEFAULT '', student_id INTEGER REFERENCES student_accounts(id), teacher_id INTEGER REFERENCES teachers(id), started_at TEXT NOT NULL, deadline_at TEXT NOT NULL, submitted_at TEXT, status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN('in_progress','submitted','expired')), warnings INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_attempt_email_assessment ON examination_attempts(candidate_email, assessment_id);
CREATE INDEX IF NOT EXISTS idx_attempt_status ON examination_attempts(status);
CREATE TABLE IF NOT EXISTS submitted_answers (id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES examination_attempts(id) ON DELETE CASCADE, question_id INTEGER NOT NULL REFERENCES questions(id), option_id INTEGER REFERENCES options(id), text_answer TEXT NOT NULL DEFAULT '', marks_awarded REAL, manual_feedback TEXT NOT NULL DEFAULT '', evaluated_at TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(attempt_id, question_id));
CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES examination_attempts(id), total_questions INTEGER NOT NULL, correct_answers INTEGER NOT NULL, incorrect_answers INTEGER NOT NULL, unanswered INTEGER NOT NULL, score INTEGER NOT NULL, percentage REAL NOT NULL, passed INTEGER NOT NULL CHECK(passed IN(0,1)), completed_at TEXT NOT NULL, attempted INTEGER NOT NULL DEFAULT 0, marks_obtained REAL NOT NULL DEFAULT 0, total_marks REAL NOT NULL DEFAULT 0, pending_manual INTEGER NOT NULL DEFAULT 0, evaluation_status TEXT NOT NULL DEFAULT 'complete');
CREATE TABLE IF NOT EXISTS assessment_students (assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE, student_id INTEGER NOT NULL REFERENCES student_accounts(id) ON DELETE CASCADE, assigned_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(assessment_id, student_id));
CREATE TABLE IF NOT EXISTS attempt_question_snapshots (attempt_id TEXT NOT NULL REFERENCES examination_attempts(id) ON DELETE CASCADE, question_id INTEGER NOT NULL, question_text TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General', question_type TEXT NOT NULL DEFAULT 'objective', marks REAL NOT NULL DEFAULT 1, negative_marks REAL NOT NULL DEFAULT 0, correct_option_id INTEGER, options_json TEXT NOT NULL DEFAULT '[]', position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (attempt_id,question_id));
CREATE TABLE IF NOT EXISTS violation_logs (id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES examination_attempts(id) ON DELETE CASCADE, violation_type TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS teachers (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1 CHECK(must_change_password IN(0,1)), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), created_at TEXT NOT NULL DEFAULT (datetime('now')), password_changed_at TEXT);

CREATE TABLE IF NOT EXISTS student_accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  academic_year TEXT NOT NULL DEFAULT '',
  division TEXT NOT NULL DEFAULT '',
  roll_number TEXT NOT NULL DEFAULT '',
  admission_year TEXT NOT NULL DEFAULT '',
  practical_batch TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK(must_change_password IN(0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
  profile_photo_data TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  password_changed_at TEXT
);
CREATE TABLE IF NOT EXISTS student_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES student_accounts(id) ON DELETE CASCADE,
  attendance_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present','absent','late')),
  note TEXT NOT NULL DEFAULT '',
  recorded_by_admin_id INTEGER REFERENCES administrators(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, attendance_date)
);
CREATE INDEX IF NOT EXISTS idx_student_attendance_date ON student_attendance(attendance_date, student_id);
CREATE TABLE IF NOT EXISTS student_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 1 CHECK(published IN (0,1)),
  created_by_admin_id INTEGER REFERENCES administrators(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_student_notices_published ON student_notices(published, created_at);

CREATE TABLE IF NOT EXISTS assessment_submissions (
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
CREATE TRIGGER IF NOT EXISTS trg_register_assessment_submission
AFTER UPDATE OF status ON examination_attempts
WHEN OLD.status='in_progress' AND NEW.status IN ('submitted','expired') AND NEW.student_id IS NOT NULL
BEGIN
  INSERT INTO assessment_submissions(student_id,assessment_id,attempt_id,submitted_at)
  VALUES(NEW.student_id,NEW.assessment_id,NEW.id,COALESCE(NEW.submitted_at,datetime('now')));
END;

CREATE TABLE IF NOT EXISTS academic_marks (
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by_type TEXT,
  deleted_by_id INTEGER,
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
CREATE INDEX IF NOT EXISTS idx_academic_marks_audit_mark ON academic_marks_audit(mark_id,created_at);
