# Deploying To A VPS

This guide starts after GitHub Actions has successfully built and pushed the Docker image to GitHub Container Registry.

The deployment runs one application container behind Traefik:

- Fastify serves the API, `/health`, websocket endpoint `/ws`, and the built Vite client.
- Traefik terminates TLS and routes the public domain to the container.
- Docker Compose on the VPS pulls the image built by GitHub Actions.

## What You Need On The VPS

- A Linux VPS with SSH access.
- Docker Engine.
- Docker Compose plugin.
- Git.
- Traefik already running.
- A Docker network shared with Traefik, usually named `traefik`.
- DNS for the game domain pointing to the VPS.
- Access to pull the GitHub Container Registry image.

Check the basic tools:

```bash
docker --version
docker compose version
git --version
```

Check that the Traefik network exists:

```bash
docker network ls
```

If your Traefik network is not named `traefik`, use its real name later in `TRAEFIK_NETWORK`.

## Image Published By GitHub Actions

The GitHub Actions workflow publishes:

```text
ghcr.io/OWNER/REPOSITORY:latest
ghcr.io/OWNER/REPOSITORY:<commit-sha>
```

For example:

```text
ghcr.io/acme/moorhuhn:latest
```

If the package is public, the VPS can usually pull it without logging in.

If the package is private, log in on the VPS:

```bash
docker login ghcr.io
```

Use your GitHub username and a GitHub token with package read access.

## Checkout Only The Deploy Folder

The VPS does not need the full repository. Use Git sparse checkout:

```bash
sudo mkdir -p /opt/moorhuhn
sudo chown "$USER":"$USER" /opt/moorhuhn
cd /opt/moorhuhn

git init
git remote add origin https://github.com/OWNER/REPOSITORY.git
git sparse-checkout init --cone
git sparse-checkout set deploy
git pull origin main
```

For a private repository, use an SSH remote instead:

```bash
git remote add origin git@github.com:OWNER/REPOSITORY.git
```

If you already added the HTTPS remote, replace it:

```bash
git remote set-url origin git@github.com:OWNER/REPOSITORY.git
```

## Configure The Deployment

Create the environment file:

```bash
cd /opt/moorhuhn/deploy
cp .env.example .env
nano .env
```

Set these values:

```env
COMPOSE_PROJECT_NAME=moorhuhn
DOMAIN=game.example.com
IMAGE=ghcr.io/OWNER/REPOSITORY:latest
TRAEFIK_NETWORK=traefik
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_CERT_RESOLVER=letsencrypt
```

Use your real domain and image name.

`TRAEFIK_ENTRYPOINT` and `TRAEFIK_CERT_RESOLVER` must match your Traefik configuration. Common values are `websecure` and `letsencrypt`.

Validate the Compose file before starting:

```bash
docker compose config
```

## First Deploy

Pull the image and start the container:

```bash
cd /opt/moorhuhn/deploy
docker compose pull
docker compose up -d
docker compose ps
```

Check logs:

```bash
docker compose logs -f game
```

Check the app through Traefik:

```bash
curl -I https://game.example.com
curl https://game.example.com/health
```

Replace `game.example.com` with your real domain.

## Updating After A New GitHub Actions Build

After a new image has been built and pushed by GitHub Actions:

```bash
cd /opt/moorhuhn
git pull origin main

cd deploy
docker compose pull
docker compose up -d
docker compose ps
```

If you deploy immutable commit tags instead of `latest`, update `IMAGE` in `.env` to the new `ghcr.io/OWNER/REPOSITORY:<commit-sha>` tag before running `docker compose pull`.

## Useful Operations

Restart:

```bash
cd /opt/moorhuhn/deploy
docker compose restart
```

Stop:

```bash
cd /opt/moorhuhn/deploy
docker compose down
```

Show logs:

```bash
cd /opt/moorhuhn/deploy
docker compose logs -f game
```

See the exact deployed image:

```bash
cd /opt/moorhuhn/deploy
docker compose images
```

## Troubleshooting

If Traefik does not route to the game:

```bash
docker network inspect traefik
docker compose ps
docker compose logs game
```

Confirm the game container is attached to the same external network Traefik uses.

If TLS certificates are not created, check:

- `DOMAIN` points to the VPS public IP.
- `TRAEFIK_ENTRYPOINT` matches your Traefik HTTPS entrypoint.
- `TRAEFIK_CERT_RESOLVER` matches your Traefik certificate resolver.
- Traefik logs show no ACME errors.

If the image pull fails:

```bash
docker login ghcr.io
docker pull ghcr.io/OWNER/REPOSITORY:latest
```

For private packages, make sure the token has package read access.

If the page loads but multiplayer does not connect, check websocket routing through the same domain:

```bash
curl https://game.example.com/health
```

The browser should connect to:

```text
wss://game.example.com/ws
```
