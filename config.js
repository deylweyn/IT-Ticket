/**
 * config.js
 * Connection settings for Neon (serverless PostgreSQL) and Web Push.
 *
 * All secrets come from environment variables - nothing is hardcoded.
 *
 *   DATABASE_URL       postgresql://user:password@host.neon.tech/dbname?sslmode=require
 *   VAPID_PUBLIC_KEY   from: npx web-push generate-vapid-keys
 *   VAPID_PRIVATE_KEY  from: npx web-push generate-vapid-keys
 *   VAPID_SUBJECT      mailto:you@yourcompany.com (optional)
 */

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not set.");
}
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY environment variables are not set.");
}

const DB_CONFIG = {
  connectionString: process.env.DATABASE_URL,
  // Neon requires SSL. rejectUnauthorized:false only relaxes the local trust store.
  ssl: { rejectUnauthorized: false },
};

const VAPID_CONFIG = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: process.env.VAPID_SUBJECT || "mailto:admin@example.com",
};

module.exports = { DB_CONFIG, VAPID_CONFIG };