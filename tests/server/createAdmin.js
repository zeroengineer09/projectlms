
require('dotenv').config();

const bcrypt = require('bcryptjs');
const { run, get } = require('./database');

async function main() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password || password.length < 12) {
    throw new Error(
      'Set ADMIN_USERNAME and a strong ADMIN_PASSWORD (12+ characters).'
    );
  }

  const admin = await get(
    'SELECT id FROM administrators WHERE username = ?',
    [username]
  );

  const hash = await bcrypt.hash(password, 12);

  if (admin) {
    await run(
      'UPDATE administrators SET password_hash = ? WHERE id = ?',
      [hash, admin.id]
    );
    console.log('Admin password reset successfully.');
  } else {
    await run(
      'INSERT INTO administrators (username, password_hash) VALUES (?, ?)',
      [username, hash]
    );
    console.log('Admin account created successfully.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Admin setup failed:', error.message);
    process.exit(1);
  });
