const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { get, run } = require('./database');

const router = express.Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' }
});

router.post('/login', loginLimiter, express.json(), async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const admin = await get(
      'SELECT * FROM administrators WHERE lower(username)=lower(?)',
      [username]
    );
    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    req.session.regenerate(error => {
      if (error) return res.status(500).json({ error: 'Unable to create session.' });
      req.session.adminId = admin.id;
      req.session.username = admin.username;
      req.session.mustChangePassword = Boolean(admin.must_change_password);
      req.session.save(saveError => {
        if (saveError) return res.status(500).json({ error: 'Unable to save login session.' });
        res.json({
          ok: true,
          username: admin.username,
          mustChangePassword: Boolean(admin.must_change_password)
        });
      });
    });
  } catch (error) {
    console.error('Administrator login failed:', error.message);
    res.status(500).json({ error: 'Login failed.' });
  }
});

router.post('/change-password', async (req, res) => {
  try {
    if (!req.session.adminId) return res.status(401).json({ error: 'Please sign in first.' });
    const current = String(req.body.currentPassword || '');
    const next = String(req.body.newPassword || '');
    if (next.length < 12 || !/[a-z]/.test(next) || !/[A-Z]/.test(next) || !/[0-9]/.test(next)) {
      return res.status(400).json({ error: 'New password must be at least 12 characters and include uppercase, lowercase and a number.' });
    }
    const admin = await get('SELECT * FROM administrators WHERE id=?', [req.session.adminId]);
    if (!admin || !(await bcrypt.compare(current, admin.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    // The two approved owner logins intentionally share one password.
    // Changing it from either login updates both accounts atomically.
    const sharedOwnerHash = await bcrypt.hash(next, 12);
    await run(
      `UPDATE administrators
       SET password_hash=?,must_change_password=0
       WHERE lower(username) IN (lower(?), lower(?))`,
      [sharedOwnerHash, 'kaushalpatil927@gmail.com', 'luckykalal9@gmail.com']
    );
    req.session.mustChangePassword = false;
    res.json({ ok: true });
  } catch (error) {
    console.error('Administrator password change failed:', error.message);
    res.status(500).json({ error: 'Unable to change password.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('cdt.sid');
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => req.session.adminId
  ? res.json({ authenticated: true, username: req.session.username })
  : res.status(401).json({ authenticated: false }));

module.exports = router;
module.exports.requireAdmin = (req, res, next) => {
  if (!req.session.adminId) return res.status(401).json({ error: 'Administrator login required.' });
  if (req.session.mustChangePassword) {
    return res.status(403).json({ error: 'Change your initial administrator password before continuing.' });
  }
  next();
};
