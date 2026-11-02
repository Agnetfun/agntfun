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
USER_NAME=devagent      # owns the code, runs the orchestrator (holds SEAL_PRIVATE_KEY, starts Docker sandboxes)
WEB_USER=devagent-web   # runs the internet-facing website: no Docker, no private key, cannot read the orchestrator
DATA_GROUP=devagent-data # the only thing both share: the database folder
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

say "Users $USER_NAME and $WEB_USER"
# Two users, so a compromise of the website cannot read the orchestrator's environment (SEAL_PRIVATE_KEY) through
# /proc or reach Docker: a different uid cannot read another process's environ, and only the orchestrator is in docker.
getent group "$DATA_GROUP" >/dev/null || groupadd "$DATA_GROUP"
id "$USER_NAME" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$USER_NAME"
id "$WEB_USER" >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin "$WEB_USER"
usermod -aG docker,"$DATA_GROUP" "$USER_NAME" # agents' code runs in Docker sandboxes started by the orchestrator
usermod -aG "$DATA_GROUP" "$WEB_USER"
gpasswd -d "$WEB_USER" docker >/dev/null 2>&1 || true # never in docker, even if added by hand earlier

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
sudo -u "$USER_NAME" pnpm --filter @devagent/web build:privy # Privy login bundle (generated, not in git)
sudo -u "$USER_NAME" mkdir -p "$APP_DIR/data"
# Shared database folder: both services read and write it; setgid keeps new files (WAL, uploads) in the group.
chown "$USER_NAME:$DATA_GROUP" "$APP_DIR/data"
chmod 2770 "$APP_DIR/data"
find "$APP_DIR/data" -type f -exec chgrp "$DATA_GROUP" {} + -exec chmod g+rw {} +
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
# Root only: systemd reads EnvironmentFile as root before dropping to the service user, so no app user can open them.
chown root:root "$ETC"/*.env
chmod 600 "$ETC"/*.env

say "Services"
cat > /etc/systemd/system/devagent-web.service <<EOF
[Unit]
Description=DevAgent website
After=network-online.target
Wants=network-online.target

[Service]
User=$WEB_USER
Group=$DATA_GROUP
UMask=0007
WorkingDirectory=$APP_DIR
EnvironmentFile=$ETC/app.env
ExecStart=/usr/bin/pnpm exec tsx apps/web/src/main.ts
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only

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
Group=$DATA_GROUP
UMask=0007
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
