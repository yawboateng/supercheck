# Enhancement: gVisor Execution Hardening & Improvements

## Summary

Improve the gVisor-based Kubernetes Job execution model in `ContainerExecutorService` with better resource management, observability, and security hardening.

## Labels

`enhancement`, `security`, `execution`, `gvisor`

## Background

Since v1.3.0, all Playwright and K6 test execution runs as ephemeral Kubernetes Jobs in the `supercheck-execution` namespace with `runtimeClassName: gvisor`. The current implementation works but has several areas where hardening and optimization would improve reliability, security posture, and operational visibility.

## Proposed Improvements

### 1. Pod-Level Security Policy Enforcement

**Priority:** High

Currently, execution pods use `runAsNonRoot: true` and `automountServiceAccountToken: false`, but lack a full `PodSecurityContext` / `SecurityContext` lockdown.

**Changes:**
- Add `readOnlyRootFilesystem: true` with explicit `emptyDir` volume mounts for writable paths (`/tmp`, workspace)
- Set `allowPrivilegeEscalation: false` on the execution container
- Add `seccompProfile: { type: RuntimeDefault }` as defense-in-depth alongside gVisor
- Drop all Linux capabilities: `capabilities: { drop: ["ALL"] }`
- Set `runAsUser` / `runAsGroup` explicitly instead of relying on the image default

**Files:** `worker/src/common/security/container-executor.service.ts` → `buildExecutionJob()`

### 2. Network Policy for Execution Namespace

**Priority:** High

Execution pods currently inherit the default-allow network policy in `supercheck-execution`. Untrusted test code should have restricted network access.

**Changes:**
- Create a `NetworkPolicy` in `supercheck-execution` namespace that:
  - Denies all egress by default
  - Allows egress to the internet on ports 80/443 (tests need to hit external URLs)
  - Blocks access to the Kubernetes API server, cloud metadata endpoints (169.254.169.254), and internal services
  - Blocks egress to the worker namespace (`supercheck-workers`) and data namespace (`supercheck`)
- Optional: Add a per-test `allowPrivateNetwork` flag for tests that need internal connectivity

**Files:** `deploy/k8s/base/network-policy-execution.yaml` (new), `deploy/k8s/base/kustomization.yaml`

### 3. Resource Quota & LimitRange for Execution Namespace

**Priority:** Medium

Prevent resource exhaustion from runaway test pods.

**Changes:**
- Add a `LimitRange` in `supercheck-execution` to enforce default and max CPU/memory per pod
- Add a `ResourceQuota` to cap the total number of concurrent execution pods and aggregate resource consumption
- Derive quota values from `MAX_CONCURRENT_EXECUTIONS` and memory/CPU limit config

**Files:** `deploy/k8s/base/execution-resource-limits.yaml` (new)

### 4. Improved Pod Lifecycle & Exit Handling

**Priority:** Medium

The current wrapper script keeps the pod alive in an infinite `sleep` loop after execution completes so that logs and artifacts can be extracted. This wastes pod runtime until `activeDeadlineSeconds` (125s) expires.

**Changes:**
- Replace the infinite sleep with a bounded wait (e.g., 30s) after writing the exit code file
- Have the outer `waitForExecutionOutcome` send a signal or write a sentinel file to tell the pod it's safe to exit after log/artifact collection
- Add `preStop` lifecycle hook to flush logs before termination

**Files:** `worker/src/common/security/container-executor.service.ts` → `buildKubernetesWrapperScript()`

### 5. Execution Metrics & Observability

**Priority:** Medium

Add Prometheus metrics for execution pod lifecycle events.

**Changes:**
- Track: pod creation latency, execution duration, exit code distribution, timeout rate, cancellation rate, artifact extraction failures
- Expose via the worker's existing `/metrics` endpoint
- Add Grafana dashboard for execution pod health

**Files:** `worker/src/common/security/container-executor.service.ts`, `deploy/k8s/observability/`

### 6. Audit Trail for Execution Jobs

**Priority:** Low

Log structured audit events for execution job lifecycle (created, started, completed, cancelled, timed-out, failed) with run ID correlation.

**Changes:**
- Emit structured JSON log entries at each lifecycle transition
- Include: `runId`, `jobName`, `podName`, `exitCode`, `duration`, `timedOut`, `cancelled`
- Integrate with existing Loki/Alloy log pipeline

### 7. PodDisruptionBudget for Worker Pods

**Priority:** Low

Ensure graceful draining during node maintenance — worker pods should not be evicted while actively managing execution jobs.

**Changes:**
- Add `PodDisruptionBudget` for worker deployments (`minAvailable: 1` per location)
- Ensure `terminationGracePeriodSeconds` on workers accounts for in-flight execution job completion

**Files:** `deploy/k8s/base/worker-pdb.yaml` (new)

## Acceptance Criteria

- [ ] Execution pods run with full security context lockdown (read-only root, no privilege escalation, all capabilities dropped)
- [ ] Network policy blocks execution pod access to internal services and metadata endpoints
- [ ] Resource quotas prevent execution namespace exhaustion
- [ ] Pod sleep loop is replaced with bounded wait + signal-based exit
- [ ] Prometheus metrics track execution pod lifecycle
- [ ] All changes are backward-compatible with self-hosted Docker Compose deployments (gVisor features degrade gracefully)

## Related

- `worker/src/common/security/container-executor.service.ts` — main execution service
- `deploy/k8s/base/network-policy-workers.yaml` — existing worker network policy
- `deploy/k8s/base/worker-deployment.yaml` — worker deployment spec
- Memory note: `/memories/repo/gvisor-execution-model.md`
