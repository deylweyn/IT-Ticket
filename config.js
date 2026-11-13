/**
 * config.js
 * Connection settings for Neon (serverless PostgreSQL).
 *
 * Get your connection string from the Neon console:
 *   Project -> Dashboard -> Connection Details -> "Connection string"
 * It looks like:
 *   postgresql://<user>:<password>@<host>.neon.tech/<dbname>?sslmode=require
 *
 * Recommended: put it in an environment variable instead of hardcoding it
 * here, e.g. (macOS/Linux):
 *   export DATABASE_URL="postgresql://user:password@ep-xxxx.neon.tech/neondb?sslmode=require"
 * or Windows (PowerShell):
 *   $env:DATABASE_URL="postgresql://user:password@ep-xxxx.neon.tech/neondb?sslmode=require"
 *
 * If DATABASE_URL isn't set, the fallback string below is used - replace it
 * with your own Neon connection string, or (better) just set the env var
 * and leave the fallback as-is.
 */

const DB_CONFIG = {
  // Full Neon connection string. Prefer the DATABASE_URL env var; this
  // literal is only a fallback for local convenience.
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://neondb_owner:npg_CfcK8rZ6MhXQ@ep-summer-voice-ayaa2evu-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",

  // Neon requires SSL. rejectUnauthorized:false avoids local CA-bundle
  // issues; Neon's endpoint certs are valid, so this is only being
  // permissive about the *local* trust store, not about who you connect to.
  ssl: { rejectUnauthorized: false },
};

/**
 * VAPID keys for Web Push (desktop push notifications for IT staff).
 * These identify your server to the browser's push service - they are NOT
 * a secret in the same way a DB password is (the private key only lets you
 * send push messages, not read anything), but you should still generate
 * your own pair for a real deployment rather than relying on the fallback
 * below, since anyone with this repo's source could send pushes signed
 * with it.
 *
 * Generate your own pair with:
 *   npx web-push generate-vapid-keys
 * then set them as env vars (recommended), e.g.:
 *   export VAPID_PUBLIC_KEY="..."
 *   export VAPID_PRIVATE_KEY="..."
 *
 * VAPID_SUBJECT should be a "mailto:" address or URL identifying the
 * sender - some push services use it to contact you if something's wrong.
 */
const VAPID_CONFIG = {
  publicKey:
    process.env.VAPID_PUBLIC_KEY ||
    "BOjgvh0WHqO5j2I6YpT_XynY4LIZ2hq2L4QJY6aKDKVbOGu0_wTBYnS2MnkeDY3Vk4ChBspxZniZrYLCKgpolXk",
  privateKey:
    process.env.VAPID_PRIVATE_KEY ||
    "b3aMNBXfC4K44gGlRzIcTtnQedZKf3saVojCEfm0hlA",
  subject: process.env.VAPID_SUBJECT || "mailto:admin@example.com",
};

module.exports = { DB_CONFIG, VAPID_CONFIG };
