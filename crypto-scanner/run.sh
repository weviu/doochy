#!/bin/bash
# One-time bootstrap for the pm2 stack. Safe to re-run (idempotent).
set -e

# --- Log rotation: keep pm2 log files from growing unbounded ---
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M     # rotate each log when it hits 10 MB
pm2 set pm2-logrotate:retain 5         # keep 5 rotated files (~50 MB cap per log)
pm2 set pm2-logrotate:compress true    # gzip rotated logs

# --- Start the whole stack (scanner + xag + feed server) ---
pm2 start ecosystem.config.js
pm2 save
