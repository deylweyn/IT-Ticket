/**
 * sw.js
 * Service worker for Ticket Desk desktop push notifications.
 *
 * This is what actually shows the OS-level notification when a push
 * arrives - it runs in the background, independent of whether any
 * Ticket Desk tab is open, which is what makes this a real "desktop
 * notification" rather than just an in-page popup (see app.js's
 * subscribePush()/unsubscribePush() for the other half: getting the
 * browser subscribed in the first place).
 */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Ticket Desk", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Ticket Desk";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
    tag: data.url || undefined, // replaces a still-unread notification for the same ticket instead of stacking duplicates
  };

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      // Also tell any Ticket Desk tab that's already open (foreground OR
      // background) that a push just landed, so app.js can refresh the
      // bell right away instead of that tab waiting for its next 5s poll -
      // this is what makes an admin's poke show up on the bell in
      // real time, not just as the OS notification. A closed/no-tab case
      // just falls back to the OS notification above; there's nothing to
      // message.
      const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        client.postMessage({ type: "ticket-desk-push", url: options.data.url });
      }
    })()
  );
});

// Clicking the notification focuses an existing Ticket Desk tab if one is
// open, or opens a new one, and navigates it to the ticket in question.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) client.navigate(targetUrl);
          return;
        }
      }
      await clients.openWindow(targetUrl);
    })()
  );
});