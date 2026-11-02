(function () {
  const $ = id => document.getElementById(id);
  const api = window.api || (async (url, opts = {}) => {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'Request failed');
    return data;
  });
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  window.loadAcademicMarks = async function (category) {
    const box = $(category === 'credit' ? 'studentCreditMarksList' : 'studentSemesterMarksList');
    if (!box) return;
    box.innerHTML = '<p class="muted">Loading published marks…</p>';
    try {
      const rows = await api('/api/marks/student/' + category);
      if (!rows.length) {
        box.innerHTML = `<div class="student-content-card"><h3>No published marks yet</h3>
          <p class="muted">Your teacher has not published any ${category === 'credit' ? 'credit test' : 'semester exam'} marks for you.</p></div>`;
        return;
      }
      box.innerHTML = rows.map(row => `<article class="student-data-card marks-result-card">
        <div class="student-data-icon">✓</div><div class="student-data-main">
        <h3>${escapeHtml(row.subject_name)}</h3>
        <p>${escapeHtml(row.title)}${row.semester ? ' · ' + escapeHtml(row.semester) : ''}${row.exam_date ? ' · ' + escapeHtml(row.exam_date) : ''}</p>
        <div class="student-meta"><span>Marks: ${Number(row.marks_obtained)}/${Number(row.max_marks)}</span>
        <span>Percentage: ${Number(row.percentage).toFixed(1)}%</span>
        ${category === 'semester' && row.semester ? `<span>Semester: ${escapeHtml(row.semester)}</span>` : ''}
        <span>Published: ${escapeHtml(row.publication_date ? new Date(row.publication_date).toLocaleDateString() : '—')}</span></div></div></article>`).join('');
    } catch (error) {
      box.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    }
  };

  const category = $('markCategory');
  const year = $('markYear');
  const subject = $('markSubject');
  const division = $('markDivision');
  const student = $('markStudent');
  const semesterWrap = $('markSemesterWrap');
  const message = $('markMessage');
  const saveButton = $('saveAcademicMarks');
  let cancelButton = $('cancelEditAcademicMarks');
  if (!category || !year || !subject || !student || !saveButton) return;
  if (!cancelButton) {
    cancelButton = document.createElement('button');
    cancelButton.id = 'cancelEditAcademicMarks';
    cancelButton.type = 'button';
    cancelButton.className = 'secondary hidden';
    cancelButton.textContent = 'Cancel edit';
    saveButton.insertAdjacentElement('afterend', cancelButton);
  }

  let roster = [];
  let editingId = null;

  async function loadSubjects() {
    try {
      const list = await api('/api/marks/teacher/subjects');
      const eligible = list.filter(item => item.academic_year === year.value);
      subject.innerHTML = eligible.length
        ? eligible.map(item => `<option value="${escapeHtml(item.subject_name)}">${escapeHtml(item.subject_name)}</option>`).join('')
        : '<option value="">No subjects assigned for this year</option>';
      await loadRoster();
    } catch (error) {
      subject.innerHTML = '<option value="">Unable to load subjects</option>';
      message.textContent = error.message;
    }
  }

  async function loadRoster() {
    student.innerHTML = '<option value="">Loading students…</option>';
    try {
      if (!subject.value) {
        student.innerHTML = '<option value="">Choose an assigned subject</option>';
        roster = [];
        return;
      }
      roster = await api('/api/marks/teacher/roster?year='
        + encodeURIComponent(year.value) + '&subject=' + encodeURIComponent(subject.value));
      renderRoster();
    } catch (error) {
      student.innerHTML = '<option value="">Unable to load students</option>';
      message.textContent = error.message;
    }
  }

  function renderRoster() {
    const filtered = roster.filter(item => !division.value || item.division === division.value);
    student.innerHTML = filtered.length
      ? filtered.map(item => `<option value="${item.id}">${escapeHtml(item.full_name)} · Roll ${escapeHtml(item.roll_number || '—')} · Div ${escapeHtml(item.division || '—')}</option>`).join('')
      : '<option value="">No students in this division</option>';
  }

  function setEditMode(enabled) {
    saveButton.textContent = enabled ? 'Update marks' : 'Save marks';
    if (cancelButton) cancelButton.classList.toggle('hidden', !enabled);
  }

  function resetForm() {
    editingId = null;
    category.value = 'credit';
    category.dispatchEvent(new Event('change'));
    $('markTitle').value = '';
    $('markSemester').value = '';
    $('markDate').value = '';
    $('markMax').value = '20';
    $('markObtained').value = '';
    $('markPublish').checked = false;
    division.value = '';
    setEditMode(false);
    renderRoster();
  }

  async function beginEdit(record) {
    editingId = Number(record.id);
    category.value = record.category;
    category.dispatchEvent(new Event('change'));
    year.value = record.academic_year;
    await loadSubjects();
    subject.value = record.subject_name;
    division.value = record.division || '';
    await loadRoster();
    student.value = String(record.student_id);
    $('markTitle').value = record.title;
    $('markSemester').value = record.semester || '';
    $('markDate').value = record.exam_date || '';
    $('markMax').value = record.max_marks;
    $('markObtained').value = record.marks_obtained;
    $('markPublish').checked = Boolean(record.published);
    setEditMode(true);
    message.className = 'muted';
    message.textContent = 'Editing marks for ' + record.student_name + '.';
    $('markTitle').focus();
  }

  function confirmDelete() {
    return new Promise(resolve => {
      let dialog = $('deleteAcademicMarksDialog');
      if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.id = 'deleteAcademicMarksDialog';
        dialog.className = 'marks-confirm-dialog';
        dialog.innerHTML = `<form method="dialog"><h3>Delete marks?</h3>
          <p>Are you sure you want to delete these marks? This action cannot be undone.</p>
          <div class="actions"><button value="cancel" class="secondary">Cancel</button>
          <button value="confirm" class="danger">Confirm Delete</button></div></form>`;
        document.body.appendChild(dialog);
      }
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal();
    });
  }

  category.addEventListener('change', () => {
    semesterWrap.classList.toggle('hidden', category.value !== 'semester');
  });
  year.addEventListener('change', loadSubjects);
  subject.addEventListener('change', loadRoster);
  division.addEventListener('change', renderRoster);
  if (cancelButton) cancelButton.addEventListener('click', () => {
    resetForm();
    message.className = 'muted';
    message.textContent = 'Edit cancelled.';
  });

  saveButton.addEventListener('click', async () => {
    message.className = 'muted';
    message.textContent = editingId ? 'Updating marks…' : 'Saving marks…';
    const payload = {
      category: category.value,
      academic_year: year.value,
      subject_name: subject.value,
      division: division.value,
      title: $('markTitle').value.trim(),
      semester: $('markSemester').value.trim(),
      exam_date: $('markDate').value,
      student_id: Number(student.value),
      marks_obtained: Number($('markObtained').value),
      max_marks: Number($('markMax').value),
      published: $('markPublish').checked
    };
    if (!payload.subject_name || !payload.title || !payload.student_id
      || !Number.isFinite(payload.marks_obtained) || !Number.isFinite(payload.max_marks)
      || payload.max_marks <= 0 || payload.marks_obtained < 0
      || payload.marks_obtained > payload.max_marks
      || (payload.category === 'semester' && !payload.semester)) {
      message.className = 'error';
      message.textContent = 'Please complete all required fields and enter valid marks.';
      return;
    }
    try {
      const endpoint = editingId ? `/api/marks/teacher/${editingId}` : '/api/marks/teacher';
      const result = await api(endpoint, {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify(payload)
      });
      resetForm();
      message.className = 'success';
      message.textContent = result.message;
      await loadTeacherMarks();
    } catch (error) {
      message.className = 'error';
      message.textContent = error.message;
    }
  });

  async function loadTeacherMarks() {
    const box = $('teacherAcademicMarksList');
    if (!box) return;
    try {
      const rows = await api('/api/marks/teacher');
      box.innerHTML = rows.length
        ? '<h3>Recently entered marks</h3>' + rows.map(row => `<article class="student-data-card marks-teacher-card">
          <div class="student-data-main"><h3>${escapeHtml(row.student_name)} · ${escapeHtml(row.subject_name)}</h3>
          <p>${escapeHtml(row.title)} · ${row.category === 'credit' ? 'Credit Test' : 'Semester Exam'}${row.semester ? ' · ' + escapeHtml(row.semester) : ''}</p>
          <div class="student-meta"><span>${Number(row.marks_obtained)}/${Number(row.max_marks)}</span>
          <span>${row.published ? 'Published' : 'Draft'}</span><span>Roll ${escapeHtml(row.roll_number || '—')}</span></div></div>
          <div class="marks-card-actions">${row.published ? '' : `<button class="secondary publish-mark" data-id="${row.id}">Publish</button>`}
          <button class="secondary edit-mark" data-id="${row.id}">Edit Marks</button>
          <button class="danger delete-mark" data-id="${row.id}">Delete Marks</button></div></article>`).join('')
        : '<p class="muted">No marks entered yet.</p>';

      box.querySelectorAll('.publish-mark').forEach(button => button.addEventListener('click', async () => {
        try {
          await api('/api/marks/teacher/' + button.dataset.id + '/publish', { method: 'PATCH', body: '{}' });
          await loadTeacherMarks();
        } catch (error) {
          message.className = 'error';
          message.textContent = error.message;
        }
      }));
      box.querySelectorAll('.edit-mark').forEach(button => button.addEventListener('click', () => {
        const record = rows.find(item => String(item.id) === button.dataset.id);
        if (record) beginEdit(record).catch(error => {
          message.className = 'error';
          message.textContent = error.message;
        });
      }));
      box.querySelectorAll('.delete-mark').forEach(button => button.addEventListener('click', async () => {
        if (!await confirmDelete()) return;
        try {
          const result = await api('/api/marks/teacher/' + button.dataset.id, { method: 'DELETE' });
          message.className = 'success';
          message.textContent = result.message;
          if (String(editingId) === button.dataset.id) resetForm();
          await loadTeacherMarks();
        } catch (error) {
          message.className = 'error';
          message.textContent = error.message;
        }
      }));
    } catch (error) {
      box.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    }
  }

  let teacherDataLoaded = false;
  const dashboard = document.getElementById('teacherDashboard');
  const refreshTeacherData = () => {
    if (dashboard && !dashboard.classList.contains('hidden') && !teacherDataLoaded) {
      teacherDataLoaded = true;
      loadSubjects();
      loadTeacherMarks();
    }
  };
  if (dashboard) {
    new MutationObserver(() => {
      if (dashboard.classList.contains('hidden')) teacherDataLoaded = false;
      else refreshTeacherData();
    }).observe(dashboard, { attributes: true, attributeFilter: ['class'] });
    refreshTeacherData();
  }
})();
