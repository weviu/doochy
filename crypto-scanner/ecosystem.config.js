// Single source of truth for the whole stack.
//   pm2 start ecosystem.config.js
//
// signal-scanner: runs scanner.py with its built-in --loop so the process stays
// continuously "online" (no cron_restart / "stopped" flapping). The loop sleeps
// to the next wall-clock interval, so scans still land on round times.
//
// Logs: stdout+stderr go to real files (merge_logs) instead of /dev/null, so
// `pm2 logs` works. Size is capped by the pm2-logrotate module (configured in
// runpm2.sh): max_size + retain keep the files from growing unbounded.
module.exports = {
  apps: [
    {
      name: "signal-scanner",
      script: "scanner.py",
      interpreter: "python3",
      args: "-tf 1h --loop 15",      // scan every 15m on the 1h TF (fewer/stronger signals, 4h-confirmed)
      cwd: "/home/algo/crypto-scanner",
      env: { SCANNER_ROLE: "crypto" },  // picks up CRYPTO_* .env overrides (see core/config.py)
      autorestart: true,             // restart only on crash; normally never exits
      out_file: "/home/algo/crypto-scanner/logs/signal-scanner.log",
      error_file: "/home/algo/crypto-scanner/logs/signal-scanner.log",
      merge_logs: true,
    },
    {
      name: "gold-scanner",
      script: "gold-scanner.py",
      interpreter: "python3",
      args: "-tf 15m --loop 5",       // gold multi-strategy (cloud pullback / Asian breakout / RSI2) via cTrader
      cwd: "/home/algo/crypto-scanner",
      env: { SCANNER_ROLE: "gold" },  // picks up GOLD_* .env overrides
      autorestart: true,
      out_file: "/home/algo/crypto-scanner/logs/gold-scanner.log",
      error_file: "/home/algo/crypto-scanner/logs/gold-scanner.log",
      merge_logs: true,
    },
    {
      name: "gold-15m-scanner",
      script: "gold-15m-scanner.py",
      interpreter: "python3",
      args: "-tf 15m --loop 5",       // short-term XAU (donchian momentum + VWAP-reclaim SELL) via cTrader; independent stream
      cwd: "/home/algo/crypto-scanner",
      env: { SCANNER_ROLE: "gold15m" },  // picks up X15_* .env overrides
      autorestart: true,
      out_file: "/home/algo/crypto-scanner/logs/gold-15m-scanner.log",
      error_file: "/home/algo/crypto-scanner/logs/gold-15m-scanner.log",
      merge_logs: true,
    },
    {
      name: "silver-scanner",
      script: "silver-scanner.py",
      interpreter: "python3",
      args: "-tf 15m --loop 15",
      cwd: "/home/algo/crypto-scanner",
      env: { SCANNER_ROLE: "silver" },
      autorestart: true,
      out_file: "/home/algo/crypto-scanner/logs/silver-scanner.log",
      error_file: "/home/algo/crypto-scanner/logs/silver-scanner.log",
      merge_logs: true,
    },
    {
      name: "us100-scanner",
      script: "us100-scanner.py",
      interpreter: "python3",
      args: "-tf 1h --loop 15",       // NASDAQ-100 momentum breakout (donchian, 4h+1d gated) via cTrader; independent stream
      cwd: "/home/algo/crypto-scanner",
      env: { SCANNER_ROLE: "us100" },  // picks up U100_* .env overrides
      autorestart: true,
      out_file: "/home/algo/crypto-scanner/logs/us100-scanner.log",
      error_file: "/home/algo/crypto-scanner/logs/us100-scanner.log",
      merge_logs: true,
    },
    {
      name: "feed-server",
      script: "python3",
      args: "-m http.server 8880",
      cwd: "/home/algo/crypto-scanner/data",
      autorestart: true,
      out_file: "/home/algo/crypto-scanner/logs/feed-server.log",
      error_file: "/home/algo/crypto-scanner/logs/feed-server.log",
      merge_logs: true,
    },
  ],
};
