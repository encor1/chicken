# VPS Deployment

This deploy directory runs the game as one container behind an existing Traefik proxy. The Node server serves the built Vite client, `/ws` handles websocket traffic, and `/health` is used by the Docker healthcheck.

## Prerequisites

- Docker and the Docker Compose plugin installed on the VPS.
- Traefik already running on an external Docker network, usually named `traefik`.
- DNS for your game domain pointing at the VPS.
- The GitHub Actions Docker workflow has pushed `ghcr.io/OWNER/REPOSITORY:latest`.

If the GHCR package is private, log in on the VPS:

```bash
docker login ghcr.io
```

Use a GitHub token with package read access.

## Checkout Only `deploy/`

Use Git sparse checkout so the VPS only keeps this deployment folder:

```bash
mkdir -p /opt/moorhuhn
cd /opt/moorhuhn
git init
git remote add origin https://github.com/OWNER/REPOSITORY.git
git sparse-checkout init --cone
git sparse-checkout set deploy
git pull origin master
```

For a private repo, use an SSH remote or an HTTPS token URL instead.

## Configure

```bash
cd /opt/moorhuhn/deploy
cp .env.example .env
nano .env
```

Set:

- `DOMAIN` to the public hostname Traefik should route.
- `IMAGE` to the image published by GitHub Actions, for example `ghcr.io/acme/moorhuhn:latest`.
- `TRAEFIK_NETWORK`, `TRAEFIK_ENTRYPOINT`, and `TRAEFIK_CERT_RESOLVER` to match your Traefik setup.

## Start Or Update

```bash
cd /opt/moorhuhn/deploy
docker compose pull
docker compose up -d
docker compose ps
```

To deploy a new image after GitHub Actions completes:

```bash
cd /opt/moorhuhn
git pull origin master
cd deploy
docker compose pull
docker compose up -d
```
