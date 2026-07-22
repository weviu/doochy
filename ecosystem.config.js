// PM2 config for a normal DoochyBot user: exactly one process, your own
// trading agent. (ecosystem.admin.config.js is the VPS's file; it also defines
// the hub and channel-listener, which do NOT run on user machines.)
//
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup

const path = require("path");

module.exports = {
  apps: [
    {
      name: "doochybot",
      cwd: __dirname,
      script: path.join(__dirname, "dist", "doochybot", "index.js"),
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
  ],
};
