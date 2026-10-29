#!/usr/bin/env bash
# Deploy the latest code from GitHub to the VPS. Run as root:  bash /opt/devagent/scripts/vps/update.sh
# Pulls main, installs dependencies, runs preflight, restarts both services. Data and settings are untouched.
set -euo pipefail
APP_DIR=/opt/devagent
ETC=/etc/devagent
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
cd "$APP_DIR"
sudo -u devagent git pull --ff-only
sudo -u devagent pnpm install --frozen-lockfile
node scripts/preflight-mainnet.mjs "$ETC/app.env" "$ETC/orchestrator.env"
systemctl restart devagent-web devagent-orchestrator
echo "Updated to $(sudo -u devagent git log -1 --format='%h %s'). Logs: journalctl -u devagent-web -u devagent-orchestrator -f"
