// Vercel entry point. Every request to /api/* lands here and is handed
// straight to server.js's handleRequest(req, res) - the same router that
// used to be wired up to Node's http.createServer(...).listen(). Static
// frontend files (index.html, app.js, styles.css) are served separately by
// Vercel directly from /public and never reach this function.
const { handleRequest } = require("../server");

module.exports = async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error("Fatal request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: "Server error" }));
  }
};
