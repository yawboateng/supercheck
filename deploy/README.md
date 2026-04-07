# Supercheck Deployment

Self-host Supercheck on your own infrastructure.

> **Linux Required:** Supercheck uses K3s and gVisor for sandboxed test execution, which require the Linux kernel. Only Linux servers (Ubuntu 22.04+, Debian 12+) are supported. macOS, Windows, and WSL2 are not supported.

## Quick Deploy

[![Deploy on Coolify](https://img.shields.io/badge/Deploy%20on-Coolify-6B16ED?style=for-the-badge&logo=coolify&logoColor=white)](./coolify/README.md)

Coolify template deployment on [Coolify](https://coolify.io).

## Docker Compose

For manual deployment with Docker Compose:

```bash
git clone https://github.com/supercheck-io/supercheck.git
cd supercheck/deploy/docker

# Generate secrets and set up the execution sandbox
sudo bash init-secrets.sh
sudo bash setup-k3s.sh

# Start services
KUBECONFIG_FILE=/etc/rancher/k3s/supercheck-worker.kubeconfig docker compose up -d
```

See [docker/README.md](docker/README.md) for detailed configuration options.

## Kubernetes (Helm)

For deployment on Kubernetes with Helm:

```bash
# Default (dev/testing — all services, no ingress)
helm install supercheck ./deploy/helm/supercheck

# Production (all services + ingress + TLS)
helm install supercheck ./deploy/helm/supercheck \
  -f deploy/helm/supercheck/values-production.yaml
```

See [helm/supercheck/README.md](helm/supercheck/README.md) for full configuration.

## Platform Guides

| Platform | Guide |
|----------|-------|
| **Coolify** | [Deploy on Coolify](coolify/README.md) |
| **Kubernetes** | [Helm Chart](helm/supercheck/README.md) |

## Documentation

Full documentation: **[supercheck.io/docs/app/deployment](https://supercheck.io/docs/app/deployment)**
