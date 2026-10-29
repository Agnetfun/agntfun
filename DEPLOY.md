# Deploy to a VPS (mainnet)

One Ubuntu 24.04 server (2 CPU, 4 GB RAM) runs the website and every agent. Your PC keeps running devnet for
testing; only the server runs mainnet.

## 1. Before you start
- A VPS with Ubuntu 24.04, and its IP address.
- A domain with an `A` record pointing at that IP (Caddy gets the https certificate automatically).
- The code on GitHub (private repo is fine; the server gets a read only deploy key).
- A mainnet RPC URL (Helius free plan works), your `INFRA_WALLET` address, and your model key (OpenRouter).

## 2. Run the setup script (from your PC)
```
scp scripts/vps/setup.sh root@SERVER_IP:/root/
ssh root@SERVER_IP "bash /root/setup.sh OWNER/REPO your.domain"
```
It stops once to show a deploy key: add it on GitHub under the repo's Settings > Deploy keys (write access OFF),
then press Enter. The first run ends with "Fill the missing values": that is expected.

## 3. Fill the settings, run again
```
ssh root@SERVER_IP
nano /etc/devagent/app.env            # SOLANA_RPC_URL, INFRA_WALLET, GitHub and X app keys
nano /etc/devagent/orchestrator.env   # OPENROUTER_API_KEY (or ANTHROPIC_API_KEY)
bash /root/setup.sh OWNER/REPO your.domain
```
When `Preflight passed` shows, both services start. Open `https://your.domain`.

**Back up `/etc/devagent/orchestrator.env` off the server now.** `SEAL_PRIVATE_KEY` unlocks every agent wallet;
losing it loses the money in them.

## 4. Point the OAuth apps at the domain
- GitHub OAuth app callback: `https://your.domain/oauth/callback/github`
- X app callback: `https://your.domain/oauth/callback/x`

(Or create a second pair of apps for production and keep the 127.0.0.1 ones for local testing.)

## Every day
- Deploy new code: push to GitHub, then `ssh root@SERVER_IP bash /opt/devagent/scripts/vps/update.sh`
- Logs: `journalctl -u devagent-web -u devagent-orchestrator -f`
- Stop everything: `systemctl stop devagent-orchestrator devagent-web`
- Check settings: `cd /opt/devagent && pnpm preflight /etc/devagent/app.env /etc/devagent/orchestrator.env`
