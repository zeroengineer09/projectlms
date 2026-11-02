const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('student welcome banner has no photo while profile photo support remains', () => {
  const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'frontend', 'js', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'frontend', 'css', 'style.css'), 'utf8');
  const dashboard = html.match(/<div id="studentViewDashboard"[^>]*>([\s\S]*?)<\/div>\s*<div id="studentViewAssessments"/);

  assert.ok(dashboard, 'student dashboard markup should exist');
  assert.doesNotMatch(dashboard[1], /<img\b|studentDashboardPhoto|student-dashboard-photo/i);
  assert.doesNotMatch(css, /student-dashboard-photo|student-welcome-card img/);
  assert.doesNotMatch(js, /getElementById\(['"]studentDashboardPhoto['"]\)/);
  assert.match(html, /id="studentPhotoPreview"/);
  assert.match(js, /getElementById\(['"]studentPhotoPreview['"]\)/);
  assert.match(html, /id="portalHeaderAvatar" class="portal-user-avatar"/);
  assert.match(js, /applyStudentPhoto\(p\.profilePhoto\)/);
  assert.match(js, /document\.getElementById\('portalHeaderAvatar'\)/);
  assert.match(js, /profile-photo/);
  assert.match(css, /\.portal-user-avatar\{[^}]*object-fit:cover[^}]*border-radius:50%/);
});
