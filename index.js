// For local development - re-export from api/index.js
// This allows local development with "node index.js"
// On Vercel, requests are routed to /api via vercel.json rewrites
const apiApp = require("./api/index.js");
module.exports = apiApp;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  apiApp.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT}`);
  });
}
