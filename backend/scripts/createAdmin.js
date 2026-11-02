require('dotenv').config();
const { ensureSchema } = require('../database/migrations');
const { initializeOwnerAccount } = require('./ownerAccount');

async function main() {
  await ensureSchema();
  const result = await initializeOwnerAccount();
  console.log(result.created
    ? 'Owner administrator created. A password change is required at first login.'
    : 'Owner administrator already exists; its password and profile were preserved.');
}

if (require.main === module) {
  main().catch(error => {
    console.error('Administrator setup failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
