const fs = require('fs');
const path = require('path');
const { exec, all, run, get } = require('./database');

async function ensureColumn(table, column, definition) {
  const columns = await all(`PRAGMA table_info(${table})`);
  if (!columns.some((c) => c.name === column)) {
    await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function ensureSchema() {
  const schemaPath = path.resolve(__dirname, '../database/schema.sql');
  await exec(fs.readFileSync(schemaPath, 'utf8'));

  // Backward-compatible migrations for databases created by earlier versions.
  await ensureColumn('administrators', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('assessments', 'academic_year', "TEXT NOT NULL DEFAULT 'ALL'");
  await ensureColumn('examination_attempts', 'candidate_class', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('examination_attempts', 'candidate_division', "TEXT NOT NULL DEFAULT ''");
  await exec("CREATE TABLE IF NOT EXISTS teachers (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1 CHECK(must_change_password IN(0,1)), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), created_at TEXT NOT NULL DEFAULT (datetime('now')), password_changed_at TEXT)");

  await exec(`CREATE TABLE IF NOT EXISTS teacher_subjects (id INTEGER PRIMARY KEY, teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, subject_name TEXT NOT NULL, academic_year TEXT NOT NULL DEFAULT 'FY', divisions TEXT NOT NULL DEFAULT 'A,B,C,D', UNIQUE(teacher_id, subject_name, academic_year));
  CREATE TABLE IF NOT EXISTS teacher_assessments (teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE, PRIMARY KEY(teacher_id, assessment_id));`);
  await ensureColumn('assessments', 'owner_teacher_id', 'INTEGER REFERENCES teachers(id)');

  // Only known current assessments are assigned to FY; preserve other assignments.
  await run("UPDATE assessments SET academic_year='FY' WHERE lower(trim(title)) IN ('introduction to web design','office management tool')");
}

module.exports = { ensureSchema };
