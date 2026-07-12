const { Pool } = require('pg');

// Render Cloud 대시보드의 Environment Variables가 자동으로 적용됩니다.
// 로컬 환경을 위한 기본 설정만 남기고 강제 경로 설정은 제거합니다.
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect()
};
