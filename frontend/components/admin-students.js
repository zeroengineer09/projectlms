(() => {
  const tab = document.querySelector('#admin [data-tab="students"]');
  const content = document.getElementById('adminContent');
  if (!tab || !content) return;

  const academicActions = document.querySelector('#admin [data-action-group="academic"]');
  const academicMarksTab = document.querySelector('#admin [data-tab="academic-marks"]');
  if (academicActions && academicMarksTab) academicActions.append(academicMarksTab);

  document.getElementById('admin').addEventListener('click', event => {
    const selected = event.target.closest('.admin-action-groups [data-tab]');
    if (!selected) return;
    document.querySelectorAll('.admin-action-groups [data-tab]').forEach(button => {
      const active = button === selected;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  });

  document.getElementById('csvExport')?.addEventListener('click', () => {
    window.location.assign('/api/admin/results.csv');
  });

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Student account request failed.');
    return result;
  }

  async function renderStudents(search = '') {
    content.innerHTML = '<p class="muted" role="status">Loading student accounts…</p>';
    try {
      const [students, attendance, notices] = await Promise.all([
        request(`/api/admin/students?q=${encodeURIComponent(search)}`),
        request('/api/admin/students/attendance'),
        request('/api/admin/students/notices')
      ]);
      content.innerHTML = `
        <h3>Student accounts</h3>
        <form id="studentAccountSearch" class="filters-row">
          <label>Search by name, roll number or email
            <input name="q" type="search" maxlength="100" value="${escapeHtml(search)}" placeholder="Name, roll number or email">
          </label>
          <button class="secondary">Search</button>
        </form>
        <p class="muted small">${students.length} student account(s)${students.length === 500 ? ' (showing the first 500)' : ''}. Passwords and hashes are never listed.</p>
        <div class="table-wrap"><table class="admin-table">
          <thead><tr><th>Student</th><th>Email</th><th>Roll no.</th><th>Division</th><th>Practical batch</th><th>Status</th><th>First login change</th><th>Actions</th></tr></thead>
          <tbody>${students.map(student => `<tr>
            <td>${escapeHtml(student.full_name)}</td><td>${escapeHtml(student.email)}</td>
            <td>${escapeHtml(student.roll_number || student.student_number || '—')}</td>
            <td>${escapeHtml(student.division || '—')}</td><td>${escapeHtml(student.practical_batch || '—')}</td>
            <td>${Number(student.active) ? 'Active' : 'Inactive'}</td>
            <td>${Number(student.must_change_password) ? 'Required' : 'Complete'}</td>
            <td><button class="secondary" type="button" data-edit-student="${student.id}">Edit</button>
              <button class="secondary" type="button" data-reset-student="${student.id}">Reset password</button></td>
          </tr>`).join('') || '<tr><td colspan="8">No registered student accounts found.</td></tr>'}</tbody>
        </table></div>
        <form id="studentAccountEdit" class="admin-form hidden">
          <h4>Edit student account</h4><input name="id" type="hidden">
          <label>Full name<input name="fullName" maxlength="120" required></label>
          <label>Registered email<input name="email" type="email" maxlength="254" required></label>
          <label>Roll number<input name="rollNumber" maxlength="40"></label>
          <label>Division<input name="division" maxlength="20"></label>
          <label>Practical batch<input name="practicalBatch" maxlength="40"></label>
          <label>Academic year<select name="academicYear"><option value="">Not specified</option><option>FY</option><option>SY</option><option>TY</option></select></label>
          <label>Account status<select name="active"><option value="1">Active</option><option value="0">Inactive</option></select></label>
          <button class="primary">Save student details</button>
          <button id="cancelStudentEdit" class="secondary" type="button">Cancel</button>
          <p id="studentAccountMessage" role="status"></p>
        </form>
        <p id="studentResetMessage" role="status"></p>
        <hr><h3>Attendance</h3>
        <form id="studentAttendanceForm" class="admin-form">
          <label>Student<select name="studentId" required>${students.map(student => `<option value="${student.id}">${escapeHtml(student.full_name)} · ${escapeHtml(student.roll_number || '—')}</option>`).join('')}</select></label>
          <label>Date<input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label>
          <label>Status<select name="status"><option value="present">Present</option><option value="absent">Absent</option><option value="late">Late</option></select></label>
          <label>Note<input name="note" maxlength="300"></label>
          <button class="primary">Save attendance</button><p id="studentAttendanceMessage" role="status"></p>
        </form>
        <div class="table-wrap"><table class="admin-table"><thead><tr><th>Student</th><th>Roll</th><th>Date</th><th>Status</th><th>Note</th></tr></thead>
          <tbody>${attendance.map(record => `<tr><td>${escapeHtml(record.full_name)}</td><td>${escapeHtml(record.roll_number || '—')}</td><td>${escapeHtml(record.attendance_date)}</td><td>${escapeHtml(record.status)}</td><td>${escapeHtml(record.note || '—')}</td></tr>`).join('') || '<tr><td colspan="5">No attendance recorded.</td></tr>'}</tbody>
        </table></div>
        <hr><h3>Notices &amp; academic updates</h3>
        <form id="studentNoticeForm" class="admin-form">
          <label>Title<input name="title" maxlength="120" required></label>
          <label class="wide">Notice text<textarea name="body" maxlength="2000" required></textarea></label>
          <label>Visibility<select name="published"><option value="1">Publish now</option><option value="0">Keep as draft</option></select></label>
          <button class="primary">Create notice</button><p id="studentNoticeMessage" role="status"></p>
        </form>
        <div class="table-wrap"><table class="admin-table"><thead><tr><th>Title</th><th>Notice</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>${notices.map(notice => `<tr><td>${escapeHtml(notice.title)}</td><td>${escapeHtml(notice.body)}</td><td>${Number(notice.published) ? 'Published' : 'Draft'}</td><td><button class="secondary" type="button" data-toggle-notice="${notice.id}" data-published="${Number(notice.published) ? 0 : 1}">${Number(notice.published) ? 'Unpublish' : 'Publish'}</button></td></tr>`).join('') || '<tr><td colspan="4">No notices created.</td></tr>'}</tbody>
        </table></div>`;

      content.querySelector('#studentAccountSearch').onsubmit = event => {
        event.preventDefault();
        renderStudents(new FormData(event.currentTarget).get('q').trim());
      };

      const editForm = content.querySelector('#studentAccountEdit');
      const editMessage = content.querySelector('#studentAccountMessage');
      content.querySelectorAll('[data-edit-student]').forEach(button => {
        button.onclick = () => {
          const student = students.find(item => String(item.id) === button.dataset.editStudent);
          if (!student) return;
          editForm.classList.remove('hidden');
          for (const [field, key] of Object.entries({
            id: 'id', fullName: 'full_name', email: 'email',
            rollNumber: 'roll_number', division: 'division',
            practicalBatch: 'practical_batch', academicYear: 'academic_year', active: 'active'
          })) editForm.elements[field].value = student[key] ?? '';
          editForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
      });

      editForm.onsubmit = async event => {
        event.preventDefault();
        const data = new FormData(editForm);
        const id = data.get('id');
        const body = Object.fromEntries(['fullName', 'email', 'rollNumber', 'division', 'practicalBatch', 'academicYear']
          .map(key => [key, data.get(key)]));
        body.active = Number(data.get('active'));
        try {
          await request(`/api/admin/students/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
          await renderStudents(search);
        } catch (error) {
          editMessage.className = 'error';
          editMessage.textContent = error.message;
        }
      };

      content.querySelector('#cancelStudentEdit').onclick = () => editForm.classList.add('hidden');
      const attendanceForm = content.querySelector('#studentAttendanceForm');
      attendanceForm.onsubmit = async event => {
        event.preventDefault();
        const message = content.querySelector('#studentAttendanceMessage');
        const values = Object.fromEntries(new FormData(attendanceForm));
        values.studentId = Number(values.studentId);
        try {
          await request('/api/admin/students/attendance', { method: 'POST', body: JSON.stringify(values) });
          await renderStudents(search);
        } catch (error) {
          message.className = 'error';
          message.textContent = error.message;
        }
      };

      const noticeForm = content.querySelector('#studentNoticeForm');
      noticeForm.onsubmit = async event => {
        event.preventDefault();
        const message = content.querySelector('#studentNoticeMessage');
        const values = Object.fromEntries(new FormData(noticeForm));
        values.published = Number(values.published);
        try {
          await request('/api/admin/students/notices', { method: 'POST', body: JSON.stringify(values) });
          await renderStudents(search);
        } catch (error) {
          message.className = 'error';
          message.textContent = error.message;
        }
      };
      content.querySelectorAll('[data-toggle-notice]').forEach(button => {
        button.onclick = async () => {
          try {
            await request(`/api/admin/students/notices/${button.dataset.toggleNotice}`, {
              method: 'PATCH',
              body: JSON.stringify({ published: Number(button.dataset.published) })
            });
            await renderStudents(search);
          } catch (error) {
            alert(error.message);
          }
        };
      });

      content.querySelectorAll('[data-reset-student]').forEach(button => {
        button.onclick = async () => {
          if (!confirm('Reset this student password? A new temporary password will be shown once and must be changed at first login.')) return;
          const message = content.querySelector('#studentResetMessage');
          try {
            const result = await request(`/api/admin/students/${button.dataset.resetStudent}/reset-password`, {
              method: 'POST', body: '{}'
            });
            message.className = 'success';
            message.textContent = `Temporary password (share securely; shown only once): ${result.temporaryPassword}`;
            await renderStudents(search);
            const refreshedMessage = content.querySelector('#studentResetMessage');
            refreshedMessage.className = 'success';
            refreshedMessage.textContent = `Temporary password (share securely; shown only once): ${result.temporaryPassword}`;
          } catch (error) {
            message.className = 'error';
            message.textContent = error.message;
          }
        };
      });
    } catch (error) {
      content.innerHTML = `<p class="error" role="alert">${escapeHtml(error.message)}</p>`;
    }
  }

  tab.onclick = () => renderStudents();
})();
