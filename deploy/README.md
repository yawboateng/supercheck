# Supercheck Deployment

Self-host Supercheck on your own infrastructure.

## Quick Deploy

[![Deploy on Coolify](https://img.shields.io/badge/Deploy%20on-Coolify-6B16ED?style=for-the-badge&logo=coolify&logoColor=white)](./coolify/README.md)

Coolify template deployment on [Coolify](https://coolify.io) with host-level K3s + gVisor bootstrap for the execution plane.

## Docker Compose

For manual deployment with Docker Compose:

```bash
git clone https://github.com/supercheck-io/supercheck.git
cd supercheck/deploy/docker

# Generate secure secrets
sudo bash init-secrets.sh

# Install local K3s + gVisor for the execution plane
sudo bash setup-k3s.sh

# Start services
KUBECONFIG_FILE=/etc/rancher/k3s/supercheck-worker.kubeconfig docker compose up -d
```

See [docker/README.md](docker/README.md) for detailed configuration options.

## Platform Guides

| Platform | Guide |
|----------|-------|
| **Coolify** | [Deploy on Coolify](coolify/README.md) |

## Documentation

Full documentation: **[supercheck.io/docs/app/deployment](https://supercheck.io/docs/app/deployment)**
