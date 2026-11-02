const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const database = require('../database');

const ACCOUNT_TABLES = {
  student: { table: 'student_accounts', identifier: 'email', active: true },
  teacher: { table: 'teachers', identifier: 'email', active: true },
  admin: { table: 'administrators', identifier: 'username', active: false }
};
const GENERIC_REQUEST_MESSAGE = 'If an active account matches that email, a verification code has been sent.';
const INVALID_CODE_MESSAGE = 'That code is invalid or expired. Request a new code and try again.';
const SMTP_FAILURE_MESSAGE = 'Password recovery is temporarily unavailable. Please try again later.';
const PASSWORD_POLICIES = {
  student: { minimum: 8, description: 'at least 8 characters and include uppercase, lowercase and a number.' },
  teacher: { minimum: 12, description: 'at least 12 characters and include uppercase, lowercase and a number.' },
  admin: { minimum: 12, description: 'at least 12 characters and include uppercase, lowercase and a number.' }
};

function createTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !MAIL_FROM) return null;
  const port = Number(SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function passwordResetEmail(name, otp) {
  const greetingName = escapeHtml(name || 'there');
  return {
    subject: 'Your RCPET IMRD AEP password reset code',
    text: `Hello ${name || 'there'},\n\nYour RCPET IMRD AEP password reset code is ${otp}. It expires in 5 minutes.\n\nIf you did not request this code, you can safely ignore this message. Do not share this code with anyone.\n\nRCPET IMRD AEP — Academic Excellence Portal\nPowered by ZERO TECHNOLOGIES`,
    html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:24px 12px;background:#f1f4f8;font-family:Arial,Helvetica,sans-serif;color:#14243a">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #dce3ec;border-radius:12px;overflow:hidden">
    <tr><td style="padding:24px 28px;background:#082b5b;border-bottom:4px solid #d6ad37;color:#fff">
      <p style="margin:0 0 6px;font-size:12px;letter-spacing:1.6px;color:#f2d578">RCPET IMRD, SHIRPUR</p>
      <h1 style="margin:0;font-size:22px;line-height:1.3">Academic Excellence Portal</h1>
    </td></tr>
    <tr><td style="padding:28px">
      <p style="margin:0 0 14px;font-size:16px">Hello ${greetingName},</p>
      <p style="margin:0 0 20px;line-height:1.6">Use the verification code below to reset your portal password.</p>
      <div style="padding:18px 12px;text-align:center;background:#f5f8fc;border:1px solid #dce5f0;border-radius:10px">
        <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#082b5b">${otp}</span>
      </div>
      <p style="margin:18px 0 8px;line-height:1.6"><strong>This code expires in 5 minutes.</strong> It can only be used once.</p>
      <p style="margin:0;line-height:1.6;color:#53657b">If you did not request a password reset, ignore this email. Never share your code with anyone, including portal staff.</p>
    </td></tr>
    <tr><td style="padding:18px 28px;background:#f5f7fa;border-top:1px solid #e3e8ef;text-align:center;color:#53657b;font-size:12px">
      RCPET IMRD AEP — Academic Excellence Portal<br><span style="color:#082b5b;font-weight:700">Powered by ZERO TECHNOLOGIES</span>
    </td></tr>
  </table>
</body>
</html>`
  };
}

function createPasswordResetRouter({
  get = database.get,
  run = database.run,
  transaction = database.transaction,
  transportFactory = createTransport,
  rateLimitMiddleware,
  verificationRateLimitMiddleware
} = {}) {
  const router = express.Router();
  const requestLimiter = rateLimitMiddleware || rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many recovery requests. Try again later.' }
  });
  const verificationLimiter = verificationRateLimitMiddleware || rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many code attempts. Try again later.' }
  });

  async function findAccount(role, email) {
    const accountType = ACCOUNT_TABLES[role];
    if (!accountType) return null;
    const activeCondition = accountType.active ? ' AND active=1' : '';
    const nameColumn = role === 'admin' ? accountType.identifier : 'full_name';
    return get(
      `SELECT id,${accountType.identifier} AS email,${nameColumn} AS full_name FROM ${accountType.table} WHERE lower(${accountType.identifier})=lower(?)${activeCondition} LIMIT 1`,
      [email]
    );
  }

  function getOtpHash(otp) {
    const pepper = process.env.PASSWORD_RESET_PEPPER || process.env.SESSION_SECRET;
    if (!pepper || pepper.length < 32) throw new Error('Password reset token secret is unavailable.');
    return crypto.createHmac('sha256', pepper).update(otp).digest('hex');
  }

  async function checkOtp(role, email, otp) {
    const account = await findAccount(role, email);
    if (!account) return { valid: false };
    const row = await get(
      `SELECT id,otp_hash,attempts FROM password_reset_otps
       WHERE lower(email)=lower(?) AND account_type=? AND expires_at>datetime('now')
         AND attempts<5 AND used_at IS NULL
       LIMIT 1`,
      [account.email, role]
    );
    if (!row) return { valid: false };
    const suppliedHash = Buffer.from(getOtpHash(otp), 'hex');
    const storedHash = Buffer.from(row.otp_hash, 'hex');
    if (suppliedHash.length !== storedHash.length || !crypto.timingSafeEqual(suppliedHash, storedHash)) {
      await run(
        'UPDATE password_reset_otps SET attempts=attempts+1 WHERE id=? AND attempts<5 AND used_at IS NULL',
        [row.id]
      );
      return { valid: false };
    }
    return { valid: true, account, otpId: row.id };
  }

  async function requestCode(role, req, res) {
    const email = String(req.body.email || '').trim();
    if (!ACCOUNT_TABLES[role] || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid registered email address.' });
    }

    let transport;
    try {
      transport = transportFactory();
    } catch (error) {
      console.error('Password reset transport initialization failed:', error.message);
      return res.status(503).json({ error: SMTP_FAILURE_MESSAGE });
    }
    if (!transport || !process.env.PASSWORD_RESET_PEPPER && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
      if (transport && typeof transport.close === 'function') transport.close();
      return res.status(503).json({ error: SMTP_FAILURE_MESSAGE });
    }

    try {
      const account = await findAccount(role, email);
      if (!account) return res.status(202).json({ ok: true, message: GENERIC_REQUEST_MESSAGE });

      const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const otpHash = getOtpHash(otp);
      const result = await run(
        `INSERT INTO password_reset_otps(email,account_type,otp_hash,expires_at,attempts,created_at,last_sent_at,used_at)
         VALUES(?,?,?,datetime('now','+5 minutes'),0,datetime('now'),datetime('now'),NULL)
         ON CONFLICT(email,account_type) DO UPDATE SET
           otp_hash=excluded.otp_hash,expires_at=excluded.expires_at,attempts=0,
           created_at=excluded.created_at,last_sent_at=excluded.last_sent_at,used_at=NULL
         WHERE password_reset_otps.last_sent_at<=datetime('now','-60 seconds')`,
        [account.email, role, otpHash]
      );
      if (result.changes) {
        const message = passwordResetEmail(account.full_name, otp);
        try {
          await transport.sendMail({
            from: process.env.MAIL_FROM,
            to: account.email,
            ...message
          });
        } catch (mailError) {
          await run(
            `UPDATE password_reset_otps SET used_at=datetime('now'),attempts=5,expires_at=datetime('now')
             WHERE lower(email)=lower(?) AND account_type=? AND otp_hash=?`,
            [account.email, role, otpHash]
          );
          console.error('Password reset email delivery failed:', mailError.message);
        }
      }
      return res.status(202).json({ ok: true, message: GENERIC_REQUEST_MESSAGE });
    } catch (error) {
      console.error('Password reset request failed:', error.message);
      return res.status(500).json({ error: SMTP_FAILURE_MESSAGE });
    } finally {
      if (typeof transport.close === 'function') transport.close();
    }
  }

  async function verifyCode(role, req, res) {
    const email = String(req.body.email || '').trim();
    const otp = String(req.body.otp || '').trim();
    if (!ACCOUNT_TABLES[role] || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: INVALID_CODE_MESSAGE });
    }
    try {
      const result = await checkOtp(role, email, otp);
      if (!result.valid) return res.status(400).json({ error: INVALID_CODE_MESSAGE });
      res.json({ ok: true, message: 'Code verified. Set a new password to complete recovery.' });
    } catch (error) {
      console.error('Password reset code verification failed:', error.message);
      res.status(500).json({ error: 'Unable to verify that code. Please try again.' });
    }
  }

  async function resetPassword(role, req, res) {
    const email = String(req.body.email || '').trim();
    const otp = String(req.body.otp || '').trim();
    const newPassword = String(req.body.newPassword || '');
    const policy = PASSWORD_POLICIES[role];
    if (!policy || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: INVALID_CODE_MESSAGE });
    }
    if (newPassword.length < policy.minimum || !/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({ error: `Password must be ${policy.description}` });
    }

    try {
      const result = await checkOtp(role, email, otp);
      if (!result.valid) return res.status(400).json({ error: INVALID_CODE_MESSAGE });

      const passwordHash = await bcrypt.hash(newPassword, 12);
      const passwordReset = await transaction(async tx => {
        const consumed = await tx.run(
          `UPDATE password_reset_otps SET used_at=datetime('now')
           WHERE id=? AND used_at IS NULL AND expires_at>datetime('now') AND attempts<5`,
          [result.otpId]
        );
        if (!consumed.changes) return false;

        let updated;
        if (role === 'admin' && ['kaushalpatil927@gmail.com', 'luckykalal9@gmail.com'].includes(result.account.email.toLowerCase())) {
          updated = await tx.run(
            `UPDATE administrators SET password_hash=?,must_change_password=0
             WHERE lower(username) IN (lower(?),lower(?))`,
            [passwordHash, 'kaushalpatil927@gmail.com', 'luckykalal9@gmail.com']
          );
        } else {
          const accountType = ACCOUNT_TABLES[role];
          const activeCondition = accountType.active ? ' AND active=1' : '';
          const passwordChangedAt = role === 'admin' ? '' : ",password_changed_at=datetime('now')";
          updated = await tx.run(
            `UPDATE ${accountType.table}
             SET password_hash=?,must_change_password=0${passwordChangedAt}
             WHERE id=?${activeCondition}`,
            [passwordHash, result.account.id]
          );
        }
        if (!updated.changes) throw new Error('Password reset account could not be updated.');
        return true;
      });
      if (!passwordReset) return res.status(400).json({ error: INVALID_CODE_MESSAGE });
      res.json({ ok: true, message: 'Your password has been reset. You can now sign in.' });
    } catch (error) {
      console.error('Password reset failed:', error.message);
      res.status(500).json({ error: 'Unable to reset your password. Please try again.' });
    }
  }

  for (const role of Object.keys(ACCOUNT_TABLES)) {
    router.post(`/${role}/request`, requestLimiter, (req, res) => requestCode(role, req, res));
    router.post(`/${role}/verify`, verificationLimiter, (req, res) => verifyCode(role, req, res));
    router.post(`/${role}/reset`, verificationLimiter, (req, res) => resetPassword(role, req, res));
  }

  return router;
}

module.exports = createPasswordResetRouter();
module.exports.createPasswordResetRouter = createPasswordResetRouter;
module.exports.passwordResetEmail = passwordResetEmail;
