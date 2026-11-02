const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('CSV student import preserves existing credentials and supports private student login and admin management', () => {
  const temp = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'rcpet-student-management-'));
  require('node:fs').mkdirSync(path.join(temp, 'database'), { recursive: true });
  const csv = path.join(temp, 'students.csv');
  require('node:fs').writeFileSync(csv, [
    'full_name,roll_no,division,practical_batch,email',
    'Existing Student,1,A,A1,existing@test.example',
    'New Student,2,B,B2,new@test.example'
  ].join('\n'));

  const script = `
    const bcrypt=require(${JSON.stringify(path.join(root,'node_modules','bcryptjs'))});
    const {ensureSchema}=require(${JSON.stringify(path.join(root,'backend','database','migrations.js'))});
    const {get,run,db}=require(${JSON.stringify(path.join(root,'backend','database'))});
    const {importStudents}=require(${JSON.stringify(path.join(root,'backend','scripts','importStudents.js'))});
    const request=require(${JSON.stringify(path.join(root,'node_modules','supertest'))});
    (async()=>{
      await ensureSchema();
      const preservedHash=await bcrypt.hash('ChangedExisting234',12);
      await run("INSERT INTO student_accounts(email,student_number,full_name,division,roll_number,practical_batch,password_hash,must_change_password,active,password_changed_at) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))",
        ['existing@test.example','1','Existing Student','A','1','A1',preservedHash,0,0]);
      const imported=await importStudents(${JSON.stringify(csv)});
      const existing=await get("SELECT * FROM student_accounts WHERE email='existing@test.example'");
      if(existing.password_hash!==preservedHash||Number(existing.must_change_password)!==0||Number(existing.active)!==0) throw Error('Existing credentials/status changed during import');
      const created=await get("SELECT * FROM student_accounts WHERE email='new@test.example'");
      const initialPasswordWorks=await bcrypt.compare('Pass@123',created.password_hash);
      if(!initialPasswordWorks||Number(created.must_change_password)!==1||created.student_number!=='2') throw Error('New account was not created with required initial credentials');

      const adminHash=await bcrypt.hash('AdminTestPassword234',12);
      await run("INSERT INTO administrators(username,password_hash,must_change_password) VALUES(?,?,0)",['admin@test.example',adminHash]);
      const otherHash=await bcrypt.hash('OtherStudentPassword234',12);
      await run("INSERT INTO student_accounts(email,student_number,full_name,division,roll_number,practical_batch,password_hash,must_change_password,active) VALUES(?,?,?,?,?,?,?,?,1)",
        ['other@test.example','3','Other Student','A','3','A3',otherHash,0]);
      const app=require(${JSON.stringify(path.join(root,'backend','app.js'))});
      const unauthenticated=await request(app).get('/api/admin/students');
      const admin=request.agent(app);
      const adminLogin=await admin.post('/api/auth/login').send({username:'admin@test.example',password:'AdminTestPassword234'});
      const directory=await admin.get('/api/admin/students?q=new');
      const edit=await admin.patch('/api/admin/students/'+created.id).send({fullName:'New Student Edited',email:'new@test.example',rollNumber:'2',division:'C',practicalBatch:'C2',academicYear:'FY',active:1});

      const student=request.agent(app);
      const invalidUsername=await request(app).post('/api/students/login').send({email:'missing@test.example',password:'WrongPassword234'});
      const invalidPassword=await request(app).post('/api/students/login').send({email:'new@test.example',password:'WrongPassword234'});
      const studentLogin=await student.post('/api/students/login').send({email:'new@test.example',password:'Pass@123'});
      const profile=await student.get('/api/students/me');
      const change=await student.post('/api/students/change-password').send({currentPassword:'Pass@123',newPassword:'StudentChanged234'});
      const photoData='data:image/png;base64,iVBORw0KGgo=';
      const photoUpload=await student.put('/api/students/profile-photo').send({photo:photoData});
      const profileAfterPhotoUpload=await student.get('/api/students/me');
      const attendanceWrite=await admin.post('/api/admin/students/attendance').send({studentId:created.id,date:'2026-10-28',status:'present',note:'Recorded attendance'});
      const noticeWrite=await admin.post('/api/admin/students/notices').send({title:'Academic update',body:'Published portal update',published:1});
      const dashboard=await student.get('/api/students/dashboard');
      const otherStudent=request.agent(app);
      const otherLogin=await otherStudent.post('/api/students/login').send({email:'other@test.example',password:'OtherStudentPassword234'});
      const otherDashboard=await otherStudent.get('/api/students/dashboard');
      const reset=await admin.post('/api/admin/students/'+created.id+'/reset-password').send({});
      const resetStored=await get('SELECT password_hash,must_change_password FROM student_accounts WHERE id=?',[created.id]);
      const resetHashValid=await bcrypt.compare(reset.body.temporaryPassword,resetStored.password_hash);
      const oldSessionBlockedByReset=await student.get('/api/students/dashboard');
      const deactivated=await admin.patch('/api/admin/students/'+created.id).send({active:0});
      const loginAfterDeactivate=await request(app).post('/api/students/login').send({email:'new@test.example',password:reset.body.temporaryPassword});
      const oldSessionBlockedByDeactivation=await student.get('/api/students/dashboard');

      const result={
        imported:imported.summary,
        existingCredentialsPreserved:existing.password_hash===preservedHash&&Number(existing.active)===0,
        newAccountRequiresChange:initialPasswordWorks&&Number(created.must_change_password)===1,
        adminAuthRequired:unauthenticated.status===401&&adminLogin.status===200,
        adminSearchAndEdit:directory.status===200&&directory.body.length===1&&edit.status===200&&edit.body.division==='C',
        studentLoginErrorsAreGeneric:invalidUsername.status===401&&invalidPassword.status===401&&invalidUsername.body.error==='Invalid Credentials'&&invalidPassword.body.error==='Invalid Credentials',
        studentLoginAndOwnProfile:studentLogin.status===200&&studentLogin.body.mustChangePassword&&profile.body.email==='new@test.example',
        profilePhotoPersistsForAuthenticatedStudent:photoUpload.status===200&&profileAfterPhotoUpload.body.profilePhoto===photoData,
        studentPasswordChangeAndDashboard:change.status===200&&dashboard.status===200&&dashboard.body.attendance.summary.present===1&&dashboard.body.attendance.records[0].note==='Recorded attendance'&&dashboard.body.notices.some(item=>item.id===noticeWrite.body.id),
        dashboardRecordsAreStudentScoped:otherLogin.status===200&&otherDashboard.status===200&&otherDashboard.body.attendance.summary.recorded===0&&otherDashboard.body.attendance.records.length===0,
        attendanceAndNoticeRequireAdmin:attendanceWrite.status===200&&noticeWrite.status===201,
        secureAdminReset:reset.status===200&&resetHashValid&&Number(resetStored.must_change_password)===1,
        resetRequiresExistingSessionPasswordChange:oldSessionBlockedByReset.status===403,
        deactivationBlocksLogin:deactivated.status===200&&Number(deactivated.body.active)===0&&loginAfterDeactivate.status===401&&oldSessionBlockedByDeactivation.status===401
      };
      db.close();
      console.log(JSON.stringify(result));
    })().catch(error=>{console.error(error.stack||error);process.exitCode=1;db.close()});
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: temp,
    env: {
      ...process.env,
      DATABASE_FILE: path.join(temp, 'student-management.sqlite'),
      SESSION_SECRET: 'student-management-test-session-secret',
      STUDENT_INITIAL_PASSWORD: 'Pass@123',
      NODE_ENV: 'test'
    },
    encoding: 'utf8',
    timeout: 30000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
  assert.deepEqual(output.imported, { created: 1, updated: 0, unchanged: 1, invalid: 0, duplicate: 0 });
  for (const [check, passed] of Object.entries(output)) {
    if (check !== 'imported') assert.equal(passed, true, `${check} failed`);
  }
});
