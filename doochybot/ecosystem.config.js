// PM2 process definitions for DoochyBot and its Telegram channel listener.
//
// Both apps run the COMPILED output in dist/ — build before (re)starting:
//   (root)              pnpm build
//   channel-listener    cd channel-listener && npm run build
//
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 restart ecosystem.config.js           # both
//   pm2 restart channel-listener              # just the listener
//   pm2 logs channel-listener
//
// Note: the channel-listener must have been authenticated once interactively
// (npm run dev, enter the Telegram code) so session/session.txt exists. PM2 runs
// it non-interactively and cannot answer the login prompt on a cold session.

const path = require("path");

module.exports = {
  apps: [
    {
      name: "doochybot",
      cwd: __dirname,
      script: path.join(__dirname, "dist", "index.js"),
      interpreter: "node",
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 3000,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "channel-listener",
      cwd: path.join(__dirname, "channel-listener"),
      script: path.join(__dirname, "channel-listener", "dist", "index.js"),
      interpreter: "node",
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
