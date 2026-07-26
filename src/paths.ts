import path from "path";

// The one resolver for the data/ directory. Anchored to the repo root (this
// file lives at <root>/src/ or compiled at <root>/dist/, so one level up is the
// root either way), NOT to process.cwd(): a cwd-relative path meant that
// starting the bot from a different directory (terminal vs pm2 vs a script)
// silently saw an empty data dir — "losing" the pairing token and settings and
// forcing a re-pair even though the files were fine.
//
// DOOCHY_DATA_DIR overrides it for deployments that keep data elsewhere.
export const DATA_DIR = process.env.DOOCHY_DATA_DIR || path.resolve(__dirname, "..", "data");
