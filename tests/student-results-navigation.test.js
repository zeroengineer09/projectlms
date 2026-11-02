const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('student results navigation has one collapsible parent and exactly three result views', () => {
  const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'frontend', 'js', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'frontend', 'css', 'style.css'), 'utf8');
  const menuStart = html.indexOf('<div id="studentResultsSubmenu"');
  const menuEnd = html.indexOf('<button class="student-nav" data-student-view="teachers"', menuStart);

  assert.notEqual(menuStart, -1, 'Results submenu should exist');
  assert.notEqual(menuEnd, -1, 'Results submenu should precede My Teachers');
  const submenu = html.slice(menuStart, menuEnd);
  assert.deepEqual(
    [...submenu.matchAll(/data-student-view="([^"]+)"/g)].map(match => match[1]),
    ['creditMarks', 'semesterMarks', 'onlineResults']
  );
  assert.match(html, /aria-controls="studentResultsSubmenu"/);
  assert.match(app, /submenu\.classList\.toggle\('is-collapsed',expanded\)/);
  assert.match(app, /submenu\.inert=expanded/);
  assert.match(submenu, /class="results-submenu-content"/);
  assert.match(css, /\.results-submenu\{display:grid;grid-template-rows:1fr/);
  assert.match(css, /\.results-submenu\.is-collapsed\{grid-template-rows:0fr/);
  assert.match(css, /\.results-submenu-content\{min-height:0;overflow:hidden\}/);
  assert.doesNotMatch(html, /data-student-view="[^"]*TestResults|id="studentViewAssessmentResults"/i);
  assert.doesNotMatch(html, />\s*My Test Results\s*</i);
});
