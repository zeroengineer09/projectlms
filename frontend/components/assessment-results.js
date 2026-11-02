(() => {
  const $ = id => document.getElementById(id);
  const api = async (url, options = {}) => {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'Request failed.');
    return data;
  };
  const releaseIso = value => value ? new Date(value).toISOString() : '';
  const releaseLocal = value => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const dateText = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  };
  const markText = (obtained, total) => `${Number(obtained || 0)} / ${Number(total || 0)}`;
  const resultStatus = result => result.evaluation_status === 'pending'
    ? 'Pending manual evaluation'
    : Number(result.passed) === 1 ? 'Pass' : 'Fail';

  function renderDetails(target, result, detail, role) {
    const questions = detail.questions || [];
    target.classList.remove('hidden');
    target.innerHTML = `<div class="assessment-result-detail-heading"><div><p class="eyebrow">${esc(result.assessment_title || detail.assessment_title)}</p><h3>Detailed Result</h3><p class="muted">${esc(result.student_name || detail.student_name || detail.candidate_name)} · Roll ${esc(result.roll_number || detail.roll_number || '—')}</p></div><button class="secondary" type="button" data-close-result>Close</button></div>
      <div class="assessment-question-results">${questions.map((question, index) => {
        const status = question.status;
        const badge = status === 'correct' ? 'Correct' : status === 'incorrect' ? 'Incorrect' : status === 'manual' ? 'Manual evaluation' : 'Unanswered';
        const answer = question.selectedAnswer
          ? `<p><strong>Your answer:</strong> ${esc(question.selectedAnswer)}</p>`
          : '<p><strong>Your answer:</strong> Not answered</p>';
        const key = question.type === 'subjective'
          ? '<p class="muted">Subjective response — evaluated by the teacher.</p>'
          : `<p><strong>Correct answer:</strong> ${esc(question.correctAnswer || 'Not configured')}</p>`;
        const manual = role === 'teacher' && question.type === 'subjective' && status === 'manual'
          ? `<label>Marks awarded (maximum ${Number(question.marks)})<input data-evaluation-marks="${Number(question.id)}" type="number" min="0" max="${Number(question.marks)}" step="0.5" value="${question.marksAwarded ?? ''}"></label><label>Feedback<textarea data-evaluation-feedback="${Number(question.id)}" maxlength="1000">${esc(question.feedback)}</textarea></label>`
          : question.type === 'subjective' && question.marksAwarded !== null
            ? `<p><strong>Marks awarded:</strong> ${Number(question.marksAwarded)} / ${Number(question.marks)}${question.feedback ? ` · ${esc(question.feedback)}` : ''}</p>`
            : `<p><strong>Marks:</strong> ${question.marksAwarded === null ? 'Pending' : `${Number(question.marksAwarded)} / ${Number(question.marks)}`}</p>`;
        return `<article class="assessment-question-result ${esc(status)}"><div class="assessment-question-result-top"><strong>Question ${index + 1}</strong><span class="result-status-badge ${esc(status)}">${badge}</span></div><p>${esc(question.question)}</p>${answer}${key}${manual}</article>`;
      }).join('')}</div>
      ${role === 'teacher' && questions.some(question => question.type === 'subjective' && question.status === 'manual')
        ? '<p><button class="primary" type="button" data-save-evaluation>Save manual evaluation</button> <span class="muted" data-evaluation-message></span></p>'
        : ''}`;
    target.querySelector('[data-close-result]')?.addEventListener('click', () => target.classList.add('hidden'));
    target.querySelector('[data-save-evaluation]')?.addEventListener('click', async event => {
      const message = target.querySelector('[data-evaluation-message]');
      const evaluations = questions
        .filter(question => question.type === 'subjective' && question.status === 'manual')
        .map(question => ({
          questionId: question.id,
          marksAwarded: Number(target.querySelector(`[data-evaluation-marks="${question.id}"]`)?.value),
          feedback: target.querySelector(`[data-evaluation-feedback="${question.id}"]`)?.value || ''
        }));
      event.currentTarget.disabled = true;
      try {
        await api(`/api/assessment-results/teacher/${encodeURIComponent(detail.attempt_id)}/evaluate`, {
          method: 'POST',
          body: JSON.stringify({ evaluations })
        });
        message.textContent = 'Evaluation saved.';
        await window.loadTeacherResults();
        const refreshed = await api(`/api/assessment-results/teacher/${encodeURIComponent(detail.attempt_id)}`);
        const row = (window.assessmentTeacherRows || []).find(item => item.attempt_id === detail.attempt_id) || result;
        renderDetails(target, row, refreshed, 'teacher');
      } catch (error) {
        message.textContent = error.message;
        event.currentTarget.disabled = false;
      }
    });
    subjectLabel.querySelector('select').addEventListener('change', loadTeacherAssessmentResults);
  }

  async function loadStudentAssessmentResults() {
    const box = $('studentAssessmentResultsList');
    const detailBox = $('studentAssessmentResultDetail');
    if (!box || !detailBox) return;
    box.innerHTML = '<p class="muted">Loading your assessment results…</p>';
    detailBox.classList.add('hidden');
    try {
      const rows = await api('/api/assessment-results/student');
      if (!rows.length) {
        box.innerHTML = '<div class="student-content-card"><h3>No submitted assessment results yet</h3><p class="muted">Your submitted tests will appear here after you complete an assessment.</p></div>';
        return;
      }
      box.innerHTML = rows.map(result => `<article class="student-content-card assessment-result-card">
        <div class="assessment-result-card-heading"><div><p class="eyebrow">${esc(result.subject_name || 'Assessment')}</p><h3>${esc(result.assessment_title)}</h3><span class="result-status-badge correct">Completed – Assessment Submitted</span></div><span class="result-status-badge ${result.evaluation_status === 'pending' ? 'pending' : result.passed ? 'correct' : 'incorrect'}">${esc(resultStatus(result))}</span></div>
        <div class="assessment-result-meta"><span><strong>${markText(result.marks_obtained, result.total_marks)}</strong><small>Marks obtained / total</small></span><span><strong>${Number(result.percentage).toFixed(1)}%</strong><small>Percentage</small></span><span><strong>${Number(result.correct_answers)}</strong><small>Correct answers</small></span><span><strong>${Number(result.incorrect_answers)}</strong><small>Wrong answers</small></span><span><strong>${Number(result.attempted)} / ${Number(result.total_questions)}</strong><small>Attempted</small></span><span><strong>${Number(result.unanswered)}</strong><small>Unanswered</small></span></div>
        <p class="assessment-result-byline">Teacher: ${esc(result.teacher_name)} · Student: ${esc(result.student_name)} · Roll: ${esc(result.roll_number || '—')}</p>
        <p class="muted small">Submitted ${esc(dateText(result.completed_at))}${result.pending_manual ? ` · ${Number(result.pending_manual)} subjective answer(s) awaiting evaluation` : ''}</p>
        ${result.detailsReleased
          ? `<button class="primary" type="button" data-student-result="${esc(result.attempt_id)}">View Result</button>`
          : `<button class="secondary" type="button" disabled title="Details are unavailable until the configured release time">Details available ${esc(dateText(result.result_release_at))}</button>`}
      </article>`).join('');
      box.querySelectorAll('[data-student-result]').forEach(button => button.addEventListener('click', async () => {
        detailBox.innerHTML = '<p class="muted">Loading detailed answers…</p>';
        detailBox.classList.remove('hidden');
        try {
          const result = rows.find(row => row.attempt_id === button.dataset.studentResult);
          const detail = await api(`/api/assessment-results/student/${encodeURIComponent(button.dataset.studentResult)}`);
          renderDetails(detailBox, result, detail, 'student');
          detailBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (error) {
          detailBox.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p>`;
        }
      }));
    } catch (error) {
      box.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p>`;
    }
  }

  window.loadStudentAssessmentResults = loadStudentAssessmentResults;

  async function loadTeacherAssessmentResults() {
    const content = $('teacherContent');
    if (!content) return;
    const filters = new URLSearchParams();
    if ($('teacherYearFilter')?.value) filters.set('year', $('teacherYearFilter').value);
    if ($('teacherDivisionFilter')?.value) filters.set('division', $('teacherDivisionFilter').value);
    if ($('teacherAssessmentFilter')?.value) filters.set('assessment', $('teacherAssessmentFilter').value);
    if ($('teacherResultSearch')?.value.trim()) filters.set('search', $('teacherResultSearch').value.trim());
    if ($('teacherSubjectFilter')?.value) filters.set('subject', $('teacherSubjectFilter').value);
    content.innerHTML = '<p class="muted">Loading your assessment results…</p>';
    try {
      const data = await api(`/api/assessment-results/teacher?${filters}`);
      window.assessmentTeacherRows = data.attempts;
      const assessments = data.assessments;
      const subjectFilter = $('teacherSubjectFilter');
      if (subjectFilter) {
        const selectedSubject = subjectFilter.value;
        const subjects = [...new Set(assessments.map(assessment => assessment.subject_name).filter(Boolean))];
        subjectFilter.innerHTML = '<option value="">All subjects</option>' + subjects.map(subject => `<option value="${esc(subject)}">${esc(subject)}</option>`).join('');
        subjectFilter.value = subjects.includes(selectedSubject) ? selectedSubject : '';
      }
      const summary = assessments.length ? `<h3>Assessment-wise performance</h3><div class="assessment-summary-grid">${assessments.map(assessment => `<article class="student-content-card"><h4>${esc(assessment.title)}</h4><p>${esc(assessment.subject_name || 'Subject not set')} · ${esc(assessment.academic_year)}</p><div class="student-meta"><span>Assigned: ${assessment.assignedStudents}</span><span>Attempted: ${assessment.attemptedStudents}</span><span>Not attempted: ${assessment.notAttemptedStudents}</span></div><p class="muted small">Highest ${assessment.highestMarks === null ? '—' : Number(assessment.highestMarks).toFixed(2)} · Lowest ${assessment.lowestMarks === null ? '—' : Number(assessment.lowestMarks).toFixed(2)} · Average ${assessment.averageMarks === null ? '—' : Number(assessment.averageMarks).toFixed(2)}</p></article>`).join('')}</div>` : '<p class="muted">No assessments are assigned to your account.</p>';
      const attempts = data.attempts.length ? `<h3>Individual student results</h3><div class="table-wrap"><table class="admin-table"><thead><tr><th>Assessment / Subject</th><th>Student</th><th>Roll</th><th>Attempted</th><th>Correct</th><th>Wrong</th><th>Unanswered</th><th>Marks</th><th>%</th><th>Result</th><th></th></tr></thead><tbody>${data.attempts.map(result => `<tr><td>${esc(result.assessment_title)}<br><small>${esc(result.subject_name || '—')}</small></td><td>${esc(result.student_name)}</td><td>${esc(result.roll_number || '—')}</td><td>${Number(result.attempted)} / ${Number(result.total_questions)}</td><td>${Number(result.correct_answers)}</td><td>${Number(result.incorrect_answers)}</td><td>${Number(result.unanswered)}</td><td>${markText(result.marks_obtained, result.total_marks)}</td><td>${Number(result.percentage).toFixed(1)}%</td><td>${esc(resultStatus(result))}</td><td><button class="secondary" type="button" data-teacher-result="${esc(result.attempt_id)}">View details</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No submitted results match the selected filters.</p>';
      content.innerHTML = `${summary}${attempts}<div id="teacherAssessmentResultDetail" class="student-content-card hidden"></div>`;
      content.querySelectorAll('[data-teacher-result]').forEach(button => button.addEventListener('click', async () => {
        const detailBox = $('teacherAssessmentResultDetail');
        detailBox.innerHTML = '<p class="muted">Loading result details…</p>';
        detailBox.classList.remove('hidden');
        try {
          const detail = await api(`/api/assessment-results/teacher/${encodeURIComponent(button.dataset.teacherResult)}`);
          const result = data.attempts.find(row => row.attempt_id === button.dataset.teacherResult);
          renderDetails(detailBox, result, detail, 'teacher');
          detailBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (error) {
          detailBox.innerHTML = `<p class="error">${esc(error.message)}</p>`;
        }
      }));
    } catch (error) {
      content.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p>`;
    }
  }
  window.loadTeacherResults = loadTeacherAssessmentResults;
  ['teacherYearFilter', 'teacherDivisionFilter', 'teacherAssessmentFilter', 'teacherSubjectFilter'].forEach(id => {
    $(id)?.addEventListener('change', loadTeacherAssessmentResults);
  });
  let teacherSearchTimer;
  $('teacherResultSearch')?.addEventListener('input', () => {
    clearTimeout(teacherSearchTimer);
    teacherSearchTimer = setTimeout(loadTeacherAssessmentResults, 250);
  });

  async function loadAdminAssessmentResults() {
    const content = $('adminContent');
    if (!content) return;
    content.innerHTML = '<p class="muted">Loading complete assessment results…</p>';
    try {
      const [teachers, assessments] = await Promise.all([
        api('/api/admin/teachers'),
        api('/api/admin/assessments')
      ]);
      content.innerHTML = `<h3>All assessment results</h3><div class="filters-row assessment-result-filters">
        <label>Teacher<select id="adminResultTeacher"><option value="">All teachers</option>${teachers.map(teacher => `<option value="${teacher.id}">${esc(teacher.full_name)}</option>`).join('')}</select></label>
        <label>Assessment<select id="adminResultAssessment"><option value="">All assessments</option>${assessments.map(assessment => `<option value="${assessment.id}">${esc(assessment.title)}</option>`).join('')}</select></label>
        <label>Subject<input id="adminResultSubject" type="search" placeholder="Filter by subject"></label>
        <label>Student / Roll<input id="adminResultStudent" type="search" placeholder="Filter by name or roll number"></label>
        <button id="adminResultSearch" class="secondary" type="button">Apply filters</button>
      </div><div id="adminAssessmentSummary"></div><div id="adminResultTable"></div><div id="adminAssessmentResultDetail" class="student-content-card hidden"></div>`;
      const loadRows = async () => {
        const params = new URLSearchParams();
        if ($('adminResultTeacher').value) params.set('teacher', $('adminResultTeacher').value);
        if ($('adminResultAssessment').value) params.set('assessment', $('adminResultAssessment').value);
        if ($('adminResultSubject').value.trim()) params.set('subject', $('adminResultSubject').value.trim());
        if ($('adminResultStudent').value.trim()) params.set('student', $('adminResultStudent').value.trim());
        const [rows, summaries] = await Promise.all([
          api(`/api/assessment-results/admin?${params}`),
          api(`/api/assessment-results/admin/summary?${params}`)
        ]);
        $('adminAssessmentSummary').innerHTML = summaries.length
          ? `<h4>Teacher-wise assessment reports</h4><div class="assessment-summary-grid">${summaries.map(summary => `<article class="student-content-card"><h4>${esc(summary.assessment_title)}</h4><p>${esc(summary.teacher_name)} · ${esc(summary.subject_name || 'Subject not set')} · ${esc(summary.academic_year)}</p><div class="student-meta"><span>Assigned ${Number(summary.assigned_students)}</span><span>Attempted ${Number(summary.attempted_students)}</span><span>Not attempted ${Number(summary.not_attempted_students)}</span><span>Results ${Number(summary.result_count)}</span></div><p class="muted small">Highest ${summary.highest_marks === null ? '—' : Number(summary.highest_marks).toFixed(2)} · Lowest ${summary.lowest_marks === null ? '—' : Number(summary.lowest_marks).toFixed(2)} · Average ${summary.average_marks === null ? '—' : Number(summary.average_marks).toFixed(2)}</p></article>`).join('')}</div>`
          : '<p class="muted">No assessments match the selected filters.</p>';
        $('adminResultTable').innerHTML = rows.length ? `<div class="table-wrap"><table class="admin-table"><thead><tr><th>Teacher</th><th>Assessment / Subject</th><th>Student</th><th>Roll</th><th>Attempted</th><th>Correct</th><th>Wrong</th><th>Unanswered</th><th>Marks</th><th>%</th><th>Result</th><th>Actions</th></tr></thead><tbody>${rows.map(result => `<tr><td>${esc(result.teacher_name)}</td><td>${esc(result.assessment_title)}<br><small>${esc(result.subject_name || '—')}</small></td><td>${esc(result.student_name)}</td><td>${esc(result.roll_number || '—')}</td><td>${Number(result.attempted)} / ${Number(result.total_questions)}</td><td>${Number(result.correct_answers)}</td><td>${Number(result.incorrect_answers)}</td><td>${Number(result.unanswered)}</td><td>${markText(result.marks_obtained, result.total_marks)}</td><td>${Number(result.percentage).toFixed(1)}%</td><td>${esc(resultStatus(result))}</td><td><button class="secondary" data-admin-result="${esc(result.attempt_id)}" type="button">Details</button> ${result.attempt_reset ? '<span class="muted small">Reset authorized</span>' : `<button class="danger" data-reset-attempt="${esc(result.attempt_id)}" type="button">Reset attempt</button>`}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No submitted results match the selected filters.</p>';
        $('adminResultTable').querySelectorAll('[data-admin-result]').forEach(button => button.addEventListener('click', async () => {
          const detailBox = $('adminAssessmentResultDetail');
          detailBox.innerHTML = '<p class="muted">Loading detailed result…</p>';
          detailBox.classList.remove('hidden');
          try {
            const detail = await api(`/api/assessment-results/admin/${encodeURIComponent(button.dataset.adminResult)}`);
            const result = rows.find(row => row.attempt_id === button.dataset.adminResult);
            renderDetails(detailBox, result, detail, 'admin');
            detailBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } catch (error) {
            detailBox.innerHTML = `<p class="error">${esc(error.message)}</p>`;
          }
        }));
        $('adminResultTable').querySelectorAll('[data-reset-attempt]').forEach(button => button.addEventListener('click', async () => {
          const reason = window.prompt('Enter the reason for resetting this assessment attempt:');
          if (reason === null) return;
          try {
            const result = await api(`/api/assessment-results/admin/${encodeURIComponent(button.dataset.resetAttempt)}/reset`, {
              method: 'POST',
              body: JSON.stringify({ reason })
            });
            window.alert(result.message);
            await loadRows();
          } catch (error) {
            window.alert(error.message);
          }
        }));
      };
      $('adminResultSearch').addEventListener('click', () => loadRows().catch(error => {
        $('adminResultTable').innerHTML = `<p class="error">${esc(error.message)}</p>`;
      }));
      await loadRows();
    } catch (error) {
      content.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p>`;
    }
  }

  document.querySelector('[data-tab="results"]')?.addEventListener('click', loadAdminAssessmentResults);
  $('xlsxExport')?.addEventListener('click', () => {
    window.location.assign('/api/assessment-results/admin/export.xlsx');
  });

  const teacherCreateTab = $('teacherCreateAssessmentTab');
  if (teacherCreateTab) {
    teacherCreateTab.addEventListener('click', () => {
      const form = $('teacherCreateForm');
      if (!form || form.querySelector('[name="result_release_at"]')) return;
      const label = document.createElement('label');
      label.innerHTML = 'Detailed result release time (optional)<input name="result_release_at" type="datetime-local">';
      form.querySelector('[name="max_attempts"]')?.closest('label')?.after(label);
      form.addEventListener('submit', () => {
        const releaseAt = form.elements.result_release_at;
        if (releaseAt?.value) releaseAt.value = releaseIso(releaseAt.value);
      }, true);
    });
  }

  const teacherResultsTab = $('teacherResultsTab');
  if (teacherResultsTab) teacherResultsTab.textContent = 'Assessment Results';
  if (teacherResultsTab) teacherResultsTab.onclick = loadTeacherAssessmentResults;
  const teacherFilters = document.querySelector('#teacherDashboard .filters-row');
  if (teacherFilters && !$('teacherResultSearch')) {
    const subjectLabel = document.createElement('label');
    subjectLabel.innerHTML = 'Subject<select id="teacherSubjectFilter"><option value="">All subjects</option></select>';
    teacherFilters.append(subjectLabel);
    const label = document.createElement('label');
    label.innerHTML = 'Search student<input id="teacherResultSearch" type="search" placeholder="Name, roll number, subject…">';
    teacherFilters.append(label);
    label.querySelector('input').addEventListener('input', () => {
      clearTimeout(teacherSearchTimer);
      teacherSearchTimer = setTimeout(loadTeacherAssessmentResults, 250);
    });
  }
  const adminTabs = document.querySelector('#admin [data-action-group="exports"]');
  if (adminTabs && !$('xlsxExport')) {
    const button = document.createElement('button');
    button.id = 'xlsxExport';
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = 'Export assessment results (.xlsx)';
    adminTabs.append(button);
  }
  $('xlsxExport')?.addEventListener('click', () => {
    const filters = new URLSearchParams();
    if ($('adminResultTeacher')?.value) filters.set('teacher', $('adminResultTeacher').value);
    if ($('adminResultAssessment')?.value) filters.set('assessment', $('adminResultAssessment').value);
    if ($('adminResultSubject')?.value.trim()) filters.set('subject', $('adminResultSubject').value.trim());
    if ($('adminResultStudent')?.value.trim()) filters.set('student', $('adminResultStudent').value.trim());
    window.location.assign(`/api/assessment-results/admin/export.xlsx?${filters}`);
  });

  if (typeof window.renderQuestion === 'function') {
    window.renderQuestion = () => {
      const question = state.questions[state.index];
      if (!question) return;
      const subject = question.question_type === 'subjective';
      const answerValue = subject ? question.selectedText || '' : state.answers[question.id];
      $('progressText').textContent = `Question ${state.index + 1} of ${state.questions.length}`;
      $('answeredText').textContent = `${Object.values(state.answers).filter(Boolean).length} answered`;
      $('progressBar').style.width = `${((state.index + 1) / state.questions.length) * 100}%`;
      $('questionText').textContent = question.question_text;
      $('options').innerHTML = subject
        ? `<label class="subjective-answer-label">Your written answer<textarea id="subjectiveAnswer" rows="6" maxlength="10000" placeholder="Enter your answer">${esc(answerValue)}</textarea></label><p class="muted small">Maximum marks: ${Number(question.marks || 1)}</p>`
        : question.options.map(option => `<label class="option ${state.answers[question.id] === option.id ? 'selected' : ''}"><input type="radio" name="answer" value="${option.id}" ${state.answers[question.id] === option.id ? 'checked' : ''}><span>${esc(option.option_text)}</span></label>`).join('');
      if (subject) {
        const input = $('subjectiveAnswer');
        let timer;
        input.addEventListener('input', () => {
          question.selectedText = input.value;
          state.answers[question.id] = input.value;
          clearTimeout(timer);
          timer = setTimeout(async () => {
            try {
              await api(`/api/exam/attempt/${encodeURIComponent(state.attemptId)}/answer`, {
                method: 'PUT',
                body: JSON.stringify({ questionId: question.id, textAnswer: input.value })
              });
              $('connectionStatus').textContent = 'Connected';
              $('examError').textContent = '';
            } catch (error) {
              $('examError').textContent = error.message;
            }
          }, 300);
        });
      } else {
        $('options').querySelectorAll('input').forEach(input => input.addEventListener('change', async () => {
          const optionId = Number(input.value);
          state.answers[question.id] = optionId;
          window.renderQuestion();
          try {
            await api(`/api/exam/attempt/${encodeURIComponent(state.attemptId)}/answer`, {
              method: 'PUT',
              body: JSON.stringify({ questionId: question.id, optionId })
            });
          } catch (error) {
            $('examError').textContent = error.message;
            $('connectionStatus').textContent = 'Answer save failed — reconnecting…';
          }
        }));
      }
      $('previous').disabled = state.index === 0;
      $('next').textContent = state.index === state.questions.length - 1 ? 'Last question' : 'Next';
      $('questionNav').innerHTML = state.questions.map((item, index) => {
        const answered = item.question_type === 'subjective'
          ? Boolean(item.selectedText || state.answers[item.id])
          : Boolean(state.answers[item.id]);
        return `<button class="${index === state.index ? 'current' : ''} ${answered ? 'answered' : ''}" data-index="${index}" aria-label="Question ${index + 1}">${index + 1}</button>`;
      }).join('');
      $('questionNav').querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
        state.index = Number(button.dataset.index);
        window.renderQuestion();
      }));
    };
  }
  if (typeof window.submitExam === 'function') {
    const originalSubmitExam = window.submitExam;
    window.submitExam = async auto => {
      const answer = $('subjectiveAnswer');
      if (answer && state.attemptId) {
        try {
          await api(`/api/exam/attempt/${encodeURIComponent(state.attemptId)}/answer`, {
            method: 'PUT',
            body: JSON.stringify({
              questionId: state.questions[state.index].id,
              textAnswer: answer.value
            })
          });
        } catch (error) {
          $('examError').textContent = error.message;
          return;
        }
      }
      originalSubmitExam(auto);
    };
  }

  const adminContent = $('adminContent');
  if (adminContent) {
    const enhanceAdminForms = () => {
      const questionForm = $('addQuestion');
      if (questionForm && questionForm.dataset.resultFields !== 'ready') {
        questionForm.dataset.resultFields = 'ready';
        const objectiveFields = document.createElement('div');
        objectiveFields.className = 'question-objective-fields';
        objectiveFields.innerHTML = '<h4>Objective answer options</h4>';
        [...questionForm.querySelectorAll('label')].filter(label => (
          label.querySelector('[name^="option"]') || label.querySelector('[name="correct_index"]')
        )).forEach(label => objectiveFields.append(label));
        const typeLabel = document.createElement('label');
        typeLabel.innerHTML = 'Question type<select name="question_type"><option value="objective">Objective (auto-marked)</option><option value="subjective">Subjective (manual evaluation)</option></select>';
        const marksLabel = document.createElement('label');
        marksLabel.innerHTML = 'Maximum marks<input name="marks" type="number" min="0.5" step="0.5" value="1" required>';
        const negativeLabel = document.createElement('label');
        negativeLabel.innerHTML = 'Negative marks for wrong answer<input name="negative_marks" type="number" min="0" step="0.5" value="0" required>';
        questionForm.querySelector('button[type="submit"],button:not([type])')?.before(typeLabel, marksLabel, negativeLabel, objectiveFields);
        const typeSelect = typeLabel.querySelector('select');
        const updateQuestionType = () => {
          const objective = typeSelect.value === 'objective';
          objectiveFields.classList.toggle('hidden', !objective);
          objectiveFields.querySelectorAll('input,select').forEach(input => {
            input.disabled = !objective;
            input.required = objective;
          });
          negativeLabel.classList.toggle('hidden', !objective);
          negativeLabel.querySelector('input').disabled = !objective;
        };
        typeSelect.addEventListener('change', updateQuestionType);
        updateQuestionType();
        questionForm.addEventListener('submit', async event => {
          event.preventDefault();
          event.stopImmediatePropagation();
          const form = new FormData(questionForm);
          const questionType = String(form.get('question_type'));
          try {
            await api(`/api/admin/assessments/${encodeURIComponent($('questionAssessment').value)}/questions`, {
              method: 'POST',
              body: JSON.stringify({
                question_text: form.get('question_text'),
                category: form.get('category'),
                question_type: questionType,
                marks: Number(form.get('marks')),
                negative_marks: questionType === 'objective' ? Number(form.get('negative_marks')) : 0,
                options: questionType === 'objective' ? [0, 1, 2, 3].map(index => form.get(`option${index}`)) : [],
                correct_index: Number(form.get('correct_index'))
              })
            });
            questionForm.reset();
            $('questionAssessment').dispatchEvent(new Event('change'));
          } catch (error) {
            window.alert(error.message);
          }
        }, true);
      }

      const createForm = $('createAssessmentForm');
      if (createForm && createForm.dataset.resultFields !== 'ready') {
        createForm.dataset.resultFields = 'ready';
        const subjectLabel = document.createElement('label');
        subjectLabel.innerHTML = 'Subject<input name="subject_name" maxlength="120" placeholder="Subject name">';
        const releaseLabel = document.createElement('label');
        releaseLabel.innerHTML = 'Detailed result release time (optional)<input name="result_release_at" type="datetime-local">';
        createForm.querySelector('button[type="submit"],button:not([type])')?.before(subjectLabel, releaseLabel);
        createForm.addEventListener('submit', async event => {
          event.preventDefault();
          event.stopImmediatePropagation();
          const form = new FormData(createForm);
          try {
            await api('/api/admin/assessments', {
              method: 'POST',
              body: JSON.stringify({
                title: form.get('title'),
                description: form.get('description'),
                subject_name: form.get('subject_name'),
                result_release_at: releaseIso(form.get('result_release_at')),
                academic_year: form.get('academic_year'),
                duration_minutes: Number(form.get('duration_minutes')),
                passing_percentage: Number(form.get('passing_percentage')),
                max_attempts: Number(form.get('max_attempts'))
              })
            });
            window.alert('Assessment created. Now select it in Question management to add questions.');
            document.querySelector('[data-tab="settings"]').click();
          } catch (error) {
            window.alert(error.message);
          }
        }, true);
      }

      const settingsForm = $('settingsForm');
      if (settingsForm && settingsForm.dataset.resultFields !== 'ready') {
        settingsForm.dataset.resultFields = 'ready';
        const subjectLabel = document.createElement('label');
        subjectLabel.innerHTML = 'Subject<input name="subject_name" maxlength="120" placeholder="Subject name">';
        const releaseLabel = document.createElement('label');
        releaseLabel.innerHTML = 'Detailed result release time<input name="result_release_at" type="datetime-local">';
        settingsForm.querySelector('[name="academic_year"]')?.closest('label')?.after(subjectLabel, releaseLabel);
        const originalChange = settingsForm.elements.id.onchange;
        settingsForm.elements.id.onchange = event => {
          if (originalChange) originalChange.call(settingsForm.elements.id, event);
          api('/api/admin/assessments').then(rows => {
            const assessment = rows.find(item => Number(item.id) === Number(settingsForm.elements.id.value));
            if (!assessment) return;
            settingsForm.elements.subject_name.value = assessment.subject_name || '';
            settingsForm.elements.result_release_at.value = releaseLocal(assessment.result_release_at);
          }).catch(error => window.console.error('Unable to load assessment result settings:', error));
        };
        settingsForm.elements.id.dispatchEvent(new Event('change'));
        settingsForm.addEventListener('submit', async event => {
          event.preventDefault();
          event.stopImmediatePropagation();
          const form = new FormData(settingsForm);
          const body = {};
          for (const key of ['title', 'academic_year', 'subject_name', 'result_release_at']) {
            body[key] = key === 'result_release_at'
              ? releaseIso(form.get(key))
              : form.get(key);
          }
          for (const key of ['duration_minutes', 'passing_percentage', 'max_attempts', 'enabled', 'auto_submit_tab_switch', 'auto_submit_fullscreen_exit', 'maximum_warnings']) {
            body[key] = Number(form.get(key));
          }
          try {
            await api(`/api/admin/assessments/${encodeURIComponent(form.get('id'))}`, {
              method: 'PATCH',
              body: JSON.stringify(body)
            });
            window.alert('Settings saved.');
          } catch (error) {
            window.alert(error.message);
          }
        }, true);
      }
    };
    new MutationObserver(enhanceAdminForms).observe(adminContent, { childList: true, subtree: true });
  }
})();
