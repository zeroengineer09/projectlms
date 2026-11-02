const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('assessment results persist, enforce role boundaries, gate details, and export an XLSX workbook', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpet-assessment-results-'));
  const env = {
    ...process.env,
    DATABASE_FILE: path.join(temp, 'results.sqlite'),
    SESSION_SECRET: 'assessment-results-test-session-secret',
    NODE_ENV: 'test'
  };
  const script = `
    const assert=require('node:assert/strict');
    const bcrypt=require(${JSON.stringify(path.join(root,'node_modules','bcryptjs'))});
    const request=require(${JSON.stringify(path.join(root,'node_modules','supertest'))});
    const JSZip=require(${JSON.stringify(path.join(root,'node_modules','jszip'))});
    const {ensureSchema}=require(${JSON.stringify(path.join(root,'backend','migrations.js'))});
    const {run,get,all,db}=require(${JSON.stringify(path.join(root,'backend','database.js'))});
    const app=require(${JSON.stringify(path.join(root,'backend','app.js'))});
    (async()=>{
      await ensureSchema();
      const studentPassword=await bcrypt.hash('StudentTest123',4);
      const teacherPassword=await bcrypt.hash('TeacherTest123',4);
      const adminPassword=await bcrypt.hash('AdminTestPassword123',4);
      await run("INSERT INTO student_accounts(email,full_name,academic_year,division,roll_number,password_hash,must_change_password) VALUES(?,?,?,?,?,?,0)",['student-a@test.example','Student A','FY','A','101',studentPassword]);
      await run("INSERT INTO student_accounts(email,full_name,academic_year,division,roll_number,password_hash,must_change_password) VALUES(?,?,?,?,?,?,0)",['student-b@test.example','Student B','FY','B','102',studentPassword]);
      await run("INSERT INTO teachers(full_name,email,password_hash,must_change_password,active) VALUES(?,?,?,0,1)",['Teacher A','teacher-a@test.example',teacherPassword]);
      await run("INSERT INTO teachers(full_name,email,password_hash,must_change_password,active) VALUES(?,?,?,0,1)",['Teacher B','teacher-b@test.example',teacherPassword]);
      await run("INSERT INTO administrators(username,password_hash,must_change_password) VALUES(?,?,0)",['owner@test.example',adminPassword]);
      const teachers=await new Promise((resolve,reject)=>db.all('SELECT id,email FROM teachers ORDER BY id',(error,rows)=>error?reject(error):resolve(rows)));
      const students=await new Promise((resolve,reject)=>db.all('SELECT id,email FROM student_accounts ORDER BY id',(error,rows)=>error?reject(error):resolve(rows)));
      await run("INSERT INTO teacher_subjects(teacher_id,subject_name,academic_year,divisions) VALUES(?,?,?,?)",[teachers[0].id,'Web Design-I','FY','A']);
      await run("INSERT INTO teacher_subjects(teacher_id,subject_name,academic_year,divisions) VALUES(?,?,?,?)",[teachers[1].id,'Networking','FY','B']);

      const teacherA=request.agent(app),teacherB=request.agent(app),studentA=request.agent(app),studentB=request.agent(app),admin=request.agent(app);
      assert.equal((await teacherA.post('/api/teachers/login').send({email:teachers[0].email,password:'TeacherTest123'})).status,200);
      assert.equal((await teacherB.post('/api/teachers/login').send({email:teachers[1].email,password:'TeacherTest123'})).status,200);
      assert.equal((await studentA.post('/api/students/login').send({email:students[0].email,password:'StudentTest123'})).status,200);
      assert.equal((await studentB.post('/api/students/login').send({email:students[1].email,password:'StudentTest123'})).status,200);
      assert.equal((await admin.post('/api/auth/login').send({username:'owner@test.example',password:'AdminTestPassword123'})).status,200);

      const create=await teacherA.post('/api/teacher-dashboard/assessments').send({
        subject:'Web Design-I',title:'Result Workflow Test',description:'Integration test',
        academic_year:'FY',duration_minutes:30,passing_percentage:50,max_attempts:1,
        result_release_at:new Date(Date.now()+3600000).toISOString()
      });
      assert.equal(create.status,201,JSON.stringify(create.body));
      const assessmentId=create.body.id;
      assert.equal((await admin.patch('/api/admin/assessments/'+assessmentId).send({enabled:1})).status,200);
      const addQuestion=async payload=>{
        const response=await admin.post('/api/admin/assessments/'+assessmentId+'/questions').send(payload);
        assert.equal(response.status,201,JSON.stringify(response.body));
      };
      await addQuestion({question_text:'Question one',question_type:'objective',marks:2,negative_marks:0,options:['A','B','C','D'],correct_index:1});
      await addQuestion({question_text:'Question two',question_type:'objective',marks:2,negative_marks:0.5,options:['A','B','C','D'],correct_index:0});
      await addQuestion({question_text:'Question three',question_type:'subjective',marks:3});
      await addQuestion({question_text:'Question four',question_type:'objective',marks:1,negative_marks:0,options:['A','B','C','D'],correct_index:0});

      const assessments=await studentA.get('/api/exam/assessments?year=FY');
      assert.equal(assessments.status,200);
      assert.equal(assessments.body.length,1);
      assert.equal((await studentB.get('/api/exam/assessments?year=FY')).body.length,0);
      const createB=await teacherB.post('/api/teacher-dashboard/assessments').send({
        subject:'Networking',title:'Teacher B Private Test',academic_year:'FY',
        duration_minutes:30,passing_percentage:50,max_attempts:1
      });
      assert.equal(createB.status,201,JSON.stringify(createB.body));
      const assessmentB=createB.body.id;
      assert.equal((await admin.patch('/api/admin/assessments/'+assessmentB).send({enabled:1})).status,200);
      const questionB=await admin.post('/api/admin/assessments/'+assessmentB+'/questions').send({
        question_text:'Teacher B question',options:['A','B','C','D'],correct_index:0
      });
      assert.equal(questionB.status,201,JSON.stringify(questionB.body));
      const registration=await studentA.post('/api/exam/register').send({assessmentId});
      assert.equal(registration.status,200,JSON.stringify(registration.body));
      const attemptId=registration.body.attemptId;
      const attempt=await studentA.get('/api/exam/attempt/'+attemptId);
      assert.equal(attempt.status,200);
      const [q1,q2,q3]=attempt.body.questions;
      assert.equal((await studentA.put('/api/exam/attempt/'+attemptId+'/answer').send({questionId:q1.id,optionId:q1.options[1].id})).status,200);
      assert.equal((await studentA.put('/api/exam/attempt/'+attemptId+'/answer').send({questionId:q2.id,optionId:q2.options[1].id})).status,200);
      assert.equal((await studentA.put('/api/exam/attempt/'+attemptId+'/answer').send({questionId:q3.id,textAnswer:'A written response'})).status,200);
      const simultaneousSubmissions=await Promise.all([
        studentA.post('/api/exam/attempt/'+attemptId+'/submit').send({}),
        studentA.post('/api/exam/attempt/'+attemptId+'/submit').send({})
      ]);
      assert.deepEqual(simultaneousSubmissions.map(response=>response.status).sort(),[200,409]);
      const submitted=simultaneousSubmissions.find(response=>response.status===200);
      assert.equal(submitted.body.totalQuestions,4);
      assert.equal(submitted.body.attempted,3);
      assert.equal(submitted.body.unanswered,1);
      assert.equal(submitted.body.correctAnswers,1);
      assert.equal(submitted.body.incorrectAnswers,1);
      assert.equal(submitted.body.pendingManual,1);
      assert.equal(submitted.body.marksObtained,1.5);
      assert.equal(submitted.body.totalMarks,8);
      assert.equal(submitted.body.percentage,18.75);
      assert.equal((await studentA.get('/api/exam/assessments?year=FY')).body.length,0);
      assert.equal((await studentA.get('/api/students/dashboard')).body.assessments.length,0);
      assert.equal((await studentA.post('/api/exam/register').send({assessmentId})).status,403);
      assert.equal((await studentA.get('/api/exam/attempt/'+attemptId)).status,409);
      assert.equal((await studentA.put('/api/exam/attempt/'+attemptId+'/answer').send({questionId:q1.id,optionId:q1.options[1].id})).status,409);
      assert.equal((await studentA.post('/api/exam/attempt/'+attemptId+'/submit').send({})).status,409);
      const competingAttempt='competing-attempt-'+Date.now();
      await run(
        'INSERT INTO examination_attempts(id,assessment_id,candidate_name,candidate_email,candidate_class,candidate_division,student_id,teacher_id,started_at,deadline_at) SELECT ?,assessment_id,candidate_name,candidate_email,candidate_class,candidate_division,student_id,teacher_id,started_at,deadline_at FROM examination_attempts WHERE id=?',
        [competingAttempt,attemptId]
      );
      await assert.rejects(
        run("UPDATE examination_attempts SET status='submitted',submitted_at=datetime('now') WHERE id=?",[competingAttempt]),
        /UNIQUE constraint failed: assessment_submissions.student_id, assessment_submissions.assessment_id/
      );
      await run('DELETE FROM examination_attempts WHERE id=?',[competingAttempt]);
      assert.equal(await get('SELECT COUNT(*) AS count FROM assessment_submissions WHERE student_id=? AND assessment_id=? AND reset_at IS NULL',[students[0].id,assessmentId]).then(row=>row.count),1);
      const questionEdit=await admin.put('/api/admin/questions/'+q1.id).send({
        question_text:'Edited after submission',
        options:['Edited A','Edited B','Edited C','Edited D'],
        correct_index:0
      });
      assert.equal(questionEdit.status,200,JSON.stringify(questionEdit.body));

      const studentRows=await studentA.get('/api/assessment-results/student');
      assert.equal(studentRows.status,200);
      assert.equal(studentRows.body.length,1);
      assert.equal(studentRows.body[0].teacher_name,'Teacher A');
      assert.equal(studentRows.body[0].subject_name,'Web Design-I');
      assert.equal(studentRows.body[0].detailsReleased,false);
      assert.equal((await studentA.get('/api/assessment-results/student/'+attemptId)).status,403);
      assert.equal((await studentB.get('/api/assessment-results/student/'+attemptId)).status,404);

      const teacherRows=await teacherA.get('/api/assessment-results/teacher');
      assert.equal(teacherRows.status,200);
      assert.equal(teacherRows.body.assessments[0].assignedStudents,1);
      assert.equal(teacherRows.body.assessments[0].attemptedStudents,1);
      assert.equal(teacherRows.body.assessments[0].notAttemptedStudents,0);
      assert.equal(teacherRows.body.attempts.length,1);
      assert.equal((await teacherB.get('/api/assessment-results/teacher/'+attemptId)).status,404);
      assert.equal((await teacherB.get('/api/assessment-results/teacher')).body.attempts.length,0);

      const evaluation=await teacherA.post('/api/assessment-results/teacher/'+attemptId+'/evaluate').send({
        evaluations:[{questionId:q3.id,marksAwarded:2.5,feedback:'Good response'}]
      });
      assert.equal(evaluation.status,200,JSON.stringify(evaluation.body));
      assert.equal(evaluation.body.evaluation_status,'complete');
      assert.equal(evaluation.body.marks_obtained,4);
      assert.equal(evaluation.body.percentage,50);
      assert.equal(evaluation.body.passed,1);

      await admin.patch('/api/admin/assessments/'+assessmentId).send({result_release_at:new Date(Date.now()-1000).toISOString()});
      const detail=await studentA.get('/api/assessment-results/student/'+attemptId);
      assert.equal(detail.status,200);
      assert.equal(detail.body.questions.length,4);
      assert.equal(detail.body.questions[0].question,'Question one');
      assert.equal(detail.body.questions[0].selectedAnswer,'B');
      assert.equal(detail.body.questions[0].correctAnswer,'B');
      assert.equal(detail.body.questions[0].status,'correct');
      assert.equal(detail.body.questions[1].status,'incorrect');
      assert.equal(detail.body.questions[2].status,'incorrect');
      assert.equal(detail.body.questions[3].status,'unanswered');
      assert.equal((await studentA.post('/api/exam/attempt/'+attemptId+'/submit').send({})).status,409);

      const studentBAssessments=await studentB.get('/api/exam/assessments?year=FY');
      assert.equal(studentBAssessments.body.length,1);
      const registrationB=await studentB.post('/api/exam/register').send({assessmentId:assessmentB});
      assert.equal(registrationB.status,200,JSON.stringify(registrationB.body));
      const attemptB=registrationB.body.attemptId;
      const examB=await studentB.get('/api/exam/attempt/'+attemptB);
      assert.equal(examB.status,200);
      assert.equal((await studentB.put('/api/exam/attempt/'+attemptB+'/answer').send({
        questionId:examB.body.questions[0].id,optionId:examB.body.questions[0].options[0].id
      })).status,200);
      assert.equal((await studentB.post('/api/exam/attempt/'+attemptB+'/submit').send({})).status,200);

      const adminRows=await admin.get('/api/assessment-results/admin?teacher='+teachers[0].id+'&assessment='+assessmentId);
      assert.equal(adminRows.status,200);
      assert.equal(adminRows.body.length,1);
      const adminRowsB=await admin.get('/api/assessment-results/admin?teacher='+teachers[1].id);
      assert.equal(adminRowsB.body.length,1);
      assert.equal((await admin.get('/api/assessment-results/admin')).body.length,2);
      const adminSummary=await admin.get('/api/assessment-results/admin/summary');
      assert.equal(adminSummary.status,200);
      assert.equal(adminSummary.body.length,2);
      const exportResponse=await admin.get('/api/assessment-results/admin/export.xlsx?teacher='+teachers[0].id+'&assessment='+assessmentId)
        .buffer(true).parse((response,callback)=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>callback(null,Buffer.concat(chunks)))});
      assert.equal(exportResponse.status,200);
      assert.match(exportResponse.headers['content-type'],/spreadsheetml/);
      const workbook=await JSZip.loadAsync(exportResponse.body);
      assert.ok(workbook.file('xl/worksheets/sheet1.xml'));
      assert.ok(workbook.file('xl/worksheets/sheet2.xml'));
      const exportedDetails=await workbook.file('xl/worksheets/sheet2.xml').async('string');
      assert.match(exportedDetails,/Question one/);
      assert.doesNotMatch(exportedDetails,/Edited after submission/);

      await studentA.post('/api/students/logout').send({});
      assert.equal((await studentA.post('/api/students/login').send({email:students[0].email,password:'StudentTest123'})).status,200);
      assert.equal((await studentA.get('/api/assessment-results/student')).body.length,1);
      assert.equal((await studentA.get('/api/students/dashboard')).body.assessments.length,0);
      assert.equal((await teacherA.post('/api/assessment-results/admin/'+attemptId+'/reset').send({reason:'Unauthorized'})).status,401);
      assert.equal((await admin.post('/api/assessment-results/admin/'+attemptId+'/reset').send({reason:'bad'})).status,400);
      const reset=await admin.post('/api/assessment-results/admin/'+attemptId+'/reset').send({reason:'Student experienced a verified technical failure.'});
      assert.equal(reset.status,200,JSON.stringify(reset.body));
      assert.equal(await get('SELECT COUNT(*) AS count FROM assessment_submission_audit WHERE action=?',[ 'reset' ]).then(row=>row.count),1);
      assert.equal((await studentA.get('/api/students/dashboard')).body.assessments.length,1);
      assert.equal((await studentA.post('/api/exam/register').send({assessmentId})).status,200);
      process.stdout.write('Assessment result workflow integration passed.');
    })().catch(error=>{console.error(error);process.exitCode=1});
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8' });
  fs.rmSync(temp, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
