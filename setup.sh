#!/bin/bash
# Fresh-VPS setup for the relayer. Target: Ubuntu 22.04 / 24.04, run as root.
# Usage: clone the repo, fill in .env, then run:  bash setup.sh
# Installs Docker, nginx, and certbot, opens the firewall, writes a reverse
# proxy for your domain, obtains TLS, and brings up the stack. Safe to re-run.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
require() { echo -e "${RED}[REQUIRED]${NC} $*"; }

if [ ! -f "$APP_DIR/.env" ]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    require ""
    require "Created .env from .env.example. Edit it, then re-run this script."
    require "  Set at least: DOMAIN, LETSENCRYPT_EMAIL, POSTGRES_PASSWORD,"
    require "  RELAYER_SECRET, FACTORY_ID, INDEXER_START_LEDGER, the RPC/Horizon URLs."
    require ""
    exit 1
fi

chmod 600 "$APP_DIR/.env"
# Load .env as shell-local vars only (no `set -a`), so the hot-wallet seed is not exported into
# the environment of apt, certbot, or the Docker install script.
# shellcheck disable=SC1091
source "$APP_DIR/.env"

for var in DOMAIN LETSENCRYPT_EMAIL POSTGRES_PASSWORD RELAYER_SECRET FACTORY_ID; do
    if [ -z "${!var:-}" ]; then
        require "$var is not set in .env. Fill it in and re-run."
        exit 1
    fi
done
if [ "$POSTGRES_PASSWORD" = "change_this_strong_password" ]; then
    require "POSTGRES_PASSWORD is still the placeholder. Set a strong value and re-run."
    exit 1
fi
# DOMAIN is interpolated into the nginx config; reject anything that is not a bare hostname.
if ! [[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]]; then
    require "DOMAIN must be a bare hostname (letters, digits, dots, hyphens). Got: $DOMAIN"
    exit 1
fi

info "Updating system and installing nginx, certbot, ufw..."
apt-get update -qq && apt-get upgrade -y -qq
apt-get install -y -qq curl wget git ufw nginx certbot python3-certbot-nginx

if ! command -v docker &>/dev/null; then
    info "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
else
    info "Docker already installed."
fi
if ! docker compose version &>/dev/null; then
    apt-get install -y -qq docker-compose-plugin
fi

info "Configuring firewall (SSH, HTTP, HTTPS)..."
# Allow the live SSH port (not just 22) so a non-default sshd is not locked out when ufw enables.
SSH_PORT="$(ss -tnlpH 2>/dev/null | awk '/sshd/{n=split($4,a,":"); print a[n]; exit}')"
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT:-22}/tcp"
ufw allow ssh
ufw allow http
ufw allow https
ufw --force enable

info "Writing nginx config for $DOMAIN..."

cat > /etc/nginx/conf.d/cyphras-relayer-limits.conf <<'EOF'
limit_req_zone $binary_remote_addr zone=relayer_api:10m rate=5r/s;
EOF

cat > "/etc/nginx/sites-available/$DOMAIN" <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    add_header X-Content-Type-Options     nosniff      always;
    add_header X-Frame-Options            DENY         always;
    add_header Referrer-Policy            no-referrer  always;
    add_header Strict-Transport-Security  "max-age=31536000; includeSubDomains" always;

    # Public relayer API: /v1/info, /v1/relay, /v1/health
    location /v1/ {
        limit_req  zone=relayer_api burst=20 nodelay;
        proxy_pass        http://127.0.0.1:8080;
        proxy_set_header  Host               \$host;
        proxy_set_header  X-Real-IP          \$remote_addr;
        # Overwrite, never append, so a direct client cannot forge an upstream hop to dodge
        # the per-IP rate limit. The relayer must run with TRUST_PROXY_HOPS=1.
        proxy_set_header  X-Forwarded-For    \$remote_addr;
        proxy_set_header  X-Forwarded-Proto  \$scheme;
    }

    # Metrics: localhost only (e.g. a Prometheus on this host). Add your monitoring IP if needed.
    location = /metrics {
        allow 127.0.0.1;
        deny all;
        proxy_pass        http://127.0.0.1:8080;
        proxy_set_header  Host \$host;
    }

    location / { return 404; }
}
EOF

ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
info "nginx configured."

info "Obtaining TLS certificate for $DOMAIN..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LETSENCRYPT_EMAIL" --redirect
systemctl reload nginx

info "Building and starting the relayer stack..."
docker compose up -d --build

info "Waiting for the relayer to become healthy..."
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:8080/v1/health >/dev/null 2>&1; then
        info "Relayer is healthy."
        break
    fi
    if [ "$i" -eq 30 ]; then
        warn "Relayer not healthy after 60s. Check: docker compose logs relayer"
    fi
    sleep 2
done

info "Setup complete."
echo ""
echo "  API     : https://$DOMAIN/v1/info/fee"
echo "  Health  : https://$DOMAIN/v1/health"
echo "  Logs    : docker compose -f $APP_DIR/docker-compose.yml logs -f"
echo "  Update  : cd $APP_DIR && git pull && docker compose up -d --build"
echo ""
echo "  Next: fund the relayer master wallet (and any RELAYER_EXTRA_SECRETS),"
echo "        then point your client at https://$DOMAIN"
echo ""
