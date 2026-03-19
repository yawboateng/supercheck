# Docker Compose Configurations

Production-ready Docker Compose files for self-hosting Supercheck.

## Quick Start

```bash
git clone https://github.com/supercheck-io/supercheck.git
cd supercheck/deploy/docker

# Generate secrets
sudo bash init-secrets.sh

# Install local K3s + gVisor for the execution plane
sudo bash setup-k3s.sh

# Edit .env for optional integrations (SMTP, AI, OAuth)
nano .env

# Start self-hosted stack with the same Kubernetes Job execution model used in cloud
KUBECONFIG_FILE=/etc/rancher/k3s/supercheck-worker.kubeconfig docker compose up -d

# Or start (production with HTTPS)
KUBECONFIG_FILE=/etc/rancher/k3s/supercheck-worker.kubeconfig docker compose -f docker-compose-secure.yml up -d
```

## Prerequisites

> **Modern Docker Compose Required**: Use `docker compose` (with space), not `docker-compose` (with hyphen).

```bash
docker compose version
# Should show: Docker Compose version v2.x.x or higher
```

**Install Docker:**
- **Linux (supported for self-hosted execution)**: `curl -fsSL https://get.docker.com | sh`
- **macOS/Windows**: fine for evaluation only, but not the supported self-hosted execution target

---

## Available Configurations

| File | Use Case |
|------|----------|
| `docker-compose.yml` | Self-hosted deployment with local K3s-backed execution (HTTP, localhost:3000) |
| `docker-compose-secure.yml` | Production with HTTPS and local K3s-backed execution |
| `docker-compose-worker.yml` | Remote regional worker with local K3s-backed execution |
| `docker-compose-local.yml` | Source-based local development with the same K3s-backed execution model |

---

## Environment Variables

Use `./init-secrets.sh` to generate secure defaults, then configure:

### Base (all deployments)

| Variable | Description |
|----------|-------------|
| `SELF_HOSTED` | Self-hosted mode toggle (default: `true`) |
| `SIGNUP_ENABLED` | Toggle open email/password signup (default: `true`) |
| `ALLOWED_EMAIL_DOMAINS` | Optional comma-separated signup allowlist (default: empty = allow all) |
| `STATUS_PAGE_HIDE_BRANDING` | Hide the `Powered by Supercheck` footer on all public status and incident pages when set to `true` (default: `false`) |

OAuth (`GITHUB_*` / `GOOGLE_*`) is optional in self-hosted mode.

### Production (docker-compose-secure.yml)

| Variable | Description |
|----------|-------------|
| `APP_DOMAIN` | Your domain (e.g., `app.yourdomain.com`) |
| `ACME_EMAIL` | Email for Let's Encrypt |
| `STATUS_PAGE_DOMAIN` | Base hostname for status pages (e.g., `yourdomain.com`) |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Optional GitHub social sign-in | - |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional Google social sign-in | - |
| `SMTP_HOST`, `SMTP_FROM_EMAIL` (+ optional `SMTP_USER`/`SMTP_PASSWORD`) | Email notifications (disabled if SMTP_HOST not set) | - |
| `AI_PROVIDER` | AI provider (`openai`, `azure`, `anthropic`, `gemini`, `google-vertex`, `bedrock`, `openrouter`) | `openai` |
| `AI_MODEL` | AI model name | `gpt-4o-mini` |
| `OPENAI_API_KEY` | AI features (for default OpenAI provider) | - |
| `WORKER_REPLICAS` | Number of worker containers (worker-side scaling knob) | `1` |
| `RUNNING_CAPACITY` | App-side gate: max concurrent test runs (set equal to `WORKER_REPLICAS`) | `1` |
| `QUEUED_CAPACITY` | App-side gate: max queued test runs before new submissions are rejected | `10` |
| `WORKER_LOCATION` | Worker queue mode (`local` for single-server self-hosted, or any enabled Super Admin location code) | `local` |

---

## Scaling Workers

```bash
# Scale to 2 worker replicas (2 concurrent executions)
WORKER_REPLICAS=2 RUNNING_CAPACITY=2 QUEUED_CAPACITY=20 \
KUBECONFIG_FILE=/etc/rancher/k3s/supercheck-worker.kubeconfig \
docker compose up -d
```

`RUNNING_CAPACITY` and `QUEUED_CAPACITY` are **App-side** settings. The App uses them to gate how many runs can be in `running` and `queued` states before submissions are throttled or rejected. Keep `RUNNING_CAPACITY` aligned with total worker replicas so the gate matches actual execution throughput.

For single-server deployments, keep `WORKER_LOCATION=local` so one worker processes all regional queues.

---

## gVisor Sandbox (Required)

Production self-hosted deployments now use the same execution model as cloud: the worker always creates per-run Jobs in the local `supercheck-execution` namespace. Those Jobs use `runtimeClassName: gvisor`, so Playwright and k6 always execute under gVisor regardless of whether you are self-hosting or running in cloud Kubernetes.

The Docker worker container runs as a standard Docker container (no special runtime). It is only the control plane — untrusted code executes exclusively inside gVisor-sandboxed Kubernetes execution Jobs, never inside the long-lived worker container.

### Installation

For production self-hosted installs, use the K3s bootstrap:

```bash
sudo bash setup-k3s.sh
```

This installs K3s, installs gVisor, configures containerd with the `runsc` runtime, creates the `gvisor` RuntimeClass, creates the `supercheck-execution` namespace, applies the execution `LimitRange`, `ResourceQuota`, and `NetworkPolicy`, and writes a restricted worker kubeconfig to `/etc/rancher/k3s/supercheck-worker.kubeconfig` for the Compose worker to mount.

> **Linux host recommended:** self-hosted execution should use Docker Engine on Linux plus local K3s. Docker Desktop adds an extra VM layer and is not the supported production target.

---

## Backups

```bash
# Create backup
docker compose exec postgres pg_dump -U postgres supercheck > backup.sql

# Restore backup
docker compose exec -T postgres psql -U postgres supercheck < backup.sql
```

---

## Documentation

Full documentation: **[supercheck.io/docs/app/deployment](https://supercheck.io/docs/app/deployment)**
