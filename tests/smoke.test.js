const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('portal metadata, marks workflow, and core entrypoints exist', () => {
  for (const file of [
    'package.json',
    'backend/database/schema.sql',
    'backend/app.js',
    'backend/scripts/seed.js',
    'backend/routes/teacherAuth.js',
    'backend/scripts/initializeAccounts.js',
    'backend/routes/marksRoutes.js',
    'backend/database/migrations.js',
    'frontend/index.html',
    'frontend/scripts/app.js',
    'frontend/components/admin.js',
    'frontend/components/marks.js',
    'frontend/styles/style.css',
    'frontend/assets/zero-technologies-logo.png'
  ]) {
    assert.ok(fs.existsSync(path.join(root, file)), `missing ${file}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.equal(packageJson.name, 'certified-developer-test');
  assert.equal(packageJson.main, 'backend/app.js');
  assert.equal(packageJson.scripts.start, 'node backend/app.js');
  assert.ok(packageJson.scripts['initialize-accounts']);

  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  for (const id of [
    'studentViewCreditMarks',
    'studentViewSemesterMarks',
    'studentViewOnlineResults',
    'markCategory',
    'saveAcademicMarks'
  ]) {
    assert.ok(html.includes(id), `missing UI element ${id}`);
  }

  const migration = fs.readFileSync(path.join(root, 'backend/database/migrations.js'), 'utf8');
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS academic_marks'));
  const appJs = fs.readFileSync(path.join(root, 'frontend/scripts/app.js'), 'utf8');
  assert.ok(appJs.includes("loginHeader.classList.toggle('hidden'"));
  assert.ok(appJs.includes('hodAllMarksTab'));
  const marksRoutes = fs.readFileSync(path.join(root, 'backend/routes/marksRoutes.js'), 'utf8');
  assert.ok(marksRoutes.includes("router.get('/hod/all'"));
});

test('Express serves frontend files from the frontend folder', async () => {
  const request = require('supertest');
  const app = require('../backend/app');

  const homepage = await request(app).get('/');
  assert.equal(homepage.status, 200);
  assert.match(homepage.text, /RCPET IMRD AEP/);

  const script = await request(app).get('/scripts/app.js');
  assert.equal(script.status, 200);
  assert.match(script.text, /loginHeader/);
});

test('ZERO TECHNOLOGIES branding and certificate assets are available', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  assert.ok(html.includes('/assets/zero-technologies-logo-cropped.png'));
  assert.ok(html.includes('Powered by ZERO TECHNOLOGIES'));
  const email = fs.readFileSync(path.join(root, 'backend/routes/passwordReset.js'), 'utf8');
  assert.ok(email.includes('RCPET IMRD AEP password reset code'));
  assert.ok(email.includes('Powered by ZERO TECHNOLOGIES'));
  assert.ok(!email.includes('ZERO ENGINEER'));

  for (const asset of [
    'zero-technologies-logo.png',
    'zero-technologies-certificate.png',
    'zero-technologies-promo.png'
  ]) {
    assert.ok(fs.existsSync(path.join(root, 'frontend/assets', asset)), `missing frontend/assets/${asset}`);
  }
  assert.ok(fs.existsSync(path.join(root, 'frontend/assets/zero-technologies-logo-cropped.png')));
});

test('institute name uses official RCPET spacing across portal and generated messages', () => {
  const spacedName = /\bR\s*\.?\s*C(?:\s+|\.\s*)P\s*\.?\s*E\s*\.?\s*T\b/i;
  for (const file of ['frontend/index.html', 'backend/routes/studentAuth.js', 'backend/routes/passwordReset.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), spacedName, `incorrect institute name in ${file}`);
  }
});

test('admin actions are grouped and both export formats remain available', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  for (const heading of [
    'Assessment management',
    'Student management',
    'Teacher management',
    'Academic management',
    'Data export'
  ]) {
    assert.ok(html.includes(heading), `missing ${heading} group`);
  }
  for (const action of [
    'Results',
    'Questions',
    'Assessment settings',
    'Manage candidates',
    'Student accounts',
    'Teacher database',
    'Export CSV for Excel'
  ]) {
    assert.ok(html.includes(action), `missing ${action} action`);
  }
  assert.ok(html.includes('data-action-group="academic"'));
  assert.ok(html.includes('data-action-group="exports"'));
  const admin = fs.readFileSync(path.join(root, 'frontend/components/admin-students.js'), 'utf8');
  assert.ok(admin.includes("'/api/admin/results.csv'"));
  const exporter = fs.readFileSync(path.join(root, 'frontend/components/assessment-results.js'), 'utf8');
  assert.ok(exporter.includes('Export assessment results (.xlsx)'));
  assert.ok(exporter.includes('/api/assessment-results/admin/export.xlsx'));
  assert.ok(exporter.includes('[data-action-group="exports"]'));
});

test('login and student dashboard use the uploaded RCPET campus photograph', () => {
  const asset = path.join(root, 'frontend/assets/rcpet-imrd-college-gardens.png');
  assert.ok(fs.existsSync(asset));
  assert.ok(fs.statSync(asset).size > 100000);
  for (const file of ['frontend/styles/style.css', 'frontend/styles/final-reference-ui.css']) {
    const css = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(css.includes('/assets/rcpet-imrd-college-gardens.png'), `missing new campus image reference in ${file}`);
    assert.ok(!css.includes('rcpet-imrd-campus-hd.png'), `stale campus image reference in ${file}`);
  }
  const css = fs.readFileSync(path.join(root, 'frontend/styles/final-reference-ui.css'), 'utf8');
  assert.ok(css.includes('background-size:cover!important'));
  assert.ok(css.includes('background-attachment:scroll!important'));
});
