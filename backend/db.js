const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.postgresql://ohseyokr:aCwJOKvOba6b6zuMnUp56ypZ9msasKYr@dpg-d99dbt0k1i2s73e13r50-a/ohseyokr_7t0s
//DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect()
