const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('teachers can edit and soft-delete only their marks; published records and audit history stay consistent', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpet-marks-management-'));
  const env = {
    ...process.env,
    DATABASE_FILE: path.join(temp, 'marks.sqlite'),
    SESSION_SECRET: 'marks-management-test-session-secret',
    NODE_ENV: 'test'
  };
  const script = `
    const assert=require('node:assert/strict');
    const bcrypt=require(${JSON.stringify(path.join(root,'node_modules','bcryptjs'))});
    const request=require(${JSON.stringify(path.join(root,'node_modules','supertest'))});
    const {ensureSchema}=require(${JSON.stringify(path.join(root,'backend','migrations.js'))});
    const {run,all}=require(${JSON.stringify(path.join(root,'backend','database.js'))});
    const app=require(${JSON.stringify(path.join(root,'backend','app.js'))});
    (async()=>{
      await ensureSchema();
      const password=await bcrypt.hash('MarksTestPassword123',4);
      const adminPassword=await bcrypt.hash('AdminTestPassword123',4);
      await run("INSERT INTO student_accounts(email,full_name,academic_year,division,roll_number,password_hash,must_change_password) VALUES(?,?,?,?,?,?,0)",['marks-student-a@test.example','Marks Student A','FY','A','201',password]);
      await run("INSERT INTO student_accounts(email,full_name,academic_year,division,roll_number,password_hash,must_change_password) VALUES(?,?,?,?,?,?,0)",['marks-student-b@test.example','Marks Student B','FY','B','202',password]);
      await run("INSERT INTO teachers(full_name,email,password_hash,must_change_password,active) VALUES(?,?,?,0,1)",['Marks Teacher A','marks-teacher-a@test.example',password]);
      await run("INSERT INTO teachers(full_name,email,password_hash,must_change_password,active) VALUES(?,?,?,0,1)",['Marks Teacher B','marks-teacher-b@test.example',password]);
      await run("INSERT INTO administrators(username,password_hash,must_change_password) VALUES(?,?,0)",['marks-admin@test.example',adminPassword]);
      const teachers=await all("SELECT id,email FROM teachers ORDER BY id");
      const students=await all("SELECT id,email FROM student_accounts ORDER BY id");
      await run("INSERT INTO teacher_subjects(teacher_id,subject_name,academic_year,divisions) VALUES(?,?,?,?)",[teachers[0].id,'Programming','FY','A']);
      await run("INSERT INTO teacher_subjects(teacher_id,subject_name,academic_year,divisions) VALUES(?,?,?,?)",[teachers[1].id,'Networking','FY','B']);
      const teacher=request.agent(app),otherTeacher=request.agent(app),student=request.agent(app),otherStudent=request.agent(app),admin=request.agent(app);
      assert.equal((await teacher.post('/api/teachers/login').send({email:teachers[0].email,password:'MarksTestPassword123'})).status,200);
      assert.equal((await otherTeacher.post('/api/teachers/login').send({email:teachers[1].email,password:'MarksTestPassword123'})).status,200);
      assert.equal((await student.post('/api/students/login').send({email:students[0].email,password:'MarksTestPassword123'})).status,200);
      assert.equal((await otherStudent.post('/api/students/login').send({email:students[1].email,password:'MarksTestPassword123'})).status,200);
      assert.equal((await admin.post('/api/auth/login').send({username:'marks-admin@test.example',password:'AdminTestPassword123'})).status,200);

      const data={category:'credit',title:'Credit Test 1',subject_name:'Programming',academic_year:'FY',division:'A',exam_date:'2026-10-25',student_id:students[0].id,marks_obtained:14,max_marks:20,published:true};
      const created=await teacher.post('/api/marks/teacher').send(data);
      assert.equal(created.status,201,JSON.stringify(created.body));
      const [record]=await teacher.get('/api/marks/teacher').then(response=>response.body);
      assert.ok(record.id);
      const publishedResult=(await student.get('/api/marks/student/credit')).body[0];
      assert.equal(publishedResult.marks_obtained,14);
      assert.ok(publishedResult.publication_date);
      assert.equal((await otherStudent.get('/api/marks/student/credit')).body.length,0);

      assert.equal((await teacher.patch('/api/marks/teacher/'+record.id).send({...data,marks_obtained:18})).status,200);
      const editedResult=(await student.get('/api/marks/student/credit')).body[0];
      assert.equal(editedResult.marks_obtained,18);
      assert.ok(editedResult.publication_date);
      assert.equal((await teacher.patch('/api/marks/teacher/'+record.id).send({...data,marks_obtained:21})).status,400);
      assert.equal((await otherTeacher.patch('/api/marks/teacher/'+record.id).send({...data,marks_obtained:19})).status,404);
      assert.equal((await otherTeacher.delete('/api/marks/teacher/'+record.id)).status,404);
      assert.equal((await student.delete('/api/marks/teacher/'+record.id)).status,401);
      assert.equal((await admin.get('/api/marks/admin')).body.length,1);
      assert.equal((await admin.patch('/api/marks/admin/'+record.id).send({...data,marks_obtained:17})).status,200);
      assert.equal((await student.get('/api/marks/student/credit')).body[0].marks_obtained,17);

      const unrelated=await teacher.post('/api/marks/teacher').send({...data,title:'Credit Test 2',marks_obtained:10});
      assert.equal(unrelated.status,201,JSON.stringify(unrelated.body));
      const deleted=await teacher.delete('/api/marks/teacher/'+record.id);
      assert.equal(deleted.status,200);
      assert.equal((await student.get('/api/marks/student/credit')).body.length,1);
      const adminRows=await admin.get('/api/marks/admin');
      assert.equal(adminRows.body.length,2);
      assert.ok(adminRows.body.find(row=>row.id===record.id).deleted_at);
      const history=await admin.get('/api/marks/admin/'+record.id+'/audit');
      assert.deepEqual(history.body.map(row=>row.action),['deleted','edited','edited','created']);
      assert.ok(history.body.every(row=>row.actor_id>0&&row.actor_type));
    })().catch(error=>{console.error(error);process.exitCode=1});
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8' });
  fs.rmSync(temp, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
