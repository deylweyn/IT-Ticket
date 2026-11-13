/**
 * push.js
 * Desktop push notifications (Web Push) for IT staff - fires a real OS-level
 * notification even if the Ticket Desk tab (or the whole browser) is closed,
 * as long as the staff member enabled notifications at least once and their
 * browser is running.
 *
 * How this fits together:
 *  - Each browser that enables notifications gets a PushSubscription object
 *    (endpoint + keys) from the browser's push service (Chrome talks to
 *    Google's, Firefox to Mozilla's, etc). We store that in
 *    push_subscriptions, keyed to our user id (see db.js).
 *  - To notify someone, we hand their stored subscription(s) + a small JSON
 *    payload to web-push, which POSTs to the browser vendor's push service
 *    on our behalf. That service wakes the user's browser and hands the
 *    payload to static/sw.js's `push` event listener, which shows the
 *    actual OS notification - independent of whether our server or their
 *    tab is currently open.
 *  - A subscription can go stale (browser data cleared, notifications
 *    revoked, etc). The push service reports that as a 404/410 on send, so
 *    we delete it here rather than let it fail forever.
 */

const webpush = require("web-push");
const { getConnection } = require("./db");
const { VAPID_CONFIG } = require("./config");

webpush.setVapidDetails(VAPID_CONFIG.subject, VAPID_CONFIG.publicKey, VAPID_CONFIG.privateKey);

/** Save (or refresh) a browser's push subscription for this user. Keyed on
 * endpoint, which is unique per browser subscription - re-subscribing the
 * same browser (e.g. after the keys rotate) just updates its row instead of
 * creating a duplicate. */
async function saveSubscription(userId, subscription) {
  const pool = getConnection();
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    throw new Error("Invalid push subscription.");
  }
  await pool.query(
    "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) " +
    "VALUES (?, ?, ?, ?, NOW()) " +
    "ON CONFLICT (endpoint) DO UPDATE " +
    "SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth",
    [userId, endpoint, keys.p256dh, keys.auth]
  );
}

/** Remove one browser's subscription (e.g. the user clicked "Turn off
 * notifications" on this device). */
async function removeSubscription(endpoint) {
  const pool = getConnection();
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
}

async function _subscriptionsForUser(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
    [userId]
  );
  return rows;
}

/** Send a push notification to every browser this user has enabled
 * notifications on. `payload` is plain data (title/body/url, etc) - static/
 * sw.js decides how to render it. Failures on one subscription (e.g. one
 * browser was uninstalled) don't stop delivery to the user's other devices;
 * a subscription the push service reports as gone (404/410) is cleaned up
 * automatically. Errors are swallowed (logged only) so a notification
 * failure never breaks the ticket action that triggered it. */
async function notifyUser(userId, payload) {
  let subs;
  try {
    subs = await _subscriptionsForUser(userId);
  } catch (err) {
    console.error("push: could not load subscriptions for user", userId, err);
    return;
  }
  console.log(`push: user ${userId} has ${subs.length} saved subscription(s)`);
  if (subs.length === 0) return;

  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body
        );
        console.log(`push: sent OK to user ${userId} (${sub.endpoint.slice(0, 60)}...)`);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          console.log(`push: subscription gone (${err.statusCode}) for user ${userId}, removing it`);
          await removeSubscription(sub.endpoint).catch(() => {});
        } else {
          console.error(`push: send failed for user ${userId}, status ${err.statusCode}:`, err.message);
        }
      }
    })
  );
}

module.exports = {
  publicKey: VAPID_CONFIG.publicKey,
  saveSubscription,
  removeSubscription,
  notifyUser,
};
