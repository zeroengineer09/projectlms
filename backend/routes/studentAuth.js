const express=require('express');
const bcrypt=require('bcryptjs');
const rateLimit=require('express-rate-limit');
const {run,get}=require('../database');
const router=express.Router();
const loginLimiter=rateLimit({windowMs:15*60*1000,max:8,standardHeaders:true,legacyHeaders:false,message:{error:'Too many login attempts. Try again later.'}});
router.use(async(req,res,next)=>{
 if(!req.session.studentId||req.path==='/logout')return next();
 try{
  const account=await get('SELECT active,must_change_password FROM student_accounts WHERE id=?',[req.session.studentId]);
  if(!account||!Number(account.active))return res.status(401).json({error:'Student account is inactive or unavailable.'});
  req.session.studentMustChangePassword=Boolean(account.must_change_password);
  if(req.session.studentMustChangePassword&&!['/me','/change-password'].includes(req.path))return res.status(403).json({error:'Change your initial student password before continuing.'});
  return next();
 }catch(error){
  console.error('Student session validation failed:',error.message);
  return res.status(500).json({error:'Unable to validate student account.'});
 }
});
router.post('/login',loginLimiter,async(req,res)=>{try{
 const identifier=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');
 if(!identifier||!password)return res.status(400).json({error:'Enter your registered email or student ID and password.'});
 const student=await get('SELECT * FROM student_accounts WHERE (lower(email)=? OR lower(student_number)=?) AND active=1',[identifier,identifier]);
 if(!student||!(await bcrypt.compare(password,student.password_hash)))return res.status(401).json({error:'Invalid Credentials'});
 req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Unable to create student session.'});req.session.studentId=student.id;req.session.studentEmail=student.email;req.session.studentMustChangePassword=!!student.must_change_password;req.session.save(saveErr=>{if(saveErr)return res.status(500).json({error:'Unable to save login session. Please try again.'});res.json({id:student.id,email:student.email,studentNumber:student.student_number||'',fullName:student.full_name,academicYear:student.academic_year,division:student.division,rollNumber:student.roll_number,admissionYear:student.admission_year,practicalBatch:student.practical_batch||'',profilePhoto:student.profile_photo_data||'',mustChangePassword:!!student.must_change_password})})});
}catch(e){console.error('Student login failed:',e.message);res.status(500).json({error:'Unable to sign in.'})}});
router.get('/me',async(req,res)=>{if(!req.session.studentId)return res.status(401).json({error:'Please sign in as a student.'});try{const s=await get('SELECT id,email,student_number,full_name,academic_year,division,roll_number,admission_year,practical_batch,profile_photo_data,must_change_password FROM student_accounts WHERE id=? AND active=1',[req.session.studentId]);if(!s)return res.status(401).json({error:'Student account not found.'});res.json({id:s.id,email:s.email,studentNumber:s.student_number||'',fullName:s.full_name,academicYear:s.academic_year,division:s.division,rollNumber:s.roll_number,admissionYear:s.admission_year,practicalBatch:s.practical_batch||'',profilePhoto:s.profile_photo_data||'',mustChangePassword:!!s.must_change_password})}catch(e){res.status(500).json({error:'Unable to load profile.'})}});
router.put('/profile-photo',async(req,res)=>{if(!req.session.studentId)return res.status(401).json({error:'Please sign in as a student.'});const photo=String(req.body.photo||'');if(!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(photo)||photo.length>360000)return res.status(400).json({error:'Upload a JPG or PNG photo up to 256 KB.'});try{await run("UPDATE student_accounts SET profile_photo_data=?,profile_updated_at=datetime('now') WHERE id=?",[photo,req.session.studentId]);res.json({ok:true,profilePhoto:photo})}catch(e){res.status(500).json({error:'Unable to save profile photo.'})}});
router.post('/change-password',async(req,res)=>{if(!req.session.studentId)return res.status(401).json({error:'Please sign in as a student.'});try{const current=String(req.body.currentPassword||''),next=String(req.body.newPassword||'');if(next.length<8||!/[a-z]/.test(next)||!/[A-Z]/.test(next)||!/[0-9]/.test(next))return res.status(400).json({error:'New password must be at least 8 characters and include uppercase, lowercase and a number.'});const s=await get('SELECT * FROM student_accounts WHERE id=?',[req.session.studentId]);if(!s||!(await bcrypt.compare(current,s.password_hash)))return res.status(401).json({error:'Current password is incorrect.'});await run("UPDATE student_accounts SET password_hash=?,must_change_password=0,password_changed_at=datetime('now') WHERE id=?",[await bcrypt.hash(next,12),s.id]);req.session.studentMustChangePassword=false;res.json({ok:true})}catch(e){res.status(500).json({error:'Unable to change password.'})}});

router.get('/results',async(req,res)=>{if(!req.session.studentId)return res.status(401).json({error:'Please sign in as a student.'});try{const s=await get('SELECT email FROM student_accounts WHERE id=?',[req.session.studentId]);if(!s)return res.status(401).json({error:'Student account not found.'});const {all}=require('../database');const rows=await all(`SELECT a.title,a.academic_year,r.total_questions,r.correct_answers,r.incorrect_answers,r.unanswered,r.score,r.percentage,r.passed,r.completed_at,COALESCE((SELECT group_concat(DISTINCT q.category) FROM submitted_answers sa JOIN questions q ON q.id=sa.question_id WHERE sa.attempt_id=t.id),'General') AS topics FROM results r JOIN examination_attempts t ON t.id=r.attempt_id JOIN assessments a ON a.id=t.assessment_id WHERE lower(t.candidate_email)=lower(?) GROUP BY r.id ORDER BY r.completed_at DESC`,[s.email]);res.json(rows)}catch(e){console.error('Student results failed',e);res.status(500).json({error:'Unable to load your test marks.'})}});
router.get('/teachers',async(req,res)=>{if(!req.session.studentId)return res.status(401).json({error:'Please sign in as a student.'});try{const {all}=require('../database');const rows=await all('SELECT full_name,email FROM teachers WHERE active=1 ORDER BY full_name COLLATE NOCASE');res.json(rows)}catch(e){res.status(500).json({error:'Unable to load teachers.'})}});
router.get('/dashboard',async(req,res)=>{if(!req.session.studentId)return res.status(401).json({error:'Please sign in as a student.'});try{
 const {all}=require('../database');
 const student=await get('SELECT id,email,academic_year,created_at,profile_updated_at FROM student_accounts WHERE id=? AND active=1',[req.session.studentId]);
 if(!student)return res.status(401).json({error:'Student account not found.'});
 const year=String(student.academic_year||'').trim().toUpperCase();
 const assessments=await all(`SELECT a.id,a.title,a.description,a.duration_minutes,a.passing_percentage,a.max_attempts,a.created_at,
  (SELECT COUNT(*) FROM examination_attempts t WHERE t.assessment_id=a.id AND t.student_id=student.id
    AND NOT EXISTS(SELECT 1 FROM assessment_submissions sub WHERE sub.attempt_id=t.id AND sub.reset_at IS NOT NULL)) AS attempts_count,
  (SELECT COUNT(*) FROM examination_attempts t WHERE t.assessment_id=a.id AND t.student_id=student.id AND t.status='in_progress') AS active_attempts,
  (SELECT COUNT(*) FROM questions q WHERE q.assessment_id=a.id AND q.active=1) AS question_count
  FROM assessments a CROSS JOIN student_accounts student
  WHERE student.id=? AND a.enabled=1 AND a.academic_year IN (?, 'ALL') AND lower(trim(a.title)) != lower(?)
    AND EXISTS(
      SELECT 1 FROM assessment_students assigned
      WHERE assigned.assessment_id=a.id AND assigned.student_id=student.id
    )
    AND NOT EXISTS(
      SELECT 1 FROM assessment_submissions sub
      WHERE sub.assessment_id=a.id AND sub.student_id=student.id AND sub.reset_at IS NULL
    )
  ORDER BY a.id`,[student.id,year,'Certified Web Test']);
 const availableAssessments=assessments
  .filter(a=>Number(a.question_count)>0&&(Number(a.attempts_count)<Number(a.max_attempts)||Number(a.active_attempts)>0))
  .map(a=>({...a,resume:Number(a.active_attempts)>0}));
 const results=await all(`SELECT a.title,r.percentage,r.completed_at
  FROM results r JOIN examination_attempts t ON t.id=r.attempt_id JOIN assessments a ON a.id=t.assessment_id
  WHERE lower(t.candidate_email)=lower(?) ORDER BY r.completed_at DESC`,[student.email]);
 const attendance=await all(
  `SELECT attendance_date,status,note FROM student_attendance
   WHERE student_id=? ORDER BY attendance_date DESC LIMIT 30`,
  [student.id]
 );
 const attendanceSummary=await get(
  `SELECT COUNT(*) AS recorded,
    SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) AS present,
    SUM(CASE WHEN status='absent' THEN 1 ELSE 0 END) AS absent,
    SUM(CASE WHEN status='late' THEN 1 ELSE 0 END) AS late
   FROM student_attendance WHERE student_id=?`,
  [student.id]
 );
 const notices=await all(
  `SELECT id,title,body,created_at FROM student_notices
   WHERE published=1 ORDER BY created_at DESC LIMIT 10`
 );
 const activities=[
  ...availableAssessments.filter(a=>a.created_at).map(a=>({type:'assessment',title:'New assessment available',description:a.title,occurredAt:a.created_at})),
  ...(student.profile_updated_at?[{type:'profile',title:'Profile updated',description:'Your profile photo was updated.',occurredAt:student.profile_updated_at}]:[]),
  ...(student.created_at?[{type:'account',title:'Account created',description:'Welcome to RCPET IMRD, Shirpur!',occurredAt:student.created_at}]:[]),
  ...results.map(r=>({type:'result',title:'Assessment completed',description:r.title,occurredAt:r.completed_at}))
 ].sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt)).slice(0,6);
 const averageScore=results.length?Math.round(results.reduce((total,result)=>total+Number(result.percentage||0),0)/results.length*10)/10:null;
 res.json({
  assessments:availableAssessments,
  completedTests:results.length,
  averageScore,
  activities,
  attendance:{
   summary:{recorded:Number(attendanceSummary.recorded||0),present:Number(attendanceSummary.present||0),absent:Number(attendanceSummary.absent||0),late:Number(attendanceSummary.late||0)},
   records:attendance
  },
  notices
 });
 }catch(e){console.error('Student dashboard failed',e);res.status(500).json({error:'Unable to load your dashboard.'})}});
router.post('/logout',(req,res)=>req.session.destroy(()=>{res.clearCookie('cdt.sid');res.json({ok:true})}));
module.exports=router;
