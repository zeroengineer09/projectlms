const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('password recovery supports all roles, expiry, attempt limits, cooldown and SMTP failures', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpet-password-reset-'));
  const script = `
    const assert=require('node:assert/strict');
    const express=require(${JSON.stringify(path.join(root,'node_modules','express'))});
    const session=require(${JSON.stringify(path.join(root,'node_modules','express-session'))});
    const request=require(${JSON.stringify(path.join(root,'node_modules','supertest'))});
    const bcrypt=require(${JSON.stringify(path.join(root,'node_modules','bcryptjs'))});
    const {ensureSchema}=require(${JSON.stringify(path.join(root,'backend','migrations.js'))});
    const database=require(${JSON.stringify(path.join(root,'backend','database.js'))});
    const createPasswordResetRouter=require(${JSON.stringify(path.join(root,'backend','passwordReset.js'))}).createPasswordResetRouter;
    const noopLimiter=(req,res,next)=>next();
    const sent=[];
    let failDelivery=false;
    const transportFactory=()=>({
      async sendMail(message){sent.push(message);if(failDelivery)throw new Error('test SMTP connection failure');return {accepted:[message.to]}},
      close(){}
    });
    const app=express();
    app.use(express.json());
    app.use(session({secret:process.env.SESSION_SECRET,resave:false,saveUninitialized:false}));
    app.use('/api/password-reset',createPasswordResetRouter({
      ...database,transportFactory,rateLimitMiddleware:noopLimiter,verificationRateLimitMiddleware:noopLimiter
    }));
    app.use('/api/auth',require(${JSON.stringify(path.join(root,'backend','auth.js'))}));
    app.use('/api/students',require(${JSON.stringify(path.join(root,'backend','studentAuth.js'))}));
    app.use('/api/teachers',require(${JSON.stringify(path.join(root,'backend','teacherAuth.js'))}));

    const codeFromMail=message=>message.html.match(/font-size:32px[^>]*>(\\d{6})</)?.[1];
    const post=(path,payload)=>request(app).post(path).send(payload);
    const send=(role,email,payload={})=>post('/api/password-reset/'+role+'/request',{email,...payload});
    const verify=(role,email,otp,payload={})=>post('/api/password-reset/'+role+'/verify',{email,otp,...payload});
    const reset=(role,email,otp,newPassword,payload={})=>post('/api/password-reset/'+role+'/reset',{email,otp,newPassword,...payload});
    const codeFor=email=>codeFromMail([...sent].reverse().find(message=>message.to===email));

    (async()=>{
      await database.run("CREATE TABLE password_reset_otps(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,account_type TEXT NOT NULL CHECK(account_type IN ('student','teacher')),otp_hash TEXT NOT NULL,expires_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT(datetime('now')))");
      await database.run("INSERT INTO password_reset_otps(email,account_type,otp_hash,expires_at) VALUES('legacy@test.example','student','legacy-hash',datetime('now','+10 minutes'))");
      await ensureSchema();
      const schema=await database.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='password_reset_otps'");
      assert.match(schema.sql,/'admin'/);
      assert.match(schema.sql,/last_sent_at/);
      assert.equal(await database.get("SELECT id FROM password_reset_otps WHERE email='legacy@test.example'"),undefined);

      const oldHash=await bcrypt.hash('InitialPassword123',4);
      await database.run("INSERT INTO student_accounts(email,full_name,password_hash) VALUES(?,?,?)",['student@test.example','Test Student',oldHash]);
      await database.run("INSERT INTO teachers(full_name,email,password_hash) VALUES(?,?,?)",['Test Teacher','teacher@test.example',oldHash]);
      await database.run("INSERT INTO teachers(full_name,email,password_hash) VALUES(?,?,?)",['SMTP Failure','smtp-failure@test.example',oldHash]);
      await database.run("INSERT INTO administrators(username,password_hash) VALUES(?,?)",['kaushalpatil927@gmail.com',oldHash]);
      await database.run("INSERT INTO administrators(username,password_hash) VALUES(?,?)",['luckykalal9@gmail.com',oldHash]);

      const requestStudent=await send('student','student@test.example');
      assert.equal(requestStudent.status,202);
      assert.equal(requestStudent.body.message,'If an active account matches that email, a verification code has been sent.');
      const studentOtp=codeFor('student@test.example');
      assert.match(studentOtp,/^\\d{6}$/);
      assert.equal((await verify('teacher','student@test.example',studentOtp)).status,400);
      assert.equal((await verify('student','student@test.example',studentOtp,{role:'teacher'})).status,200);
      const studentRow=await database.get("SELECT otp_hash,attempts,expires_at,created_at FROM password_reset_otps WHERE email='student@test.example' AND account_type='student'");
      assert.notEqual(studentRow.otp_hash,studentOtp);
      assert.equal(studentRow.otp_hash.length,64);
      assert.equal(await database.get("SELECT strftime('%s',expires_at)-strftime('%s',created_at) AS seconds FROM password_reset_otps WHERE email='student@test.example'").then(row=>row.seconds),300);

      const unknown=await send('student','unknown@test.example');
      assert.equal(unknown.status,requestStudent.status);
      assert.deepEqual(unknown.body,requestStudent.body);
      assert.equal(sent.length,1);
      const cooldown=await send('student','student@test.example');
      assert.equal(cooldown.status,202);
      assert.deepEqual(cooldown.body,requestStudent.body);
      assert.equal(sent.length,1);

      const wrongOtp=studentOtp==='000000'?'000001':'000000';
      assert.equal((await verify('student','student@test.example',wrongOtp)).status,400);
      const verified=await verify('student','student@test.example',studentOtp);
      assert.equal(verified.status,200);
      assert.equal((await reset('student','student@test.example',studentOtp,'short')).status,400);
      const studentReset=await reset('student','student@test.example',studentOtp,'StudentReset234');
      assert.equal(studentReset.status,200);
      assert.equal((await verify('student','student@test.example',studentOtp)).status,400);
      const studentLogin=await post('/api/students/login',{email:'student@test.example',password:'StudentReset234'});
      assert.equal(studentLogin.status,200);

      await database.run("UPDATE password_reset_otps SET last_sent_at=datetime('now','-61 seconds') WHERE email='student@test.example' AND account_type='student'");
      assert.equal((await send('student','student@test.example')).status,202);
      const resentStudentOtp=codeFor('student@test.example');
      assert.equal(sent.filter(message=>message.to==='student@test.example').length,2);
      assert.equal((await verify('student','student@test.example',studentOtp)).status,400);
      assert.equal((await verify('student','student@test.example',resentStudentOtp)).status,200);

      assert.equal((await send('teacher','teacher@test.example')).status,202);
      const teacherOtp=codeFor('teacher@test.example');
      await database.run("UPDATE password_reset_otps SET expires_at=datetime('now','-1 second') WHERE email='teacher@test.example' AND account_type='teacher'");
      assert.equal((await verify('teacher','teacher@test.example',teacherOtp)).status,400);
      await database.run("UPDATE password_reset_otps SET last_sent_at=datetime('now','-61 seconds') WHERE email='teacher@test.example' AND account_type='teacher'");
      await send('teacher','teacher@test.example');
      const freshTeacherOtp=codeFor('teacher@test.example');
      assert.equal((await verify('teacher','teacher@test.example',freshTeacherOtp)).status,200);
      assert.equal((await reset('teacher','teacher@test.example',freshTeacherOtp,'TeacherReset234')).status,200);
      const teacherLogin=await post('/api/teachers/login',{email:'teacher@test.example',password:'TeacherReset234'});
      assert.equal(teacherLogin.status,200);

      assert.equal((await send('admin','kaushalpatil927@gmail.com')).status,202);
      const adminOtp=codeFor('kaushalpatil927@gmail.com');
      for(let attempt=0;attempt<5;attempt++){
        const wrong=adminOtp==='000000'?'000001':'000000';
        assert.equal((await verify('admin','kaushalpatil927@gmail.com',wrong)).status,400);
      }
      assert.equal((await verify('admin','kaushalpatil927@gmail.com',adminOtp)).status,400);
      assert.equal((await database.get("SELECT attempts FROM password_reset_otps WHERE account_type='admin'")).attempts,5);
      await database.run("UPDATE password_reset_otps SET last_sent_at=datetime('now','-61 seconds') WHERE account_type='admin'");
      await send('admin','kaushalpatil927@gmail.com');
      const freshAdminOtp=codeFor('kaushalpatil927@gmail.com');
      assert.equal((await reset('admin','kaushalpatil927@gmail.com',freshAdminOtp,'AdministratorReset234')).status,200);
      const adminLogin=require(${JSON.stringify(path.join(root,'node_modules','supertest'))}).agent(app);
      const pairedAdminLogin=await adminLogin.post('/api/auth/login').send({username:'luckykalal9@gmail.com',password:'AdministratorReset234'});
      assert.equal(pairedAdminLogin.status,200);

      failDelivery=true;
      const mailFailure=await send('teacher','smtp-failure@test.example');
      assert.equal(mailFailure.status,202);
      assert.deepEqual(mailFailure.body,requestStudent.body);
      const failedOtp=await database.get("SELECT attempts,used_at FROM password_reset_otps WHERE email='smtp-failure@test.example'");
      assert.equal(failedOtp.attempts,5);
      assert.ok(failedOtp.used_at);
      assert.equal((await verify('teacher','smtp-failure@test.example',codeFor('smtp-failure@test.example'))).status,400);

      const emailTemplate=require(${JSON.stringify(path.join(root,'backend','passwordReset.js'))}).passwordResetEmail('A <Student>','123456');
      assert.match(emailTemplate.html,/RCPET IMRD/);
      assert.match(emailTemplate.html,/expires in 5 minutes/);
      assert.match(emailTemplate.html,/Powered by ZERO TECHNOLOGIES/);
      assert.doesNotMatch(emailTemplate.html,/ZERO ENGINEER/);
      assert.match(emailTemplate.html,/A &lt;Student&gt;/);
      assert.match(emailTemplate.text,/123456/);
      assert.match(emailTemplate.text,/Powered by ZERO TECHNOLOGIES/);
      assert.doesNotMatch(emailTemplate.text,/ZERO ENGINEER/);
      console.log('Password recovery integration checks passed.');
    })().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>database.db.close());
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_FILE: path.join(temp, 'password-reset.sqlite'),
      SESSION_SECRET: 'password-reset-test-session-secret-with-sufficient-length',
      PASSWORD_RESET_PEPPER: 'password-reset-test-pepper-with-sufficient-length',
      SMTP_HOST: 'smtp.test.example',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'sender@test.example',
      SMTP_PASS: 'not-a-real-password',
      MAIL_FROM: 'RCPET IMRD AEP <sender@test.example>',
      NODE_ENV: 'test'
    },
    encoding: 'utf8',
    timeout: 60000
  });
  fs.rmSync(temp, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Password recovery integration checks passed/);
});

test('password recovery UI locks role to login context and validates reset controls', () => {
  const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'frontend', 'js', 'password-reset.js'), 'utf8');
  assert.match(html, /id="adminForgotOpen"/);
  assert.doesNotMatch(html, /id="resetRole"|Account type/);
  assert.match(html, /Registered Email Address/);
  assert.match(html, /placeholder="Enter your registered email"/);
  assert.match(script, /function recoveryEndpoint\(action\)/);
  assert.match(script, /`\/api\/password-reset\/\$\{recovery\.role\}\/\$\{action\}`/);
  assert.doesNotMatch(script, /role:\s*recovery\.role/);
  assert.match(html, /id="resetExpiryCountdown"/);
  assert.match(html, /id="resetResendButton"[^>]*disabled/);
  assert.match(html, /id="resetShowPassword"/);
  assert.match(script, /Passwords do not match/);
  assert.match(html, /id="resetStepSuccess"/);
});
