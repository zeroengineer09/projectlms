require('dotenv').config();
const bcrypt = require('bcryptjs');
const { ensureSchema } = require('./migrations');
const { get, run } = require('./database');
const { applyInitialPassword, firstValue, readWorkbookRows, validEmail } = require('./importUtils');

function normalizeYear(value) {
  const year = String(value || '').trim().toUpperCase().replace(/^BCA\s*/, '');
  if (/^(FY|FIRST(?:\s+YEAR)?|1(?:ST)?(?:\s+YEAR)?)$/.test(year)) return 'FY';
  if (/^(SY|SECOND(?:\s+YEAR)?|2(?:ND)?(?:\s+YEAR)?)$/.test(year)) return 'SY';
  if (/^(TY|THIRD(?:\s+YEAR)?|3(?:RD)?(?:\s+YEAR)?)$/.test(year)) return 'TY';
  return year;
}

function splitSubjects(value) {
  return [...new Set(String(value || '').split(/[;|\n]+/).map(subject => subject.trim()).filter(Boolean))];
}

async function importTeachers(file) {
  const initialPassword = process.env.TEACHER_INITIAL_PASSWORD;
  if (!initialPassword || initialPassword.length < 8 || !/[a-z]/.test(initialPassword) || !/[A-Z]/.test(initialPassword) || !/[0-9]/.test(initialPassword)) {
    throw new Error('Set a strong TEACHER_INITIAL_PASSWORD (8+ characters with uppercase, lowercase, and digits) in the protected environment before importing teachers.');
  }
  await ensureSchema();
  const records = await readWorkbookRows(file, 'Teacher Accounts');
  const seenEmails = new Set();
  const seenNumbers = new Set();
  const errors = [];
  const summary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    invalid: 0,
    duplicate: 0,
    missingTeacherId: 0,
    missingDepartment: 0,
    missingSubjects: 0,
    subjectsWithoutAcademicYear: 0
  };

  for (const { rowNumber, values } of records) {
    const name = firstValue(values, ['teacher_name', 'full_name', 'name']);
    const email = firstValue(values, ['login_email', 'email', 'email_id', 'teacher_email']);
    const teacherNumber = firstValue(values, ['teacher_id', 'teacher_number', 'teacher_no', 'employee_id', 'employee_number', 'staff_id', 'id']);
    const department = firstValue(values, ['department', 'department_name', 'faculty']);
    const subjects = splitSubjects(firstValue(values, ['assigned_subjects', 'subjects', 'subject']));
    const academicYear = normalizeYear(firstValue(values, ['academic_year', 'class_year', 'year']));
    const divisions = firstValue(values, ['divisions', 'division', 'sections']).toUpperCase();
    if (!teacherNumber) summary.missingTeacherId += 1;
    if (!department) summary.missingDepartment += 1;
    if (!subjects.length) summary.missingSubjects += 1;

    const missing = [];
    if (!name) missing.push('name');
    if (!validEmail(email)) missing.push('valid email');
    if (missing.length) {
      summary.invalid += 1;
      errors.push(`row ${rowNumber}: missing or invalid ${missing.join(' and ')}`);
      continue;
    }

    const normalizedEmail = email.toLowerCase();
    const normalizedNumber = teacherNumber.toLowerCase();
    if (seenEmails.has(normalizedEmail) || (normalizedNumber && seenNumbers.has(normalizedNumber))) {
      summary.duplicate += 1;
      errors.push(`row ${rowNumber}: duplicate email or teacher ID`);
      continue;
    }
    seenEmails.add(normalizedEmail);
    if (normalizedNumber) seenNumbers.add(normalizedNumber);

    const currentByEmail = await get('SELECT * FROM teachers WHERE lower(email)=lower(?)', [email]);
    const currentByNumber = normalizedNumber
      ? await get('SELECT * FROM teachers WHERE lower(teacher_number)=lower(?)', [teacherNumber])
      : null;
    if (currentByEmail && currentByNumber && currentByEmail.id !== currentByNumber.id) {
      summary.invalid += 1;
      errors.push(`row ${rowNumber}: email and teacher ID belong to different accounts`);
      continue;
    }
    const current = currentByEmail || currentByNumber;

    if (!current) {
      const passwordHash = await bcrypt.hash(initialPassword, 12);
      try {
        const inserted = await run(
          `INSERT INTO teachers(full_name,email,teacher_number,department,password_hash,must_change_password,active)
           VALUES(?,?,?,?,?,1,1)`,
          [name, email, teacherNumber, department, passwordHash]
        );
        summary.created += 1;
        if (subjects.length && academicYear && ['FY', 'SY', 'TY'].includes(academicYear)) {
          for (const subject of subjects) {
            await run(
              'INSERT OR IGNORE INTO teacher_subjects(teacher_id,subject_name,academic_year,divisions) VALUES(?,?,?,?)',
              [inserted.lastID, subject, academicYear, divisions]
            );
          }
        } else if (subjects.length) {
          summary.subjectsWithoutAcademicYear += 1;
        }
      } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT') {
          summary.invalid += 1;
          errors.push(`row ${rowNumber}: duplicate email or teacher ID in database`);
          continue;
        }
        throw error;
      }
      continue;
    }

    const passwordHash = await applyInitialPassword(current, initialPassword, bcrypt);
    const updates = {
      full_name: name,
      email,
      teacher_number: teacherNumber || current.teacher_number,
      department: department || current.department,
      password_hash: passwordHash || current.password_hash,
      must_change_password: passwordHash ? 1 : Number(current.must_change_password),
      password_changed_at: passwordHash ? null : current.password_changed_at,
      active: 1
    };
    if (updates.teacher_number && updates.teacher_number !== current.teacher_number) {
      const conflict = await get('SELECT id FROM teachers WHERE lower(teacher_number)=lower(?) AND id<>?', [updates.teacher_number, current.id]);
      if (conflict) {
        summary.invalid += 1;
        errors.push(`row ${rowNumber}: teacher ID is already assigned to another account`);
        continue;
      }
    }
    const changed = Object.entries(updates).some(([key, value]) => value !== current[key]);
    if (changed) {
      await run(
        'UPDATE teachers SET full_name=?,email=?,teacher_number=?,department=?,password_hash=?,must_change_password=?,password_changed_at=?,active=? WHERE id=?',
        [updates.full_name, updates.email, updates.teacher_number, updates.department, updates.password_hash, updates.must_change_password, updates.password_changed_at, updates.active, current.id]
      );
      summary.updated += 1;
    } else {
      summary.unchanged += 1;
    }
    if (subjects.length && academicYear && ['FY', 'SY', 'TY'].includes(academicYear)) {
      for (const subject of subjects) {
        await run(
          'INSERT OR IGNORE INTO teacher_subjects(teacher_id,subject_name,academic_year,divisions) VALUES(?,?,?,?)',
          [current.id, subject, academicYear, divisions]
        );
      }
    } else if (subjects.length) {
      summary.subjectsWithoutAcademicYear += 1;
    }
  }

  return { summary, errors, records: records.length };
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run import-teachers -- path\\to\\teacher-directory.xlsx');
  const result = await importTeachers(file);
  const { created, updated, unchanged, invalid, duplicate, missingTeacherId, missingDepartment, missingSubjects, subjectsWithoutAcademicYear } = result.summary;
  console.log(`Teacher roster import complete. Records: ${result.records}; created: ${created}; updated: ${updated}; unchanged: ${unchanged}; invalid: ${invalid}; duplicates: ${duplicate}.`);
  console.log(`Source fields unavailable: teacher ID ${missingTeacherId}; department ${missingDepartment}; assigned subjects ${missingSubjects}; subject year needed for ${subjectsWithoutAcademicYear} row(s).`);
  if (result.errors.length) console.log(`Rows requiring review: ${result.errors.join('; ')}.`);
  console.log('Initial passwords are stored as bcrypt hashes; existing changed passwords are preserved.');
}

if (require.main === module) {
  main().catch(error => {
    console.error('Teacher import failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { importTeachers, normalizeYear, splitSubjects };
