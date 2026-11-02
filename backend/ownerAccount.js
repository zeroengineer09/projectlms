const bcrypt = require('bcryptjs');
const { get, run } = require('./database');

const DEFAULT_OWNER_EMAIL = 'kaushalpatil927@gmail.com';

async function initializeOwnerAccount(options = {}) {
  const username = DEFAULT_OWNER_EMAIL;
  const existing = await get(
    'SELECT id FROM administrators WHERE lower(username)=lower(?)',
    [username]
  );
  if (existing) return { created: false };

  const initialPassword = options.initialPassword || process.env.OWNER_INITIAL_PASSWORD;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) {
    throw new Error('OWNER_EMAIL must be a valid email address.');
  }
  if (!initialPassword || initialPassword.length < 10 || !/[a-z]/.test(initialPassword) || !/[0-9]/.test(initialPassword)) {
    throw new Error('Set a strong OWNER_INITIAL_PASSWORD (10+ characters with lowercase letters and digits) before creating the owner account.');
  }

  const passwordHash = await bcrypt.hash(initialPassword, 12);
  const inserted = await run(
    'INSERT INTO administrators(username,password_hash,must_change_password) VALUES(?,?,1) ON CONFLICT DO NOTHING',
    [username, passwordHash]
  );

  const account = await get(
    'SELECT id FROM administrators WHERE lower(username)=lower(?)',
    [username]
  );
  if (!account) throw new Error('Unable to create the owner administrator account.');
  return { created: inserted.changes === 1 };
}

module.exports = { DEFAULT_OWNER_EMAIL, initializeOwnerAccount };
