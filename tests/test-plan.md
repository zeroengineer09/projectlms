# Test plan and current coverage

## Automated checks
- `npm test` runs Node's built-in test runner. The current automated smoke test checks basic package/module availability and is intentionally not a substitute for end-to-end tests.
- `npm run init-db` initializes schema and seeds the default assessment; it prints the number of seeded questions.

## Manual acceptance checklist
- [ ] Server starts and `/health` returns `ok: true`.
- [ ] Admin can log in; invalid credentials are rejected and rate-limited.
- [ ] Student registration validates name/email and attempt limits.
- [ ] Instructions agreement is required by the UI.
- [ ] Exactly 50 seeded questions exist.
- [ ] Timer follows the server deadline across refresh.
- [ ] Answers persist in SQLite; server calculates result.
- [ ] Duplicate submissions do not overwrite completed result.
- [ ] Correct answers are absent from student exam JSON.
- [ ] Tab/fullscreen policy violations are logged.
- [ ] Passing students receive a unique certificate record.
- [ ] Certificate preview and PNG use the same canvas renderer.
- [ ] Admin question/settings/result screens and CSV export work.
- [ ] Test mobile widths 360, 390, 768, 1024, 1366 and 1920 pixels.

Security note: browser-based tab and fullscreen checks are deterrents, not tamper-proof kiosk controls. Use HTTPS and a strong session secret in production.
