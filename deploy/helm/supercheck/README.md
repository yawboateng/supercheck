# Supercheck Helm Chart

Deploy [Supercheck](https://supercheck.io) — a self-hosted test execution platform with Playwright and K6 — on Kubernetes.

Supports three ingress providers: **Istio**, **Traefik**, and **Kubernetes Ingress** (nginx, HAProxy, Contour, etc.).

## Prerequisites

- Kubernetes 1.26+
- Helm 3.x
- One of the following (for production deployments):
  - [Istio](https://istio.io/latest/docs/setup/install/) with ingress gateway
  - [Traefik](https://doc.traefik.io/traefik/providers/kubernetes-crd/) with CRD provider
  - Any [Kubernetes Ingress controller](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/) (nginx-ingress, HAProxy, Contour, etc.)
- `kubectl` configured for your cluster

## Quick Start

```bash
# Default (dev/testing — all services, no ingress)
helm install supercheck ./deploy/helm/supercheck

# Production (all services + ingress + TLS)
helm install supercheck ./deploy/helm/supercheck \
  -f deploy/helm/supercheck/values-production.yaml

# External managed databases (no Postgres/Redis/MinIO pods)
helm install supercheck ./deploy/helm/supercheck \
  -f deploy/helm/supercheck/values-external.yaml

# Remote worker only (connects to main instance)
helm install supercheck-worker ./deploy/helm/supercheck \
  -f deploy/helm/supercheck/values-worker.yaml
```

## Deployment Models

This chart maps directly to the four Docker Compose deployment files:

| Values File | Compose Equivalent | Services Deployed |
|---|---|---|
| `values.yaml` (default) | `docker-compose.yml` | App, Worker, PostgreSQL, Redis, MinIO |
| `values-production.yaml` | `docker-compose-secure.yml` | All services + Ingress/TLS |
| `values-external.yaml` | `docker-compose-external.yml` | App, Worker + Ingress (external DBs) |
| `values-worker.yaml` | `docker-compose-worker.yml` | Worker only |

## Architecture

```
              ┌──────────────────────────────────┐
              │         Ingress Provider         │
              │  (Istio / Traefik / nginx / ...) │
              └───────────────┬──────────────────┘
                              │
               app.domain.com │ *.domain.com (status pages)
                              │
                     ┌────────▼─────────┐
                     │    App (Next.js) │
                     │   replicas: 1-N  │
                     └────────┬─────────┘
                              │
               ┌──────────────┼──────────────┐
               │              │              │
      ┌────────▼───┐  ┌──────▼───┐  ┌───────▼──────┐
      │ PostgreSQL │  │  Redis   │  │ MinIO (S3)   │
      │ StatefulSet│  │ Stateful │  │ StatefulSet  │
      └────────────┘  └──────────┘  └──────────────┘
                              │
                     ┌────────▼─────────┐
                     │   Worker (NestJS)│
                     │   replicas: 1-N  │
                     └────────┬─────────┘
                              │ K8s API (creates Jobs)
                              │
              ┌───────────────▼───────────────┐
              │   supercheck-execution (ns)   │
              │  ┌─────┐ ┌─────┐ ┌─────┐      │
              │  │ Job │ │ Job │ │ Job │ ...  │
              │  └─────┘ └─────┘ └─────┘      │
              │  ResourceQuota + NetworkPolicy│
              │  RuntimeClass: gvisor (opt.)  │
              └───────────────────────────────┘
```

### Test Execution Model

The worker does **not** use Docker socket. Instead, it creates **ephemeral Kubernetes Jobs**
in the `supercheck-execution` namespace via the Kubernetes API. This means:

- Works natively on any Kubernetes cluster (EKS, GKE, AKS, K3s, etc.)
- No Docker daemon required on nodes
- Test pods are fully isolated with ResourceQuota, LimitRange, and NetworkPolicy
- Optional gVisor RuntimeClass for kernel-level sandbox isolation

## Ingress Providers

Set `ingress.provider` to choose your ingress controller. Each provider only renders
its own templates — no conflicts between them.

### Istio

Uses Istio `Gateway` + `VirtualService` resources. Supports mTLS between services via
`PeerAuthentication`.

```yaml
ingress:
  enabled: true
  provider: istio
  hosts:
    app: "app.example.com"
    statusPages: "*.example.com"
  tls:
    enabled: true
    secretName: supercheck-tls  # must be in istio-system namespace
  istio:
    gatewaySelector:
      istio: ingressgateway
    tlsMode: SIMPLE
    peerAuthentication:
      enabled: true
      mode: STRICT
```

```bash
# Create TLS secret in istio-system
kubectl create secret tls supercheck-tls \
  --cert=fullchain.pem --key=privkey.pem -n istio-system
```

### Traefik

Uses Traefik `IngressRoute` and `Middleware` CRDs. Includes automatic HTTP-to-HTTPS
redirect and HSTS headers when TLS is enabled.

```yaml
ingress:
  enabled: true
  provider: traefik
  hosts:
    app: "app.example.com"
    statusPages: "*.example.com"
  tls:
    enabled: true
    secretName: supercheck-tls  # in release namespace
  traefik:
    entryPoints:
      - web
      - websecure
    certManagerIssuer: "letsencrypt-prod"  # optional: auto-provision certs
```

```bash
# Manual TLS secret (skip if using cert-manager)
kubectl create secret tls supercheck-tls \
  --cert=fullchain.pem --key=privkey.pem
```

### Kubernetes Ingress (nginx, HAProxy, Contour, etc.)

Uses the standard `networking.k8s.io/v1` `Ingress` resource. Works with any
Ingress controller.

```yaml
ingress:
  enabled: true
  provider: ingress
  hosts:
    app: "app.example.com"
    statusPages: "*.example.com"
  tls:
    enabled: true
    secretName: supercheck-tls
  kubernetes:
    className: nginx
    annotations:
      nginx.ingress.kubernetes.io/proxy-body-size: "50m"
      nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
    certManagerIssuer: "letsencrypt-prod"  # optional
```

```bash
# Manual TLS secret (skip if using cert-manager)
kubectl create secret tls supercheck-tls \
  --cert=fullchain.pem --key=privkey.pem
```

## Configuration

### Minimal Production Setup

Create a `my-values.yaml`:

```yaml
ingress:
  enabled: true
  provider: istio  # or "traefik" or "ingress"
  hosts:
    app: "app.example.com"
    statusPages: "*.example.com"
  tls:
    enabled: true
    secretName: supercheck-tls

config:
  appUrl: "https://app.example.com"
  appDomain: "app.example.com"
  statusPageDomain: "example.com"

  auth:
    betterAuthSecret: ""      # openssl rand -hex 32
    secretEncryptionKey: ""    # openssl rand -hex 32

  database:
    password: ""               # set a strong password

  redis:
    password: ""               # set a strong password

  s3:
    accessKeyId: ""
    secretAccessKey: ""
```

Then install:

```bash
helm install supercheck ./deploy/helm/supercheck -f my-values.yaml
```

### Key Parameters

#### Component Toggles

| Parameter | Description | Default |
|---|---|---|
| `app.enabled` | Deploy the Next.js app | `true` |
| `worker.enabled` | Deploy the worker | `true` |
| `postgres.enabled` | Deploy in-cluster PostgreSQL | `true` |
| `redis.enabled` | Deploy in-cluster Redis | `true` |
| `minio.enabled` | Deploy in-cluster MinIO | `true` |
| `ingress.enabled` | Enable ingress | `false` |
| `ingress.provider` | Ingress provider (`istio`, `traefik`, `ingress`) | `istio` |

#### App

| Parameter | Description | Default |
|---|---|---|
| `app.replicas` | Number of app replicas | `1` |
| `app.image.repository` | App image repository | `ghcr.io/supercheck-io/supercheck/app` |
| `app.resources.limits.cpu` | CPU limit | `1` |
| `app.resources.limits.memory` | Memory limit | `2Gi` |
| `app.resources.requests.cpu` | CPU request | `500m` |
| `app.resources.requests.memory` | Memory request | `1Gi` |

#### Worker

| Parameter | Description | Default |
|---|---|---|
| `worker.replicas` | Number of worker replicas | `1` |
| `worker.image.repository` | Worker image repository | `ghcr.io/supercheck-io/supercheck/worker` |
| `worker.serviceAccount.create` | Create ServiceAccount with RBAC | `true` |
| `worker.serviceAccount.name` | ServiceAccount name | `supercheck-worker` |
| `worker.resources.limits.cpu` | CPU limit | `1.8` |
| `worker.resources.limits.memory` | Memory limit | `3Gi` |

#### Execution Sandbox

| Parameter | Description | Default |
|---|---|---|
| `execution.namespace` | Namespace for test execution Jobs | `supercheck-execution` |
| `execution.createNamespace` | Create the namespace + security resources | `true` |
| `execution.runtimeClassName` | RuntimeClass for execution pods (`gvisor`, `runc`, `""`) | `gvisor` |
| `execution.nodeSelector` | Node selector for execution pods (key=value) | `""` |
| `execution.tolerationsJson` | Tolerations for execution pods (JSON) | `""` |
| `execution.dnsNameservers` | Custom DNS nameservers (comma-separated IPs) | `""` |
| `execution.networkPolicy.enabled` | Create NetworkPolicy for execution namespace | `true` |
| `execution.resourceQuota.maxJobs` | Max concurrent execution Jobs | `10` |
| `execution.resourceQuota.maxPods` | Max concurrent execution Pods | `10` |
| `execution.resourceQuota.limitsMemory` | Memory limit for all execution pods | `16Gi` |

#### Ingress — Common

| Parameter | Description | Default |
|---|---|---|
| `ingress.enabled` | Enable ingress resources | `false` |
| `ingress.provider` | Provider: `istio`, `traefik`, or `ingress` | `istio` |
| `ingress.hosts.app` | App hostname | `app.example.com` |
| `ingress.hosts.statusPages` | Status page wildcard hostname | `*.example.com` |
| `ingress.tls.enabled` | Enable TLS | `false` |
| `ingress.tls.secretName` | TLS secret name | `supercheck-tls` |

#### Ingress — Istio

| Parameter | Description | Default |
|---|---|---|
| `ingress.istio.gatewaySelector` | Istio ingress gateway selector labels | `{istio: ingressgateway}` |
| `ingress.istio.tlsMode` | TLS mode (`SIMPLE`, `MUTUAL`, `ISTIO_MUTUAL`) | `SIMPLE` |
| `ingress.istio.peerAuthentication.enabled` | Enable strict mTLS between services | `false` |
| `ingress.istio.peerAuthentication.mode` | PeerAuthentication mode | `STRICT` |

#### Ingress — Traefik

| Parameter | Description | Default |
|---|---|---|
| `ingress.traefik.entryPoints` | Traefik entrypoints | `[web, websecure]` |
| `ingress.traefik.certManagerIssuer` | cert-manager ClusterIssuer name | `""` |

#### Ingress — Kubernetes Ingress

| Parameter | Description | Default |
|---|---|---|
| `ingress.kubernetes.className` | Ingress class name | `nginx` |
| `ingress.kubernetes.annotations` | Additional Ingress annotations | `{}` |
| `ingress.kubernetes.certManagerIssuer` | cert-manager ClusterIssuer name | `""` |

#### Database

| Parameter | Description | Default |
|---|---|---|
| `config.database.url` | Full DATABASE_URL (overrides components) | `""` |
| `config.database.host` | PostgreSQL host | `supercheck-postgres` |
| `config.database.port` | PostgreSQL port | `5432` |
| `config.database.user` | PostgreSQL user | `postgres` |
| `config.database.password` | PostgreSQL password | `postgres` |
| `config.database.name` | Database name | `supercheck` |
| `postgres.persistence.size` | PVC size | `50Gi` |
| `postgres.persistence.storageClass` | Storage class | `""` (default) |

#### Redis

| Parameter | Description | Default |
|---|---|---|
| `config.redis.url` | Full REDIS_URL (overrides components) | `""` |
| `config.redis.host` | Redis host | `supercheck-redis` |
| `config.redis.password` | Redis password | `supersecure-redis-password-change-this` |
| `config.redis.tls.enabled` | Enable TLS for Redis | `false` |
| `redis.maxmemory` | Redis max memory | `256mb` |
| `redis.persistence.size` | PVC size | `5Gi` |

#### S3/MinIO

| Parameter | Description | Default |
|---|---|---|
| `config.s3.endpoint` | S3/MinIO endpoint | `http://supercheck-minio:9000` |
| `config.s3.region` | AWS region | `us-east-1` |
| `config.s3.accessKeyId` | Access key | `minioadmin` |
| `config.s3.secretAccessKey` | Secret key | `minioadmin` |
| `config.s3.forcePathStyle` | Force path-style URLs | `true` |
| `minio.persistence.size` | PVC size | `50Gi` |

#### General

| Parameter | Description | Default |
|---|---|---|
| `supercheckVersion` | Image tag for app and worker | `1.3.0` |
| `config.appUrl` | Public app URL | `http://localhost:3000` |
| `config.appDomain` | Domain for routing | `demo.supercheck.dev` |
| `config.statusPageDomain` | Status page wildcard domain | `supercheck.dev` |
| `config.selfHosted` | Enable unlimited features | `true` |
| `config.workerLocation` | Worker region (`local`, `us-east`, `eu-central`, `asia-pacific`) | `local` |
| `config.auth.betterAuthSecret` | Auth secret (change this) | `CHANGE_THIS_GENERATE_32_CHAR_HEX` |
| `config.auth.secretEncryptionKey` | Encryption key (change this) | `CHANGE_THIS_GENERATE_32_CHAR_HEX` |

## Scaling

### App replicas

```bash
helm upgrade supercheck ./deploy/helm/supercheck --set app.replicas=3
```

### Worker replicas

Keep `config.capacity.running` equal to total worker replicas:

```bash
helm upgrade supercheck ./deploy/helm/supercheck \
  --set worker.replicas=4 \
  --set config.capacity.running=4
```

### Multi-region workers

Deploy remote workers on separate clusters pointing to your main instance:

```bash
helm install supercheck-worker-eu ./deploy/helm/supercheck \
  -f values-worker.yaml \
  --set config.workerLocation=eu-central \
  --set config.database.url="postgresql://user:pass@main-db:5432/supercheck" \
  --set config.redis.host="main-redis.example.com" \
  --set config.s3.endpoint="http://main-minio.example.com:9000"
```

## TLS Setup

### Option 1: Manual TLS secret

```bash
# For Istio (secret must be in istio-system namespace)
kubectl create secret tls supercheck-tls \
  --cert=fullchain.pem --key=privkey.pem -n istio-system

# For Traefik or Kubernetes Ingress (secret in release namespace)
kubectl create secret tls supercheck-tls \
  --cert=fullchain.pem --key=privkey.pem
```

### Option 2: cert-manager (automated)

Install [cert-manager](https://cert-manager.io/docs/installation/) and create a
ClusterIssuer:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@example.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: istio  # or "nginx", "traefik"
```

Then reference it in your values:

```yaml
# For Istio — create a Certificate resource manually:
# (cert-manager doesn't auto-provision for Istio Gateway)
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: supercheck-tls
  namespace: istio-system
spec:
  secretName: supercheck-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - app.example.com
    - "*.example.com"
```

```yaml
# For Traefik — set the issuer in values:
ingress:
  traefik:
    certManagerIssuer: "letsencrypt-prod"
```

```yaml
# For Kubernetes Ingress — set the issuer in values:
ingress:
  kubernetes:
    certManagerIssuer: "letsencrypt-prod"
```

## Upgrading

```bash
# Update to a new Supercheck version
helm upgrade supercheck ./deploy/helm/supercheck \
  --set supercheckVersion=1.4.0

# Or update your values file and re-apply
helm upgrade supercheck ./deploy/helm/supercheck \
  -f values-production.yaml
```

## Uninstalling

```bash
helm uninstall supercheck
```

> **Note:** PersistentVolumeClaims for PostgreSQL, Redis, and MinIO are not deleted
> automatically. Remove them manually if you want to delete all data:
>
> ```bash
> kubectl delete pvc -l app.kubernetes.io/part-of=supercheck
> ```

## gVisor Setup (Optional)

For kernel-level sandbox isolation, install gVisor on your cluster nodes and create a
RuntimeClass:

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
overhead:
  podFixed:
    memory: "150Mi"
scheduling:
  nodeSelector:
    gvisor.io/enabled: "true"
```

If gVisor is not available, set `execution.runtimeClassName` to `""` or `runc`:

```bash
helm install supercheck ./deploy/helm/supercheck \
  --set execution.runtimeClassName=""
```

## Notes

- The **worker uses the Kubernetes API** (not Docker socket) to create ephemeral Jobs in
  the `supercheck-execution` namespace. A ServiceAccount with RBAC is created automatically.
- **PostgreSQL, Redis, and MinIO** use StatefulSets with PersistentVolumeClaims. Take
  regular backups of PostgreSQL data.
- Config and secret changes trigger **automatic pod restarts** via checksum annotations.
- When using `values-external.yaml`, set `config.redis.tls.enabled: true` for most cloud
  Redis providers (Upstash, Redis Cloud, ElastiCache).
- Only one ingress provider is active at a time — templates for other providers are not
  rendered.
- The execution namespace includes **ResourceQuota**, **LimitRange**, and **NetworkPolicy**
  to constrain test pods. The NetworkPolicy blocks access to internal cluster IPs and
  cloud metadata endpoints while allowing external egress.
