require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { ensureSchema } = require('./migrations');
const { all, get, run } = require('./database');
const { firstValue, readWorkbookRows, validEmail } = require('./importUtils');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  row.push(cell);
  if (row.some(value => value.trim())) rows.push(row);
  if (!rows.length) return [];

  const headers = rows.shift().map(header => header.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  return rows.map((values, index) => ({
    rowNumber: index + 2,
    values: Object.fromEntries(headers.map((header, column) => [header, String(values[column] || '').trim()]))
  }));
}

async function readStudentRows(file) {
  if (path.extname(file).toLowerCase() === '.csv') {
    return parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  }
  if (path.extname(file).toLowerCase() === '.xlsx') {
    return readWorkbookRows(file);
  }
  throw new Error('Student roster must be a .xlsx or .csv file.');
}

function normalizeYear(value) {
  const year = String(value || '').trim().toUpperCase().replace(/^BCA[\s-]*/, '').replace(/^[\s-]+/, '');
  if (/^(FY|FIRST(?:\s+YEAR)?|1(?:ST)?(?:\s+YEAR)?)$/.test(year)) return 'FY';
  if (/^(SY|SECOND(?:\s+YEAR)?|2(?:ND)?(?:\s+YEAR)?)$/.test(year)) return 'SY';
  if (/^(TY|THIRD(?:\s+YEAR)?|3(?:RD)?(?:\s+YEAR)?)$/.test(year)) return 'TY';
  return year;
}

async function importStudents(file) {
  const initialPassword = process.env.STUDENT_INITIAL_PASSWORD;
  if (!initialPassword || initialPassword.length < 8 || !/[a-z]/.test(initialPassword) || !/[A-Z]/.test(initialPassword) || !/[0-9]/.test(initialPassword)) {
    throw new Error('Set a strong STUDENT_INITIAL_PASSWORD (8+ characters with uppercase, lowercase, and digits) in the protected environment before importing students.');
  }
  await ensureSchema();
  const records = await readStudentRows(file);
  const seenEmails = new Set();
  const seenNumbers = new Set();
  const errors = [];
  const summary = { created: 0, updated: 0, unchanged: 0, invalid: 0, duplicate: 0 };

  for (const { rowNumber, values } of records) {
    const email = firstValue(values, ['email', 'email_id', 'student_email', 'registered_email']);
    const name = firstValue(values, ['full_name', 'student_name', 'name', 'student_full_name']);
    const roll = firstValue(values, ['roll_number', 'roll_no', 'roll', 'rollno', 'roll_num']);
    const studentNumber = firstValue(values, ['student_id', 'student_number', 'student_no', 'enrollment_number', 'enrollment_no', 'admission_number', 'admission_no', 'registration_number', 'registration_no', 'id']) || roll;
    const normalizedEmail = email.toLowerCase();
    const normalizedNumber = studentNumber.toLowerCase();
    const missing = [];
    if (!name) missing.push('name');
    if (!validEmail(email)) missing.push('registered email');
    if (missing.length) {
      summary.invalid += 1;
      errors.push(`row ${rowNumber}: missing or invalid ${missing.join(' and ')}`);
      continue;
    }
    if (seenEmails.has(normalizedEmail) || (normalizedNumber && seenNumbers.has(normalizedNumber))) {
      summary.duplicate += 1;
      errors.push(`row ${rowNumber}: duplicate email or student ID`);
      continue;
    }
    seenEmails.add(normalizedEmail);
    if (normalizedNumber) seenNumbers.add(normalizedNumber);

    const currentByEmail = await get('SELECT * FROM student_accounts WHERE lower(email)=lower(?)', [email]);
    const numberMatches = normalizedNumber
      ? await all(
        'SELECT * FROM student_accounts WHERE lower(student_number)=lower(?) OR lower(roll_number)=lower(?) ORDER BY id LIMIT 2',
        [studentNumber, studentNumber]
      )
      : [];
    if (numberMatches.length > 1) {
      summary.invalid += 1;
      errors.push(`row ${rowNumber}: roll number matches multiple existing accounts`);
      continue;
    }
    const currentByNumber = numberMatches[0] || null;
    if (currentByEmail && currentByNumber && currentByEmail.id !== currentByNumber.id) {
      summary.invalid += 1;
      errors.push(`row ${rowNumber}: email and student ID belong to different accounts`);
      continue;
    }
    const current = currentByEmail || currentByNumber;
    const year = normalizeYear(firstValue(values, ['academic_year', 'class_year', 'class', 'year', 'course_year']));
    const division = firstValue(values, ['division', 'div', 'section']).toUpperCase();
    const admission = firstValue(values, ['admission_year', 'admissionyear', 'year_of_admission']);
    const practicalBatch = firstValue(values, ['practical_batch', 'practicalbatch', 'batch']);

    if (!current) {
      const passwordHash = await bcrypt.hash(initialPassword, 12);
      try {
        await run(
          `INSERT INTO student_accounts
            (email,student_number,full_name,academic_year,division,roll_number,admission_year,practical_batch,password_hash,must_change_password,active)
            VALUES(?,?,?,?,?,?,?,?,?,1,1)`,
          [email, studentNumber, name, year, division, roll, admission, practicalBatch, passwordHash]
        );
        summary.created += 1;
      } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT') {
          summary.invalid += 1;
          errors.push(`row ${rowNumber}: duplicate email or student ID in database`);
          continue;
        }
        throw error;
      }
      continue;
    }

    const updates = {
      email,
      student_number: studentNumber || current.student_number,
      full_name: name,
      academic_year: year || current.academic_year,
      division: division || current.division,
      roll_number: roll || current.roll_number,
      admission_year: admission || current.admission_year,
      practical_batch: practicalBatch || current.practical_batch,
      password_hash: current.password_hash,
      must_change_password: Number(current.must_change_password),
      password_changed_at: current.password_changed_at,
      active: Number(current.active)
    };
    if (updates.student_number && updates.student_number !== current.student_number) {
      const conflict = await get('SELECT id FROM student_accounts WHERE lower(student_number)=lower(?) AND id<>?', [updates.student_number, current.id]);
      if (conflict) {
        summary.invalid += 1;
        errors.push(`row ${rowNumber}: student ID is already assigned to another account`);
        continue;
      }
    }
    const changed = Object.entries(updates).some(([key, value]) => value !== current[key]);
    if (!changed) {
      summary.unchanged += 1;
      continue;
    }
    if (current.email.toLowerCase() !== email.toLowerCase()) {
      await run('UPDATE examination_attempts SET candidate_email=? WHERE lower(candidate_email)=lower(?)', [email, current.email]);
    }
    await run(
      `UPDATE student_accounts SET email=?,student_number=?,full_name=?,academic_year=?,division=?,roll_number=?,admission_year=?,practical_batch=?,password_hash=?,must_change_password=?,password_changed_at=?,active=? WHERE id=?`,
      [updates.email, updates.student_number, updates.full_name, updates.academic_year, updates.division, updates.roll_number, updates.admission_year, updates.practical_batch, updates.password_hash, updates.must_change_password, updates.password_changed_at, updates.active, current.id]
    );
    summary.updated += 1;
  }

  return { summary, errors, records: records.length };
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run import-students -- path\\to\\student-roster.xlsx');
  const result = await importStudents(file);
  const { created, updated, unchanged, invalid, duplicate } = result.summary;
  console.log(`Student roster import complete. Records: ${result.records}; created: ${created}; updated: ${updated}; unchanged: ${unchanged}; invalid: ${invalid}; duplicates: ${duplicate}.`);
  if (result.errors.length) console.log(`Rows requiring review: ${result.errors.join('; ')}.`);
  console.log('New accounts use a bcrypt-hashed initial password and must change it at first login. Existing credentials and account status are preserved.');
}

if (require.main === module) {
  main().catch(error => {
    console.error('Student import failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { importStudents, normalizeYear, parseCsv, readStudentRows };
