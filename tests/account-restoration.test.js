const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const JSZip = require('jszip');

const root = path.join(__dirname, '..');

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, character => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  })[character]);
}

function columnName(index) {
  let name = '';
  for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}

async function writeWorkbook(file, sheets) {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`);
  sheets.forEach((sheet, index) => {
    const rows = sheet.rows.map((values, rowIndex) => `<row r="${rowIndex + 1}">${values.map((value, columnIndex) => `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`).join('')}</row>`).join('');
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  });
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

test('student, teacher, and owner accounts import idempotently and require first-login changes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpet-account-test-'));
  const databaseDir = path.join(temp, 'database');
  fs.mkdirSync(databaseDir, { recursive: true });
  const workbookPath = path.join(temp, 'accounts.xlsx');
  await writeWorkbook(workbookPath, [
    { name: 'Student Accounts', rows: [
      ['Student ID', 'Student Name', 'Email', 'Class Year', 'Division', 'Roll No'],
      ['TEST-STUDENT-101', 'Temporary Student', 'student@test.example', 'FY', 'A', '101']
    ] },
    { name: 'Teacher Accounts', rows: [
      ['Teacher ID', 'Teacher Name', 'Login Email', 'Department', 'Assigned Subjects', 'Academic Year', 'Initial Password'],
      ['TEST-TEACHER-201', 'Temporary Teacher', 'teacher@test.example', 'Computing', 'Web Design-I', 'FY', 'NeverImportThisSecret123']
    ] }
  ]);

  const env = {
    ...process.env,
    DATABASE_FILE: path.join(temp, 'accounts.sqlite'),
    OWNER_INITIAL_PASSWORD: 'TestOwnerInitial123',
    STUDENT_INITIAL_PASSWORD: 'TestStudentInitial123',
    TEACHER_INITIAL_PASSWORD: 'TestTeacherInitial123',
    SESSION_SECRET: 'account-restoration-test-session-secret',
    NODE_ENV: 'test'
  };
  const script = `
    const bcrypt=require(${JSON.stringify(path.join(root, 'node_modules', 'bcryptjs'))});
    const {ensureSchema}=require(${JSON.stringify(path.join(root, 'backend', 'migrations.js'))});
    const {all,get,run,db}=require(${JSON.stringify(path.join(root, 'backend', 'database.js'))});
    const {importStudents}=require(${JSON.stringify(path.join(root, 'backend', 'importStudents.js'))});
    const {importTeachers}=require(${JSON.stringify(path.join(root, 'backend', 'importTeachers.js'))});
    const {readWorkbookRows}=require(${JSON.stringify(path.join(root, 'backend', 'importUtils.js'))});
    const {initializeOwnerAccount}=require(${JSON.stringify(path.join(root, 'backend', 'ownerAccount.js'))});
    const request=require(${JSON.stringify(path.join(root, 'node_modules', 'supertest'))});
    (async()=>{
      await ensureSchema();
      const studentImport=await importStudents(${JSON.stringify(workbookPath)});
      const teacherImport=await importTeachers(${JSON.stringify(workbookPath)});
      const parsedTeacherRows=await readWorkbookRows(${JSON.stringify(workbookPath)},'Teacher Accounts');
      const ownerFirst=await initializeOwnerAccount();
      const app=require(${JSON.stringify(path.join(root, 'backend', 'app.js'))});
      const studentAgent=request.agent(app),teacherAgent=request.agent(app),adminAgent=request.agent(app);

      const studentLogin=await studentAgent.post('/api/students/login').send({email:'TEST-STUDENT-101',password:process.env.STUDENT_INITIAL_PASSWORD});
      const studentDashboardBefore=await studentAgent.get('/api/students/dashboard');
      const studentChange=await studentAgent.post('/api/students/change-password').send({currentPassword:process.env.STUDENT_INITIAL_PASSWORD,newPassword:'TestStudentChanged234'});
      const studentDashboardAfter=await studentAgent.get('/api/students/dashboard');
      const studentSecondImport=await importStudents(${JSON.stringify(workbookPath)});
      await studentAgent.post('/api/students/logout').send({});
      const studentChangedLogin=await studentAgent.post('/api/students/login').send({email:'student@test.example',password:'TestStudentChanged234'});

      const teacherLogin=await teacherAgent.post('/api/teachers/login').send({email:'TEST-TEACHER-201',password:process.env.TEACHER_INITIAL_PASSWORD});
      const teacherDashboardBefore=await teacherAgent.get('/api/teacher-dashboard/stats');
      const teacherChange=await teacherAgent.post('/api/teachers/change-password').send({currentPassword:process.env.TEACHER_INITIAL_PASSWORD,newPassword:'TestTeacherChanged234'});
      const teacherDashboardAfter=await teacherAgent.get('/api/teacher-dashboard/stats');
      const teacherSecondImport=await importTeachers(${JSON.stringify(workbookPath)});
      await teacherAgent.post('/api/teachers/logout').send({});
      const teacherChangedLogin=await teacherAgent.post('/api/teachers/login').send({email:'teacher@test.example',password:'TestTeacherChanged234'});

      const adminLogin=await adminAgent.post('/api/auth/login').send({username:'kaushalpatil927@gmail.com',password:process.env.OWNER_INITIAL_PASSWORD});
      const unauthenticatedAdminDashboard=await request(app).get('/api/admin/stats');
      const adminDashboardBefore=await adminAgent.get('/api/admin/stats');
      const adminChange=await adminAgent.post('/api/auth/change-password').send({currentPassword:process.env.OWNER_INITIAL_PASSWORD,newPassword:'TestOwnerChanged234'});
      const adminDashboardAfter=await adminAgent.get('/api/admin/stats');
      await adminAgent.post('/api/auth/logout').send({});
      const adminChangedLogin=await adminAgent.post('/api/auth/login').send({username:'kaushalpatil927@gmail.com',password:'TestOwnerChanged234'});

      process.env.OWNER_INITIAL_PASSWORD='OtherTestOwnerPassword456';
      const ownerSecond=await initializeOwnerAccount();
      const owner=await get('SELECT password_hash,must_change_password FROM administrators WHERE lower(username)=lower(?)',['kaushalpatil927@gmail.com']);
      const result={
        studentImport:studentImport.summary,teacherImport:teacherImport.summary,
        studentSecondImport:studentSecondImport.summary,teacherSecondImport:teacherSecondImport.summary,
        passwordCellsExcluded:parsedTeacherRows.every(row=>!row.values.initial_password),
        ownerCreatedOnce:ownerFirst.created&&!ownerSecond.created,
        ownerPasswordPreserved:await bcrypt.compare('TestOwnerChanged234',owner.password_hash),
        ownerChangeRequiredAfterChange:Number(owner.must_change_password)===0,
        studentFirstLogin:studentLogin.status===200&&studentLogin.body.mustChangePassword,
        studentDashboardBlockedBeforeChange:studentDashboardBefore.status===403,
        studentPasswordChange:studentChange.status===200,
        studentDashboardAvailableAfterChange:studentDashboardAfter.status===200,
        studentChangedPasswordLogin:studentChangedLogin.status===200&&!studentChangedLogin.body.mustChangePassword,
        teacherFirstLogin:teacherLogin.status===200&&teacherLogin.body.mustChangePassword,
        teacherDashboardBlockedBeforeChange:teacherDashboardBefore.status===403,
        teacherPasswordChange:teacherChange.status===200,
        teacherDashboardAvailableAfterChange:teacherDashboardAfter.status===200,
        teacherChangedPasswordLogin:teacherChangedLogin.status===200&&!teacherChangedLogin.body.mustChangePassword,
        adminFirstLogin:adminLogin.status===200&&adminLogin.body.mustChangePassword,
        adminLoginResponseContainsNoCredential:!Object.keys(adminLogin.body).some(key=>/password|hash|secret/i.test(key)&&key!=='mustChangePassword'),
        unauthenticatedAdminDenied:unauthenticatedAdminDashboard.status===401,
        adminDashboardBlockedBeforeChange:adminDashboardBefore.status===403,
        adminPasswordChange:adminChange.status===200,
        adminDashboardAvailableAfterChange:adminDashboardAfter.status===200,
        adminChangedPasswordLogin:adminChangedLogin.status===200&&!adminChangedLogin.body.mustChangePassword,
        selfRegistrationDisabled:(await request(app).post('/api/auth/register').send({})).status===404,
        preservedSubject:(await get("SELECT subject_name FROM teacher_subjects ts JOIN teachers t ON t.id=ts.teacher_id WHERE lower(t.email)=lower(?)",['teacher@test.example'])).subject_name
      };
      console.log(JSON.stringify(result));
      db.close();
    })().catch(error=>{console.error(error.message);process.exitCode=1});
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: temp,
    env,
    encoding: 'utf8',
    timeout: 60000
  });
  try {
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout.trim());
    assert.deepEqual(result.studentImport, { created: 1, updated: 0, unchanged: 0, invalid: 0, duplicate: 0 });
    assert.deepEqual(result.teacherImport, {
      created: 1, updated: 0, unchanged: 0, invalid: 0, duplicate: 0,
      missingTeacherId: 0, missingDepartment: 0, missingSubjects: 0, subjectsWithoutAcademicYear: 0
    });
    assert.deepEqual(result.studentSecondImport, { created: 0, updated: 0, unchanged: 1, invalid: 0, duplicate: 0 });
    assert.deepEqual(result.teacherSecondImport, {
      created: 0, updated: 0, unchanged: 1, invalid: 0, duplicate: 0,
      missingTeacherId: 0, missingDepartment: 0, missingSubjects: 0, subjectsWithoutAcademicYear: 0
    });
    for (const [key, value] of Object.entries(result)) {
      if (key.endsWith('Import') || key === 'preservedSubject') continue;
      assert.equal(value, true, `${key} should be true`);
    }
    assert.equal(result.preservedSubject, 'Web Design-I');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
