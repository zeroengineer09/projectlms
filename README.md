# projectlms

## RCPET IMRD AEP — Academic Excellence Portal

Powered by ZERO TECHNOLOGIES.

## Project structure and local startup

- `frontend/` contains the browser application and static assets.
- `backend/` contains the Express application, API routes, and account/database scripts.
- `database/` contains the SQLite database and schema.

Run commands from the repository root. Install dependencies with `npm install`, then start the site with `npm start`; the backend serves the frontend on port 3000 by default.

## Account restoration and roster import

Copy `.env.example` to `.env.local` for local development and configure secrets there, or use your deployment secret store. `.env.local` is ignored by Git. Never commit credentials or put initial passwords in source code. `OWNER_INITIAL_PASSWORD`, `STUDENT_INITIAL_PASSWORD`, and `TEACHER_INITIAL_PASSWORD` are read only by explicit account setup/import commands; application startup does not seed or reset user passwords.

The owner initializer is create-only:

```sh
npm run initialize-accounts
```

It creates the fixed owner account `kaushalpatil927@gmail.com` only when that account is absent, marks a new account for a first-login password change, and preserves every existing administrator credential. There is no public administrator registration route.

Import the original roster files explicitly. The teacher workbook must contain a `Teacher Accounts` worksheet with teacher name and login email columns. Student rosters may be `.xlsx` or `.csv`; include name and registered email, and provide student ID, class/year, division, roll number, admission year, and practical batch columns whenever they exist in the source:

```sh
npm run import-students -- path/to/student-roster.xlsx
npm run import-teachers -- path/to/teacher-directory.xlsx
```

Imports are safe to rerun: students match by registered email or roll/student number, duplicate/invalid rows are reported by row number, and every existing student's password, first-login state, and active/inactive status are preserved. Only newly created student accounts receive the configured initial password; it is bcrypt-hashed and must be changed on first login. IDs, departments, academic year, and other missing source fields are not guessed.

Administrators can search student accounts by name, roll number, or email, edit profile details, activate/deactivate accounts, and generate a one-time temporary password reset that requires a first-login change. Password hashes are never shown.

Administrators can also record per-student attendance and publish/draft student notices from the student-account panel. A student's dashboard reads only their own attendance and private academic records; published notices are shared with all students. Attendance and notices remain empty until administrators enter real records.

Student and teacher sign-in accepts the registered email or imported ID. First-login password changes are enforced by the server before protected dashboards are available.

## Email OTP password recovery

Student, teacher, and administrator login pages provide a **Forgot password?** flow. Six-digit OTPs are HMAC-hashed before storage, expire after 5 minutes, allow at most 5 incorrect attempts, and can be resent once per 60 seconds. Password updates and OTP consumption are committed together; account recovery responses do not disclose whether an email is registered.

To enable email delivery, configure these deployment environment variables using your SMTP provider and a sender address verified by that provider:

- `PASSWORD_RESET_PEPPER` (a unique random secret of at least 32 characters; if omitted, the server uses `SESSION_SECRET`)
- `SMTP_HOST` (for Gmail, `smtp.gmail.com`)
- `SMTP_PORT` (`465` with implicit TLS or `587` with STARTTLS)
- `SMTP_SECURE` (`true` for port 465; `false` for port 587)
- `SMTP_USER`
- `SMTP_PASS` (a Gmail app password, not the Google account password)
- `MAIL_FROM` (a sender address verified for the Gmail account)

Nodemailer requires valid TLS certificates (certificate verification cannot be disabled). Do not commit `PASSWORD_RESET_PEPPER` or SMTP credentials. Missing SMTP settings return a generic service-unavailable message; delivery failures are logged on the server and do not disclose account existence.
