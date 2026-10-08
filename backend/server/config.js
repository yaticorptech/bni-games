const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const env = process.env;
const root = path.join(__dirname, '..');

const originOf = (url) => {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
};

const publicUrl = (env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

module.exports = {
  port: Number(env.PORT) || 8110,
  adminPassword: env.ADMIN_PASSWORD || 'bni-admin',
  usingDefaultPassword: !env.ADMIN_PASSWORD,
  publicUrl,
  // Sites allowed to call the API from the browser: the PUBLIC_URL frontend plus any extras.
  corsOrigins: [publicUrl, ...(env.CORS_ORIGINS || '').split(',')].map(originOf).filter(Boolean),
  mongoUri: (env.MONGODB_URI || '').trim(),
  mongoDb: env.MONGODB_DB || 'bni_games',
  dataFile: env.DATA_FILE ? path.resolve(env.DATA_FILE) : path.join(root, 'data', 'db.json'),
  quizFile: path.join(root, 'config', 'quiz-questions.json'),
  pictionaryFile: path.join(root, 'config', 'pictionary.json'),
  // Served too when present (local/laptop mode); absent on Railway, where only backend/ is deployed.
  frontendDir: path.join(root, '..', 'frontend'),
  defaultTitle: env.EVENT_TITLE || 'BNI Award Night',
};
