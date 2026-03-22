# Sandboxed Execution with gVisor: Architecture & Hardening

## Overview

Since v1.3.0, Supercheck executes all Playwright and k6 tests inside **ephemeral Kubernetes Jobs** running under [gVisor](https://gvisor.dev/) (`runtimeClassName: gvisor`). This replaces the earlier Docker-socket-based execution model and represents a significant improvement in security, isolation, and operational control.

This issue documents the motivation, trade-offs, and planned hardening for the gVisor execution model.

## Labels

`enhancement`, `security`, `execution`, `gvisor`, `documentation`

## Why We Moved to gVisor

### Previous Model: Docker Socket

Workers mounted the host Docker socket (`/var/run/docker.sock`) and spawned test containers as sibling containers using `docker run`. While simple to set up, this had fundamental limitations:

- **Security risk** — Docker socket access grants root-equivalent privileges on the host. A compromised test could escape to the host via volume mounts or privileged containers.
- **No kernel-level isolation** — Tests shared the host kernel with no syscall filtering. Malicious or buggy test code could impact other workloads.
- **No resource boundaries** — No enforcement of CPU/memory limits per test execution at the orchestration level.
- **Tight coupling** — Workers were bound to nodes with Docker installed; Kubernetes-native scheduling and affinity were not leveraged.

### Current Model: gVisor + Kubernetes Jobs

Each test run creates a short-lived Kubernetes Job in a dedicated `supercheck-execution` namespace. Jobs use gVisor's `runsc` runtime, which interposes a userspace kernel (the "Sentry") between the test process and the host kernel.

**Key benefits:**

- **Kernel-level isolation** — gVisor intercepts all syscalls; test code never directly touches the host kernel, even if it attempts privilege escalation.
- **Namespace-level security** — The execution namespace enforces the `restricted` Pod Security Standard (`runAsNonRoot`, no privilege escalation, no host access).
- **Network segmentation** — NetworkPolicy denies access to the Kubernetes API server, cloud metadata endpoints, and internal services. Only outbound HTTP/HTTPS is permitted.
- **Resource control** — LimitRange and ResourceQuota prevent runaway pods from exhausting cluster resources.
- **No Docker socket** — Workers interact with the Kubernetes API only. No elevated host access is required.
- **Unified execution model** — Both self-hosted (Docker Compose + K3s) and cloud deployments use the same Kubernetes Job execution backend.

### Trade-offs

| Concern | Docker Socket | gVisor + K8s Jobs |
|---------|---------------|-------------------|
| **Security** | Root-on-host via socket | Kernel-level syscall interception |
| **Setup complexity** | Low (Docker only) | Higher (K3s/K8s + gVisor runtime) |
| **Memory overhead** | Minimal | ~150 MB for gVisor Sentry + `/dev/shm` accounting |
| **Pod startup latency** | Fast (container reuse) | Slightly higher (Job creation + scheduling) |
| **Artifact extraction** | `docker cp` | `kubectl exec` + `tar` over WebSocket |
| **Self-hosted support** | Docker Compose only | Docker Compose + local K3s |

## Planned Hardening

The following improvements are planned to further strengthen the execution model:

### Completed Hardening

1. **Full execution-pod security lockdown** — Execution Jobs now run with `readOnlyRootFilesystem`, dropped capabilities, explicit non-root IDs, and `seccompProfile: RuntimeDefault` alongside gVisor.

2. **Network policy refinement** — Execution pods now block private ranges, metadata endpoints, and link-local addresses while allowing only DNS and outbound TCP to public IPs.

3. **Pod lifecycle optimization** — The post-execution pod wait is now bounded and exit-signal driven instead of an infinite sleep loop.

### Remaining Improvements

### Medium Priority

4. **Resource quota tuning** — Align ResourceQuota and LimitRange values with `MAX_CONCURRENT_EXECUTIONS` config to prevent namespace-level resource exhaustion.

5. **Execution metrics** — Add Prometheus metrics for pod creation latency, execution duration, exit code distribution, timeout/cancellation rates, and artifact extraction failures.

### Low Priority

6. **Structured audit logging** — Emit JSON-formatted lifecycle events (created, started, completed, cancelled, timed out) with run ID correlation for the observability pipeline.

7. **PodDisruptionBudget for workers** — Prevent worker eviction during active execution job management. Ensure `terminationGracePeriodSeconds` accounts for in-flight jobs.

## Acceptance Criteria

- [x] Execution pods run with full security context lockdown
- [x] Network policy blocks access to internal services and metadata endpoints
- [ ] Resource quotas prevent execution namespace exhaustion
- [x] Pod lifecycle uses bounded wait instead of infinite sleep
- [ ] All changes remain backward-compatible with self-hosted Docker Compose deployments

## Related Files

- `worker/src/common/security/container-executor.service.ts` — Main execution service
- `deploy/k8s/base/` — Kubernetes manifests (gVisor RuntimeClass, RBAC, NetworkPolicy, ResourceQuota)
- `deploy/k8s/base/execution-namespace.yaml` — Execution namespace with `restricted` PSS
