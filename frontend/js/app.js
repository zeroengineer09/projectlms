const $=s=>document.querySelector(s);const state={assessment:null,attemptId:null,questions:[],index:0,answers:{},deadline:0,policy:{},timer:null,submitting:false,result:null};function show(id){document.querySelectorAll('#home,#studentProfile,#instructions,#exam,#result,#adminLogin,#admin,#teacherLogin,#passwordChange,#teacherDashboard,#passwordReset').forEach(s=>s.classList.add('hidden'));$('#'+id).classList.remove('hidden');const homeLayout=document.querySelector('.home-layout');if(homeLayout)homeLayout.classList.toggle('hidden',id!=='home');const loginHeader=document.querySelector('.login-header');if(loginHeader)loginHeader.classList.toggle('hidden',!['home','adminLogin','teacherLogin','passwordReset'].includes(id));document.body.classList.toggle('portal-active',['studentProfile','admin','teacherDashboard'].includes(id));window.scrollTo(0,0)}async function api(url,opts={}){const r=await fetch(url,{credentials:'same-origin',...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});let data={};try{data=await r.json()}catch{}if(!r.ok)throw Error(data.error||'Request failed.');return data}async function loadAssessments(){ $('#registerError').textContent=''; state.assessment=null; const year=$('#candidateClass').value; $('#assessment').innerHTML=''; if(!year){$('#assessment').innerHTML='<option value="">Choose your year first</option>';return} try{const list=await api('/api/exam/assessments?year='+encodeURIComponent(year));$('#assessment').innerHTML=list.length?list.map(a=>`<option value="${a.id}">${escapeHtml(a.title)} · ${a.duration_minutes} min</option>`).join(''):'<option value="">No assessments assigned yet</option>';state.assessment=list[0]||null;}catch(e){$('#assessment').innerHTML='<option value="">Unable to load assessments</option>';$('#registerError').textContent=e.message}}function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}$('#registration').addEventListener('submit',async e=>{e.preventDefault();$('#registerError').textContent='';try{const d=await api('/api/exam/assessments?year='+encodeURIComponent($('#candidateClass').value));state.assessment=d.find(x=>x.id===Number($('#assessment').value));if(!state.assessment)throw Error('Choose a valid assessment.');state.candidate={name:$('#fullName').value.trim(),className:$('#candidateClass').value.trim(),division:$('#candidateDivision').value.trim(),email:window.currentStudent?.email||''};$('#instructionTitle').textContent=state.assessment.title;$('#instructionDetails').innerHTML=[['Questions','Loaded from assessment'],['Duration',state.assessment.duration_minutes+' minutes'],['Passing score',state.assessment.passing_percentage+'%'],['Attempts permitted',state.assessment.max_attempts]].map(x=>`<div class="info-card"><span class="muted">${x[0]}</span><strong>${x[1]}</strong></div>`).join('');$('#agree').checked=false;$('#startExam').disabled=true;show('instructions')}catch(err){$('#registerError').textContent=err.message}});$('#agree').addEventListener('change',()=>$('#startExam').disabled=!$('#agree').checked);$('#backHome').onclick=()=>{if(currentStudent||window.currentStudent){openStudentPortal();return}$('#assessmentRegistration')?.classList.add('hidden');show('home')};$('#startExam').onclick=async()=>{if(!$('#agree').checked)return;try{if(document.documentElement.requestFullscreen){const fs=document.documentElement.requestFullscreen();if(fs&&fs.catch)fs.catch(()=>{});}const d=await api('/api/exam/register',{method:'POST',body:JSON.stringify({name:state.candidate.name,className:state.candidate.className,division:state.candidate.division,email:state.candidate.email,assessmentId:state.assessment.id})});state.attemptId=d.attemptId;await loadAttempt()}catch(e){$('#instructionError').textContent=e.message}};async function loadAttempt(){const d=await api('/api/exam/attempt/'+state.attemptId);state.candidate={name:d.attempt.name,className:d.attempt.className||'',division:d.attempt.division||''};state.policy=d.attempt.policy;state.questions=d.questions;state.answers=Object.fromEntries(d.questions.filter(q=>q.selected).map(q=>[q.id,q.selected]));state.deadline=Date.parse(d.attempt.deadlineAt);$('#examTitle').textContent=d.attempt.title;state.index=0;show('exam');rememberExamViewport();renderQuestion();startTimer();}function renderQuestion(){const q=state.questions[state.index];if(!q)return;$('#progressText').textContent=`Question ${state.index+1} of ${state.questions.length}`;$('#answeredText').textContent=`${Object.keys(state.answers).length} answered`;$('#progressBar').style.width=((state.index+1)/state.questions.length*100)+'%';$('#questionText').textContent=q.question_text;$('#options').innerHTML=q.options.map(o=>`<label class="option ${state.answers[q.id]===o.id?'selected':''}"><input type="radio" name="answer" value="${o.id}" ${state.answers[q.id]===o.id?'checked':''}><span>${escapeHtml(o.option_text)}</span></label>`).join('');$('#options').querySelectorAll('input').forEach(inp=>inp.onchange=async()=>{const optionId=Number(inp.value);state.answers[q.id]=optionId;renderQuestion();try{await api(`/api/exam/attempt/${state.attemptId}/answer`,{method:'PUT',body:JSON.stringify({questionId:q.id,optionId})})}catch(e){$('#examError').textContent=e.message;$('#connectionStatus').textContent='Answer save failed — reconnecting…';setTimeout(()=>saveCurrent(q.id,optionId),1500)}});$('#previous').disabled=state.index===0;$('#next').textContent=state.index===state.questions.length-1?'Last question':'Next';$('#questionNav').innerHTML=state.questions.map((x,i)=>`<button class="${i===state.index?'current':''} ${state.answers[x.id]?'answered':''}" data-index="${i}" aria-label="Question ${i+1}">${i+1}</button>`).join('');$('#questionNav').querySelectorAll('button').forEach(b=>b.onclick=()=>{state.index=Number(b.dataset.index);renderQuestion()})}async function saveCurrent(qid,oid){try{await api(`/api/exam/attempt/${state.attemptId}/answer`,{method:'PUT',body:JSON.stringify({questionId:qid,optionId:oid})});$('#connectionStatus').textContent='Connected';$('#examError').textContent=''}catch(e){$('#connectionStatus').textContent='Offline: your deadline still applies.'}}$('#previous').onclick=()=>{if(state.index>0){state.index--;renderQuestion()}};$('#next').onclick=()=>{if(state.index<state.questions.length-1){state.index++;renderQuestion()}};function startTimer(){clearInterval(state.timer);const tick=()=>{const left=Math.max(0,state.deadline-Date.now()),sec=Math.ceil(left/1000);$('#timer').textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');$('#timer').classList.toggle('warning',sec<300);if(left<=0)submitExam(true)};tick();state.timer=setInterval(tick,500)}async function submitExam(auto=false){if(state.submitting||!state.attemptId)return;if(!auto&&!confirm('Submit your examination now? You cannot change answers after submission.'))return;state.submitting=true;clearInterval(state.timer);try{const r=await api(`/api/exam/attempt/${state.attemptId}/submit`,{method:'POST',body:'{}'});state.result=r;renderResult(r);show('result')}catch(e){state.submitting=false;$('#examError').textContent=e.message;if(Date.now()>=state.deadline){$('#connectionStatus').textContent='Submission pending; reconnecting…';setTimeout(()=>submitExam(true),2000)}}}$('#submitExam').onclick=()=>submitExam(false);document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.attemptId&&!state.submitting&&state.policy.autoSubmitOnTabSwitch)reportViolation('tab_switch')});async function reportViolation(type){if(state.submitting)return;try{const d=await api(`/api/exam/attempt/${state.attemptId}/violation`,{method:'POST',body:JSON.stringify({type})});if(d.submitted){state.submitting=true;clearInterval(state.timer);state.result=d.result;renderResult(d.result);show('result')}}catch(e){$('#examError').textContent='Could not record a policy event: '+e.message}}document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&state.attemptId&&!state.submitting&&state.policy.autoSubmitOnFullscreenExit)reportViolation('fullscreen_exit')});let examViewportWidth=0;let examViewportHeight=0;function rememberExamViewport(){examViewportWidth=window.innerWidth;examViewportHeight=window.innerHeight}window.addEventListener('resize',()=>{if(!state.attemptId||state.submitting||!document.querySelector('#exam:not(.hidden)'))return;const w=window.innerWidth,h=window.innerHeight;const widthChanged=examViewportWidth>0&&Math.abs(w-examViewportWidth)>=Math.max(120,examViewportWidth*0.22);const heightChanged=examViewportHeight>0&&Math.abs(h-examViewportHeight)>=Math.max(160,examViewportHeight*0.28);if(widthChanged||(document.fullscreenElement&&heightChanged)){reportViolation('split_screen_or_resize');return}examViewportWidth=w;examViewportHeight=h});async function renderResult(r){$('#resultHeading').innerHTML=r.passed?'Assessment passed':'Assessment not passed';$('#resultHeading').className=r.passed?'pass':'fail';const items=[['Candidate',r.candidateName],['Class',r.candidateClass],['Division',r.candidateDivision],['Assessment',r.assessmentTitle],['Correct',r.correctAnswers],['Incorrect',r.incorrectAnswers],['Unanswered',r.unanswered],['Score',`${r.score}/${r.totalQuestions}`],['Percentage',`${r.percentage}%`],['Status',r.passed?'PASS':'FAIL'],['Completed',new Date(r.completedAt).toLocaleString()]];$('#resultSummary').innerHTML=items.map(x=>`<div class="result-card"><span>${x[0]}</span><strong>${escapeHtml(x[1])}</strong></div>`).join('');}$('#returnHome').onclick=()=>{state.attemptId=null;state.submitting=false;show('home')};let passwordTarget='admin';$('#passwordChangeBack').onclick=()=>{if(passwordTarget==='student'){if(window.studentMustChangePassword){$('#studentLoginError').textContent='Change your initial password before continuing.';show('home')}else show('studentProfile')}else if(passwordTarget==='teacher'){if(window.teacherMustChangePassword){$('#teacherLoginError').textContent='Change your initial password to access the dashboard.';show('teacherLogin')}else show('teacherDashboard')}else show('adminLogin')};$('#adminOpen').onclick=()=>$('#profileDropdown').classList.toggle('hidden');$('#adminMenuOpen').onclick=()=>{ $('#profileDropdown').classList.add('hidden'); show('adminLogin'); };$('#teacherMenuOpen').onclick=()=>{ $('#profileDropdown').classList.add('hidden'); show('teacherLogin'); };document.addEventListener('click',e=>{if(!e.target.closest('.profile-menu'))$('#profileDropdown')?.classList.add('hidden')});$('#teacherLoginBack').onclick=()=>show('home');$('#loginBack').onclick=()=>show('home');$('#loginForm').onsubmit=async e=>{e.preventDefault();$('#loginError').textContent='';try{const login=await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:$('#adminUsername').value,password:$('#adminPassword').value})});if(login.mustChangePassword){passwordTarget='admin';$('#passwordChangeError').textContent='';show('passwordChange')}else{show('admin');loadAdmin()}}catch(err){$('#loginError').textContent=err.message}};$('#candidateClass').addEventListener('change',loadAssessments);$('#year').textContent=new Date().getFullYear();loadAssessments();


let currentStudent=null;
async function loadStudentProfile(){
 const p=await api('/api/students/me');currentStudent=p;window.currentStudent=p;window.studentMustChangePassword=!!p.mustChangePassword;
 $('#studentProfileName').textContent=p.fullName;$('#studentProfileClass').textContent=[p.academicYear,p.division?'Division '+p.division:''].filter(Boolean).join(' • ')||'Student';
 $('#studentProfileEmail').textContent=p.email;$('#studentProfileRoll').textContent=p.rollNumber||'—';$('#studentProfileAdmission').textContent=p.admissionYear||'—';$('#studentProfileBatch').textContent=p.practicalBatch||'—';
 applyStudentPhoto(p.profilePhoto);
 $('#fullName').value=p.fullName;$('#candidateClass').value=p.academicYear||'';$('#candidateDivision').value=p.division||'';
 $('#candidateClass').disabled=true;$('#candidateDivision').disabled=true;
 $('#assessmentRegistration').classList.add('hidden');$('#studentProfileMessage').textContent='';
}
$('#studentLoginForm').onsubmit=async e=>{
 e.preventDefault();$('#studentLoginError').textContent='';
 try{
  const d=await api('/api/students/login',{method:'POST',body:JSON.stringify({email:$('#studentEmail').value.trim(),password:$('#studentPassword').value})});
  currentStudent=d;window.currentStudent=d;window.studentMustChangePassword=!!d.mustChangePassword;document.body.classList.add('student-authenticated');
  if(d.mustChangePassword){passwordTarget='student';$('#currentPassword').value=$('#studentPassword').value;$('#passwordChangeError').textContent='';show('passwordChange');}
  else {await loadStudentProfile();show('studentProfile');await openStudentPortal(true);}
 }catch(err){$('#studentLoginError').textContent=err.message;}
};
$('#studentStartAssessment').onclick=()=>setStudentView('assessments');
$('#studentChangePassword').onclick=()=>setStudentView('password');
$('#studentLogout').onclick=async()=>{try{await api('/api/students/logout',{method:'POST',body:'{}'});}catch{}currentStudent=null;window.currentStudent=null;window.studentMustChangePassword=false;document.body.classList.remove('student-authenticated');$('#studentPassword').value='';$('#studentEmail').value='';$('#assessmentRegistration').classList.add('hidden');show('home');};
$('#studentPhotoInput').addEventListener('change',async()=>{
 const file=$('#studentPhotoInput').files[0];if(!file)return;
 if(!['image/jpeg','image/png'].includes(file.type)){ $('#studentProfileMessage').textContent='Choose a JPG or PNG image.';return;}
 if(file.size>256*1024){$('#studentProfileMessage').textContent='Photo must be 256 KB or smaller.';return;}
 const reader=new FileReader(); reader.onload=async()=>{try{const d=await api('/api/students/profile-photo',{method:'PUT',body:JSON.stringify({photo:reader.result})});applyStudentPhoto(d.profilePhoto);if(currentStudent)currentStudent.profilePhoto=d.profilePhoto;window.currentStudent=currentStudent;$('#studentProfileMessage').textContent='Profile photo saved.';try{const dashboard=await api('/api/students/dashboard');renderStudentActivity(dashboard.activities)}catch(refreshError){$('#studentProfileMessage').textContent='Profile photo saved, but activity could not be refreshed: '+refreshError.message}}catch(e){$('#studentProfileMessage').textContent=e.message;}};reader.readAsDataURL(file);});
let teacherLookupTimer;$('#teacherEmail').addEventListener('input',()=>{clearTimeout(teacherLookupTimer);$('#teacherNamePreview').textContent='';const email=$('#teacherEmail').value.trim();if(!email.includes('@'))return;teacherLookupTimer=setTimeout(async()=>{try{const d=await api('/api/teachers/lookup?email='+encodeURIComponent(email));$('#teacherNamePreview').textContent=d.found?'Teacher: '+d.name:''}catch{$('#teacherNamePreview').textContent=''}},250)});$('#teacherLoginForm').onsubmit=async e=>{e.preventDefault();$('#teacherLoginError').textContent='';try{const d=await api('/api/teachers/login',{method:'POST',body:JSON.stringify({email:$('#teacherEmail').value,password:$('#teacherPassword').value})});window.teacherEmail=$('#teacherEmail').value.trim().toLowerCase();$('#teacherWelcome').textContent='Welcome, '+d.name;window.teacherMustChangePassword=!!d.mustChangePassword;if(d.mustChangePassword){passwordTarget='teacher';$('#currentPassword').value=$('#teacherPassword').value;$('#passwordChangeError').textContent='';show('passwordChange')}else show('teacherDashboard')}catch(err){$('#teacherLoginError').textContent=err.message}};$('#passwordChangeForm').onsubmit=async e=>{e.preventDefault();$('#passwordChangeError').textContent='';const current=$('#currentPassword').value,next=$('#newPassword').value,confirm=$('#confirmPassword').value;if(next!==confirm){$('#passwordChangeError').textContent='New passwords do not match.';return}try{await api(passwordTarget==='teacher'?'/api/teachers/change-password':passwordTarget==='student'?'/api/students/change-password':'/api/auth/change-password',{method:'POST',body:JSON.stringify({currentPassword:current,newPassword:next})});if(passwordTarget==='student'){window.studentMustChangePassword=false;await loadStudentProfile();show('studentProfile');$('#studentPassword').value='';await openStudentPortal(true)}else if(passwordTarget==='teacher'){window.teacherMustChangePassword=false;show('teacherDashboard');loadTeacherDashboard()}else{show('admin');loadAdmin()}}catch(err){$('#passwordChangeError').textContent=err.message}};$('#teacherLogout').onclick=async()=>{try{await api('/api/teachers/logout',{method:'POST',body:'{}'})}finally{show('home')}};

// Teacher dashboard: data is scoped server-side to assessments explicitly assigned to this teacher.
async function loadTeacherDashboard(){
 const content=$('#teacherContent'),stats=$('#teacherStats');
 const tabs=document.querySelector('#teacherDashboard .admin-tabs');
 if(tabs && window.teacherEmail==='tushar.patel@rcpimrd.ac.in' && !document.getElementById('hodAllMarksTab')){
  const hodTab=document.createElement('button');hodTab.id='hodAllMarksTab';hodTab.type='button';hodTab.className='secondary';hodTab.textContent='All Student Marks';tabs.appendChild(hodTab);
  hodTab.addEventListener('click',async()=>{content.innerHTML='<p class="muted">Loading all published student marks…</p>';try{const rows=await api('/api/marks/hod/all');content.innerHTML='<h3>All Student Marks</h3><p class="muted">Published credit-test, semester examination, and online test results for all students.</p>'+(rows.length?'<div class="table-wrap"><table><thead><tr><th>Student</th><th>Email</th><th>Year</th><th>Division</th><th>Category</th><th>Subject / Assessment</th><th>Exam</th><th>Marks</th><th>Date</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+escapeHtml(r.student_name)+'</td><td>'+escapeHtml(r.student_email)+'</td><td>'+escapeHtml(r.academic_year||'—')+'</td><td>'+escapeHtml(r.division||'—')+'</td><td>'+escapeHtml(r.category==='credit'?'Credit Test':r.category==='semester'?'Semester Exam':'Online Test')+'</td><td>'+escapeHtml(r.subject_name||'—')+'</td><td>'+escapeHtml(r.title+(r.semester?' • '+r.semester:''))+'</td><td>'+r.marks_obtained+' / '+r.max_marks+' ('+r.percentage+'%)</td><td>'+escapeHtml(r.exam_date||'—')+'</td></tr>').join('')+'</tbody></table></div>':'<p class="muted">No published marks are available yet.</p>')}catch(e){content.innerHTML='<p class="error">'+escapeHtml(e.message)+'</p>'}});
 }
 if(window.teacherEmail==='tushar.patel@rcpimrd.ac.in'){stats.classList.add('hidden');tabs?.querySelectorAll('button:not(#hodAllMarksTab)').forEach(b=>b.classList.add('hidden'));document.getElementById('hodAllMarksTab')?.click();return;}

content.innerHTML='<p class="muted">Loading your assigned subjects and results…</p>';
 try{
  const [st,subjects,assessments]=await Promise.all([api('/api/teacher-dashboard/stats'),api('/api/teacher-dashboard/subjects'),api('/api/teacher-dashboard/assessments')]);
  stats.innerHTML=[['Total students',st.students],['Completed tests',st.completed],['Average score',st.average+'%'],['Passed / Failed',st.passed+' / '+st.failed]].map(x=>`<div class="stat-card"><span>${escapeHtml(x[0])}</span><strong>${escapeHtml(x[1])}</strong></div>`).join('');
  $('#teacherAssessmentFilter').innerHTML='<option value="">All my assessments</option>'+assessments.map(a=>`<option value="${a.id}">${escapeHtml(a.title)}</option>`).join('');
  window.teacherSubjects=subjects;window.teacherAssessments=assessments;
  await loadTeacherResults();
 }catch(e){content.innerHTML=`<p class="error">${escapeHtml(e.message)}</p>`}
}
async function loadTeacherResults(){const q=new URLSearchParams();if($('#teacherYearFilter').value)q.set('year',$('#teacherYearFilter').value);if($('#teacherDivisionFilter').value)q.set('division',$('#teacherDivisionFilter').value);if($('#teacherAssessmentFilter').value)q.set('assessment',$('#teacherAssessmentFilter').value);try{const rows=await api('/api/teacher-dashboard/results?'+q.toString());$('#teacherContent').innerHTML='<h3>Student Results</h3>'+ (rows.length?`<div class="table-wrap"><table><thead><tr><th>Student</th><th>Class</th><th>Division</th><th>Assessment</th><th>Score</th><th>Status</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.candidate_name)}</td><td>${escapeHtml(r.candidate_class)}</td><td>${escapeHtml(r.candidate_division)}</td><td>${escapeHtml(r.title)}</td><td>${r.percentage==null?'—':escapeHtml(r.percentage)+'%'}</td><td>${r.passed==null?'Pending':r.passed?'PASS':'FAIL'}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No results found for your assigned assessments and selected filters.</p>')}catch(e){$('#teacherContent').innerHTML=`<p class="error">${escapeHtml(e.message)}</p>`}}
$('#teacherYearFilter').addEventListener('change',()=>{if($('#teacherDashboard').classList.contains('hidden'))return;loadTeacherResults()});$('#teacherDivisionFilter').addEventListener('change',()=>{if($('#teacherDashboard').classList.contains('hidden'))return;loadTeacherResults()});$('#teacherAssessmentFilter').addEventListener('change',()=>{if($('#teacherDashboard').classList.contains('hidden'))return;loadTeacherResults()});
$('#teacherResultsTab').onclick=loadTeacherResults;
$('#teacherAssessmentsTab').onclick=()=>{const as=window.teacherAssessments||[];$('#teacherContent').innerHTML='<h3>My Assessments</h3>'+(as.length?`<div class="table-wrap"><table><thead><tr><th>Assessment</th><th>Subject/Year</th><th>Questions</th><th>Duration</th><th>Status</th></tr></thead><tbody>${as.map(a=>`<tr><td>${escapeHtml(a.title)}</td><td>${escapeHtml(a.academic_year)}</td><td>${a.question_count}</td><td>${a.duration_minutes} min</td><td>${a.enabled?'Live':'Draft — owner approval required'}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No assessments have been assigned to your account yet.</p>')};
$('#teacherCreateAssessmentTab').onclick=()=>{const subjects=window.teacherSubjects||[];$('#teacherContent').innerHTML=subjects.length?`<h3>Create Assessment</h3><form id="teacherCreateForm"><label>Assigned subject<select name="subject" required>${subjects.map(s=>`<option value="${escapeHtml(s.subject_name)}" data-year="${s.academic_year}">${escapeHtml(s.subject_name)} — ${s.academic_year}</option>`).join('')}</select></label><label>Assessment title<input name="title" required maxlength="150"></label><label>Description<textarea name="description" maxlength="1000"></textarea></label><label>Class / Year<select name="academic_year" required>${[...new Set(subjects.map(s=>s.academic_year))].map(y=>`<option>${y}</option>`).join('')}</select></label><label>Duration (minutes)<input name="duration_minutes" type="number" min="1" max="300" value="30" required></label><label>Passing percentage<input name="passing_percentage" type="number" min="0" max="100" value="60" required></label><label>Maximum attempts<input name="max_attempts" type="number" min="1" max="10" value="1" required></label><p class="muted">New assessments are saved as drafts. The owner must enable them before students can take them. Add/edit questions only after the owner enables the question-management workflow.</p><p id="teacherCreateError" class="error"></p><button class="primary">Create draft assessment</button></form>`:'<p class="muted">No subjects are assigned to your teacher account yet. Ask the owner to configure your subject and class permissions.</p>';const f=$('#teacherCreateForm');if(f)f.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(f).entries());data.duration_minutes=Number(data.duration_minutes);data.passing_percentage=Number(data.passing_percentage);data.max_attempts=Number(data.max_attempts);try{await api('/api/teacher-dashboard/assessments',{method:'POST',body:JSON.stringify(data)});await loadTeacherDashboard();$('#teacherAssessmentsTab').click()}catch(err){$('#teacherCreateError').textContent=err.message}}};
$('#teacherExport').onclick=async()=>{try{const q=new URLSearchParams();if($('#teacherYearFilter').value)q.set('year',$('#teacherYearFilter').value);if($('#teacherDivisionFilter').value)q.set('division',$('#teacherDivisionFilter').value);if($('#teacherAssessmentFilter').value)q.set('assessment',$('#teacherAssessmentFilter').value);const rows=await api('/api/teacher-dashboard/results?'+q);const cols=['candidate_name','candidate_email','candidate_class','candidate_division','title','percentage','passed','completed_at'];const csv=[['Student Name','Email','Class','Division','Assessment','Percentage','Result','Completed At'],...rows.map(r=>cols.map(k=>k==='passed'?(r[k]==null?'Pending':r[k]?'PASS':'FAIL'):(r[k]??'')))].map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));a.download='teacher-assigned-results.csv';a.click();URL.revokeObjectURL(a.href)}catch(e){alert(e.message)}};
$('#teacherChangePassword').onclick=()=>{passwordTarget='teacher';$('#currentPassword').value='';$('#newPassword').value='';$('#confirmPassword').value='';show('passwordChange')};
const originalTeacherLogin=$('#teacherLoginForm').onsubmit;
$('#teacherLoginForm').onsubmit=async e=>{await originalTeacherLogin(e);if(!$('#teacherDashboard').classList.contains('hidden'))loadTeacherDashboard()};

;['privacyLink','disclaimerLink'].forEach(id=>{const link=document.getElementById(id);if(link)link.addEventListener('click',e=>{e.preventDefault();const target=document.getElementById(id==='privacyLink'?'privacy':'disclaimer');if(target)target.classList.toggle('hidden')})});

// Subtle animated rotating phrase; purely decorative and non-clickable.
const phrases=['Academic Assessment','Learning Progress','Skills Development'];let phraseIndex=0;setInterval(()=>{const el=$('#animatedPhrase');if(!el)return;el.classList.add('phrase-fade');setTimeout(()=>{phraseIndex=(phraseIndex+1)%phrases.length;el.textContent=phrases[phraseIndex];el.classList.remove('phrase-fade')},240)},3200);

// Student portal navigation and data views
function setStudentView(view){
 const ids={dashboard:'studentViewDashboard',assessments:'studentViewAssessments',creditMarks:'studentViewCreditMarks',semesterMarks:'studentViewSemesterMarks',onlineResults:'studentViewOnlineResults',teachers:'studentViewTeachers',profile:'studentViewProfile',password:'studentViewPassword'};
 Object.values(ids).forEach(id=>document.getElementById(id)?.classList.add('hidden'));
 document.getElementById(ids[view]||ids.dashboard)?.classList.remove('hidden');
 document.querySelectorAll('.student-nav[data-student-view]').forEach(b=>b.classList.toggle('active',b.dataset.studentView===view));
 const resultsMenu=document.getElementById('studentResultsMenuToggle');
 const resultsSubmenu=document.getElementById('studentResultsSubmenu');
 const isResultsView=['creditMarks','semesterMarks','onlineResults'].includes(view);
 resultsMenu?.classList.toggle('active',isResultsView);
 if(isResultsView&&resultsSubmenu?.classList.contains('is-collapsed')){
  resultsSubmenu.classList.remove('is-collapsed');
  resultsSubmenu.inert=false;
  resultsSubmenu.setAttribute('aria-hidden','false');
  resultsMenu?.setAttribute('aria-expanded','true');
 }
 closeStudentSidebar();
 let dataLoad=Promise.resolve();
 if(view==='assessments')dataLoad=loadStudentAssessments();
 if(view==='creditMarks')dataLoad=loadAcademicMarks('credit');
 if(view==='semesterMarks')dataLoad=loadAcademicMarks('semester');
 if(view==='onlineResults')dataLoad=window.loadStudentAssessmentResults?.()||Promise.resolve();
 if(view==='teachers')dataLoad=loadStudentTeachers();
 window.scrollTo({top:0,behavior:'smooth'});
 return dataLoad;
}
function closeStudentSidebar(){document.getElementById('studentSidebar')?.classList.remove('open');document.getElementById('studentSidebarBackdrop')?.classList.remove('show');document.getElementById('studentSidebarToggle')?.setAttribute('aria-expanded','false')}
function applyStudentPhoto(photoValue, fallback='/assets/student-avatar-placeholder.svg'){
 const safePhoto = (photoValue && String(photoValue).trim()) || fallback;
 const images = [
  document.getElementById('portalHeaderAvatar'),
  document.getElementById('studentPhotoPreview')
 ];
 images.forEach((img) => {
  if (!img) return;
  img.src = safePhoto;
  img.alt = 'Student profile photo';
  img.onerror = () => {
   if (img.src !== fallback) {
    img.src = fallback;
   }
   img.onerror = null;
  };
 });
}
async function openStudentPortal(showWelcome=false){
 const p=currentStudent||window.currentStudent;if(!p)return;
 document.getElementById('studentDashboardName').textContent=p.fullName||'Student';
 document.getElementById('portalHeaderName').textContent=p.fullName||'Student';
 document.getElementById('portalHeaderMeta').textContent=['BCA '+(p.academicYear||'FY'),p.division?'Div '+p.division:'',p.rollNumber?'Roll '+p.rollNumber:''].filter(Boolean).join(' · ');
 document.getElementById('studentDashboardSub').textContent=[p.academicYear?'BCA '+p.academicYear:'BCA',p.division?'Division '+p.division:'',p.rollNumber?'Roll '+p.rollNumber:''].filter(Boolean).join(' • ');
 const yearNames={FY:'First Year',SY:'Second Year',TY:'Third Year'};
 const sidebarCourse=document.getElementById('sidebarStudentCourse');
 const sidebarMeta=document.getElementById('sidebarStudentMeta');
 if(sidebarCourse)sidebarCourse.textContent='BCA - '+(yearNames[p.academicYear]||p.academicYear||'Student');
 if(sidebarMeta)sidebarMeta.textContent=[p.division?'Division '+p.division:'',p.rollNumber?'Roll No. '+p.rollNumber:''].filter(Boolean).join(' | ');
 setStudentView('dashboard');
 try{
  const dashboard=await api('/api/students/dashboard');
  document.getElementById('studentAssessmentCount').textContent=dashboard.assessments.length;
  document.getElementById('studentCompletedCount').textContent=dashboard.completedTests;
  document.getElementById('studentAverageScore').textContent=dashboard.averageScore===null?'—':dashboard.averageScore+'%';
  const dashList=document.getElementById('studentDashboardAssessments');
  if(dashList)dashList.innerHTML=dashboard.assessments.length?dashboard.assessments.slice(0,3).map(x=>`<div class="dashboard-assessment-row"><span class="dashboard-assessment-icon" aria-hidden="true">▣</span><div><strong>${escapeHtml(x.title)}</strong><small>${escapeHtml(x.description||'Academic assessment')}</small><small>◷ ${Number(x.duration_minutes)} minutes &nbsp; | &nbsp; Pass mark ${Number(x.passing_percentage)}%</small></div><button class="primary" type="button" data-dashboard-assessment="${Number(x.id)}">${x.resume?'Resume Test':'Start Test'}</button></div>`).join(''):'<p class="muted">No assessments are currently available for your account.</p>';
  dashList?.querySelectorAll('[data-dashboard-assessment]').forEach(btn=>btn.addEventListener('click',()=>{const target=document.querySelector(`#studentAssessmentsList [data-assessment="${btn.dataset.dashboardAssessment}"]`);if(target)target.click();else{setStudentView('assessments');loadStudentAssessments().then(()=>document.querySelector(`#studentAssessmentsList [data-assessment="${btn.dataset.dashboardAssessment}"]`)?.click())}}));
  const attendance=dashboard.attendance||{summary:{recorded:0,present:0,absent:0,late:0},records:[]};
  const attendanceSummary=document.getElementById('studentAttendanceSummary');
  if(attendanceSummary)attendanceSummary.textContent=attendance.summary.recorded
   ?`${attendance.summary.recorded} record(s): ${attendance.summary.present} present, ${attendance.summary.absent} absent, ${attendance.summary.late} late.`
   :'No attendance has been recorded for your account yet.';
  const attendanceRecords=document.getElementById('studentAttendanceRecords');
  if(attendanceRecords)attendanceRecords.innerHTML=attendance.records.length
   ?attendance.records.slice(0,8).map(record=>`<article class="student-data-row"><strong>${escapeHtml(record.attendance_date)}</strong><span>${escapeHtml(record.status)}</span>${record.note?`<small>${escapeHtml(record.note)}</small>`:''}</article>`).join('')
   :'<p class="muted">Attendance records will appear here when posted.</p>';
  const notices=document.getElementById('studentNotices');
  if(notices)notices.innerHTML=dashboard.notices?.length
   ?dashboard.notices.map(notice=>`<article class="student-data-row"><strong>${escapeHtml(notice.title)}</strong><p>${escapeHtml(notice.body)}</p><small>${escapeHtml(notice.created_at)}</small></article>`).join('')
   :'<p class="muted">There are no published notices at this time.</p>';
  renderStudentActivity(dashboard.activities);
 }catch(error){
  document.getElementById('studentAssessmentCount').textContent='—';
  document.getElementById('studentCompletedCount').textContent='—';
  document.getElementById('studentAverageScore').textContent='—';
  document.getElementById('studentDashboardAssessments').innerHTML=`<p class="error" role="alert">${escapeHtml(error.message)}</p>`;
  document.getElementById('studentRecentActivity').innerHTML=`<p class="error" role="alert">${escapeHtml(error.message)}</p>`;
  document.getElementById('studentAttendanceSummary').textContent=error.message;
  document.getElementById('studentAttendanceRecords').textContent='';
  document.getElementById('studentNotices').textContent=error.message;
 }
 if(showWelcome){const overlay=document.getElementById('studentWelcomeOverlay');if(overlay){overlay.querySelector('[data-welcome-name]').textContent=p.fullName||'Student';overlay.classList.remove('hidden');setTimeout(()=>overlay.classList.add('hidden'),1500)}}
}
document.getElementById('returnHome').onclick=()=>{
 state.attemptId=null;
 state.submitting=false;
 if(currentStudent||window.currentStudent){
  show('studentProfile');
  openStudentPortal();
 }else show('home');
};
function renderStudentActivity(activities){
 const box=document.getElementById('studentRecentActivity');
 if(!box)return;
 if(!activities.length){box.innerHTML='<p class="muted">Your recent academic activity will appear here.</p>';return}
 const icons={assessment:'▣',profile:'✓',account:'♙',result:'✓'};
 box.innerHTML=activities.map(activity=>{
  const date=new Date(activity.occurredAt);
  const dateText=Number.isNaN(date.getTime())?'Date unavailable':date.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
  const dateTime=Number.isNaN(date.getTime())?'':date.toISOString();
  return `<div class="activity-placeholder" data-activity-type="${escapeHtml(activity.type)}"><span aria-hidden="true">${icons[activity.type]||'•'}</span><div><strong>${escapeHtml(activity.title)}</strong><small>${escapeHtml(activity.description)}</small></div><time datetime="${escapeHtml(dateTime)}">${escapeHtml(dateText)}</time></div>`;
 }).join('');
}
async function loadStudentAssessments(){
 const box=document.getElementById('studentAssessmentsList'),p=currentStudent||window.currentStudent;if(!box||!p)return;box.innerHTML='<p class="muted">Loading assessments…</p>';
 try{const dashboard=await api('/api/students/dashboard');const list=dashboard.assessments;if(!list.length){box.innerHTML='<div class="student-content-card"><h3>No assessments available</h3><p class="muted">There are no assessments available for your account right now.</p></div>';return}
 box.innerHTML=list.map(a=>`<article class="student-data-card"><div class="student-data-icon">▣</div><div class="student-data-main"><h3>${escapeHtml(a.title)}</h3><p>${escapeHtml(a.description||'Academic assessment')}</p><div class="student-meta"><span>${Number(a.duration_minutes)} minutes</span><span>Pass mark ${Number(a.passing_percentage)}%</span></div></div><button class="primary student-start-test" data-assessment="${Number(a.id)}">${a.resume?'Resume test':'Start test'}</button></article>`).join('');
 box.querySelectorAll('.student-start-test').forEach(btn=>btn.addEventListener('click',async()=>{try{const assessment=list.find(a=>Number(a.id)===Number(btn.dataset.assessment));$('#fullName').value=p.fullName;$('#candidateClass').value=p.academicYear;$('#candidateDivision').value=p.division;$('#candidateClass').disabled=true;$('#candidateDivision').disabled=true;await loadAssessments();$('#assessment').value=String(assessment.id);state.assessment=assessment;state.candidate={name:p.fullName,className:p.academicYear,division:p.division,email:p.email};$('#instructionTitle').textContent=assessment.title;$('#instructionDetails').innerHTML=[['Questions','Loaded from assessment'],['Duration',assessment.duration_minutes+' minutes'],['Passing score',assessment.passing_percentage+'%'],['Attempts permitted',assessment.max_attempts]].map(x=>`<div class="info-card"><span class="muted">${x[0]}</span><strong>${x[1]}</strong></div>`).join('');$('#agree').checked=false;$('#startExam').disabled=true;show('instructions');}catch(e){box.insertAdjacentHTML('afterbegin','<p class="error">Unable to open this assessment.</p>')}}));
 }catch(e){box.innerHTML=`<p class="error">${escapeHtml(e.message)}</p>`}
}
async function loadStudentTeachers(){
 const box=document.getElementById('studentTeachersList');if(!box)return;box.innerHTML='<p class="muted">Loading teachers…</p>';
 try{const rows=await api('/api/students/teachers');if(!rows.length){box.innerHTML='<div class="student-content-card"><p>No teacher profiles are available yet.</p></div>';return}
 box.innerHTML=rows.map(t=>`<article class="student-teacher-card"><div class="teacher-avatar">${escapeHtml((t.full_name||'T').trim().charAt(0).toUpperCase())}</div><div><h3>${escapeHtml(t.full_name)}</h3><p>${escapeHtml(t.email)}</p><span>B Division Faculty</span></div></article>`).join('');
 }catch(e){box.innerHTML=`<p class="error">${escapeHtml(e.message)}</p>`}
}
document.querySelectorAll('.student-nav[data-student-view], [data-student-view]:not(.student-nav)').forEach(b=>b.addEventListener('click',()=>setStudentView(b.dataset.studentView)));
document.getElementById('studentResultsMenuToggle')?.addEventListener('click',()=>{
 const button=document.getElementById('studentResultsMenuToggle');
 const submenu=document.getElementById('studentResultsSubmenu');
 const expanded=button.getAttribute('aria-expanded')==='true';
 button.setAttribute('aria-expanded',String(!expanded));
 submenu.classList.toggle('is-collapsed',expanded);
 submenu.inert=expanded;
 submenu.setAttribute('aria-hidden',String(expanded));
});
document.getElementById('studentSidebarToggle')?.addEventListener('click',()=>{const s=document.getElementById('studentSidebar'),mobile=window.matchMedia('(max-width: 800px)').matches;if(mobile){const open=!s.classList.contains('open');s.classList.toggle('open',open);document.getElementById('studentSidebarBackdrop').classList.toggle('show',open);document.getElementById('studentSidebarToggle').setAttribute('aria-expanded',String(open))}else{s.classList.toggle('collapsed');document.getElementById('studentSidebarToggle').setAttribute('aria-expanded',String(!s.classList.contains('collapsed')))}});
document.getElementById('studentSidebarClose')?.addEventListener('click',closeStudentSidebar);document.getElementById('studentSidebarBackdrop')?.addEventListener('click',closeStudentSidebar);
async function studentLogout(){try{await api('/api/students/logout',{method:'POST',body:'{}'})}catch{}currentStudent=null;window.currentStudent=null;window.studentMustChangePassword=false;document.body.classList.remove('student-authenticated');$('#studentPassword').value='';$('#studentEmail').value='';show('home')}
document.getElementById('studentPortalLogoutTop')?.addEventListener('click',studentLogout);document.getElementById('studentSidebarLogout')?.addEventListener('click',studentLogout);
document.getElementById('studentManualPasswordForm')?.addEventListener('submit',async e=>{e.preventDefault();const msg=document.getElementById('studentManualPasswordMessage');msg.textContent='';const current=document.getElementById('studentManualCurrent').value,next=document.getElementById('studentManualNew').value,confirm=document.getElementById('studentManualConfirm').value;if(next!==confirm){msg.textContent='New passwords do not match.';return}try{await api('/api/students/change-password',{method:'POST',body:JSON.stringify({currentPassword:current,newPassword:next})});msg.className='success';msg.textContent='Password updated successfully.';['studentManualCurrent','studentManualNew','studentManualConfirm'].forEach(id=>document.getElementById(id).value='')}catch(err){msg.textContent=err.message}});


// Dashboard top-bar interactions: profile menu, notifications shortcut and global search.
(() => {
  const profileButton = document.getElementById('portalProfileButton');
  const profileMenu = document.getElementById('portalProfileDropdown');
  profileButton?.addEventListener('click', () => {
    const open = profileMenu.classList.toggle('show');
    profileMenu.classList.toggle('hidden', !open);
    profileButton.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (event) => {
    if (profileMenu && !event.target.closest('.portal-user-menu')) {
      profileMenu.classList.add('hidden');
      profileMenu.classList.remove('show');
      profileButton?.setAttribute('aria-expanded', 'false');
    }
  });
  document.getElementById('portalNotifications')?.addEventListener('click', () => {
    const activity = document.querySelector('.dashboard-activity-card');
    if (activity) {
      setStudentView('dashboard');
      requestAnimationFrame(() => activity.scrollIntoView({behavior:'smooth', block:'center'}));
    }
  });
  const search = document.getElementById('portalGlobalSearch');
  function runPortalSearch() {
    const query = (search?.value || '').trim().toLowerCase();
    const view = document.querySelector('.student-view:not(.hidden)');
    document.querySelectorAll('.search-filter-hidden').forEach(el => el.classList.remove('search-filter-hidden'));
    if (!view || !query) return;
    const cards = view.querySelectorAll('.student-data-card, .dashboard-assessment-row, .teacher-card, .student-content-card, .activity-placeholder, .student-summary-grid article');
    cards.forEach(card => {
      const searchable = (card.innerText || card.textContent || '').toLowerCase();
      card.classList.toggle('search-filter-hidden', !searchable.includes(query));
    });
  }
  function jumpToSearchCategory(query) {
    const q = query.toLowerCase();
    const routes = [
      {terms:['assessment','assessments','test','tests','office','web design','subject'], view:'assessments'},
      {terms:['credit','internal'], view:'creditMarks'},
      {terms:['semester','exam'], view:'semesterMarks'},
      {terms:['result','score','online test'], view:'onlineResults'},
      {terms:['teacher','faculty','mam','sir'], view:'teachers'},
      {terms:['profile','account'], view:'profile'}
    ];
    const route = routes.find(item => item.terms.some(term => q.includes(term)));
    let dataLoad=Promise.resolve();
    if (route) dataLoad=setStudentView(route.view);
    else {
      const matchingView = [...document.querySelectorAll('.student-view')].find(candidate =>
        [...candidate.querySelectorAll('.student-data-card,.dashboard-assessment-row,.teacher-card,.student-content-card')]
          .some(card => (card.innerText || card.textContent || '').toLowerCase().includes(q))
      );
      if (matchingView) {
        const map = {studentViewDashboard:'dashboard',studentViewAssessments:'assessments',studentViewCreditMarks:'creditMarks',studentViewSemesterMarks:'semesterMarks',studentViewOnlineResults:'onlineResults',studentViewTeachers:'teachers',studentViewProfile:'profile',studentViewPassword:'password'};
        if (map[matchingView.id]) dataLoad=setStudentView(map[matchingView.id]);
      }
    }
    Promise.resolve(dataLoad).then(runPortalSearch);
  }
  search?.addEventListener('input', runPortalSearch);
  search?.addEventListener('keydown', event => {
    if(event.key==='Escape'){search.value='';runPortalSearch();search.blur()}
    if(event.key==='Enter'){
      const query = (search.value || '').trim();
      if (!query) return;
      jumpToSearchCategory(query);
    }
  });
  document.addEventListener('keydown', event => {
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'&&search){
      event.preventDefault();search.focus();
    }
  });
})();
