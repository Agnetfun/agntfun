#!/usr/bin/env bash
# DevAgent VPS setup for a fresh Ubuntu 24.04 server. Run as root:
#   bash setup.sh <github-owner/repo> <your.domain>
# Safe to run again: every step checks what is already there.
#
# What it does: installs Node 24, pnpm, git, Docker (agent sandboxes) and Caddy (https), creates a "devagent" user,
# gives the server a read-only GitHub deploy key to clone your private repo, generates the seal keys, writes the
# settings files, and runs the website and the orchestrator as services that restart on failure and on reboot.
set -euo pipefail

REPO="${1:-}"
DOMAIN="${2:-}"
if [[ -z "$REPO" || -z "$DOMAIN" || "$REPO" != */* ]]; then
  echo "usage: bash setup.sh <github-owner/repo> <your.domain>"
  exit 1
fi
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

APP_DIR=/opt/devagent
ETC=/etc/devagent
USER_NAME=devagent
say() { printf '\n==> %s\n' "$*"; }

say "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates ufw docker.io caddy
systemctl enable --now docker

say "Node 24 and pnpm"
if ! node -v 2>/dev/null | grep -q '^v24\.'; then
  # NodeSource's official setup script for the Node 24 line.
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
npm install -g pnpm@10.28.0

say "User $USER_NAME"
id "$USER_NAME" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$USER_NAME"
usermod -aG docker "$USER_NAME" # agents' code runs in Docker sandboxes started by the orchestrator

say "GitHub deploy key (read only access to $REPO)"
KEY=/home/$USER_NAME/.ssh/id_ed25519
if [[ ! -f $KEY ]]; then
  sudo -u "$USER_NAME" mkdir -p /home/$USER_NAME/.ssh
  sudo -u "$USER_NAME" ssh-keygen -t ed25519 -N "" -C "devagent-vps" -f "$KEY" >/dev/null
fi
sudo -u "$USER_NAME" bash -c "ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null; sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts"
if [[ ! -d $APP_DIR/.git ]]; then
  echo
  echo "Add this key to GitHub: $REPO > Settings > Deploy keys > Add deploy key (leave 'Allow write access' OFF):"
  echo
  cat "$KEY.pub"
  echo
  read -r -p "Press Enter once the key is added... "
  mkdir -p "$APP_DIR"
  chown "$USER_NAME:$USER_NAME" "$APP_DIR"
  sudo -u "$USER_NAME" git clone "git@github.com:$REPO.git" "$APP_DIR"
fi

say "Install dependencies"
cd "$APP_DIR"
sudo -u "$USER_NAME" pnpm install --frozen-lockfile
sudo -u "$USER_NAME" mkdir -p "$APP_DIR/data"
docker pull node:22-slim

say "Settings in $ETC"
mkdir -p "$ETC"
if [[ ! -f $ETC/app.env ]]; then
  # Split the template: everything before the orchestrator marker goes to app.env, the rest to orchestrator.env.
  awk '/^# ---------- orchestrator.env/{o=1} !o' .env.production.example > "$ETC/app.env"
  awk '/^# ---------- orchestrator.env/{o=1} o' .env.production.example > "$ETC/orchestrator.env"
  KEYS=$(node -e '
    const { generateKeyPairSync } = require("node:crypto");
    const k = generateKeyPairSync("x25519");
    console.log(k.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
    console.log(k.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));')
  PUB=$(sed -n 1p <<<"$KEYS")
  PRIV=$(sed -n 2p <<<"$KEYS")
  sed -i "s|^SEAL_PUBLIC_KEY=.*|SEAL_PUBLIC_KEY=$PUB|; s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" "$ETC/app.env"
  sed -i "s|^SEAL_PRIVATE_KEY=.*|SEAL_PRIVATE_KEY=$PRIV|" "$ETC/orchestrator.env"
  echo "Generated seal keys. BACK UP $ETC/orchestrator.env OFF THIS SERVER: it unlocks every agent wallet."
fi
chown root:"$USER_NAME" "$ETC"/*.env
chmod 640 "$ETC/app.env"
chmod 600 "$ETC/orchestrator.env" # root only; systemd hands it to the orchestrator

say "Services"
cat > /etc/systemd/system/devagent-web.service <<EOF
[Unit]
Description=DevAgent website
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$APP_DIR
EnvironmentFile=$ETC/app.env
ExecStart=/usr/bin/pnpm exec tsx apps/web/src/main.ts
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/devagent-orchestrator.service <<EOF
[Unit]
Description=DevAgent orchestrator (agents, chain, community)
After=network-online.target docker.service devagent-web.service
Wants=network-online.target
Requires=docker.service

[Service]
User=$USER_NAME
WorkingDirectory=$APP_DIR
EnvironmentFile=$ETC/app.env
EnvironmentFile=$ETC/orchestrator.env
ExecStart=/usr/bin/pnpm exec tsx apps/orchestrator/src/main.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

say "https with Caddy for $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
systemctl reload caddy || systemctl restart caddy

say "Firewall: SSH, HTTP, HTTPS only"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

say "Preflight"
if node scripts/preflight-mainnet.mjs "$ETC/app.env" "$ETC/orchestrator.env"; then # root: orchestrator.env is 600
  systemctl enable --now devagent-web devagent-orchestrator
  say "Running. Open https://$DOMAIN  |  logs: journalctl -u devagent-web -u devagent-orchestrator -f"
else
  echo
  echo "Fill the missing values:  nano $ETC/app.env   and   nano $ETC/orchestrator.env"
  echo "Then run this script again (it skips finished steps and starts the services once preflight passes)."
fi
