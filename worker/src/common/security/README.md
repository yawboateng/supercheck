# Security Module - Container Execution

This module provides secure execution of user-supplied scripts using Docker container isolation with comprehensive security controls.

## Features

### 🔒 Security Controls

1. **Container Isolation**
   - Scripts run in isolated Docker containers
   - Read-only root filesystem
   - No privilege escalation (`--security-opt=no-new-privileges`)
   - All Linux capabilities dropped (`--cap-drop=ALL`)
   - Non-root user execution (UID 1000)

2. **Resource Limits**
   - CPU limit (default: 50% of one CPU)
   - Memory limit (default: 512MB)
   - Process limit (max 100 processes)
   - Execution timeout enforcement

3. **Input Validation**
   - Path traversal prevention
   - Command injection protection
   - Argument sanitization
   - Dangerous pattern detection

4. **Automatic Cleanup**
   - Containers auto-removed after execution
   - No local file accumulation (container-based cleanup)
   - Graceful timeout handling

### 🛡️ Defense in Depth

The module implements multiple security layers:

1. **Input Validation** (`path-validator.ts`)
   - Validates all file paths
   - Sanitizes command arguments
   - Blocks dangerous patterns

2. **Container Execution** (`container-executor.service.ts`)
   - Docker-based isolation
   - Resource constraints
   - Network isolation options

3. **Mandatory Container Execution**
   - Container execution is required for all tests
   - No fallback to direct execution
   - Clear error messages when Docker is unavailable

## Usage

### Container Execution Options

```typescript
interface ContainerExecutionOptions {
  timeoutMs?: number; // Execution timeout (default: 300000ms)
  memoryLimitMb?: number; // Memory limit (default: 512MB)
  cpuLimit?: number; // CPU fraction (default: 0.5 = 50%)
  env?: Record<string, string>; // Environment variables
  workingDir?: string; // Working directory (default: /worker)
  image?: string; // Docker image override
  networkMode?: 'none' | 'bridge' | 'host'; // Network mode (default: none)
  autoRemove?: boolean; // Auto-remove container (default: true)
}
```

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────┐
│              ExecutionService                        │
│  (Main orchestrator for test execution)             │
└─────────────────┬───────────────────────────────────┘
                  │
                  │ calls executeCommandSafely()
                  ▼
┌─────────────────────────────────────────────────────┐
│          executeCommandSafely()                      │
│  (Container execution wrapper)                      │
│                                                      │
│  Always uses ContainerExecutorService               │
│            (mandatory container execution)          │
└────────────────────────────────────┬────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────┐
│       ContainerExecutorService                       │
│                                                      │
│  1. Validate paths/arguments                        │
│  2. Check Docker availability                       │
│  3. Build secure Docker command                     │
│  4. Execute with resource limits                    │
│  5. Monitor and cleanup                             │
└─────────────────┬───────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────┐
│              Path Validator                          │
│  - Path traversal prevention                        │
│  - Command injection protection                     │
│  - Argument sanitization                            │
└─────────────────────────────────────────────────────┘
```

### Execution Flow

```
User Script Submission
        │
        ▼
┌─────────────────┐
│ Input Validation│
│  (path-validator)│
└────────┬────────┘
         │ ✓ Valid
         ▼
┌─────────────────┐
│ Docker Available?│
└────────┬────────┘
         │
    Yes  │   No (Error)
         │   │
         ▼   ▼
┌──────────────────────┐
│ Container Execution  │
│  - Build secure cmd  │
│  - Apply limits      │
│  - Mount directories │
│  - Execute & monitor │
│  - Cleanup           │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Results & Artifacts │
└──────────────────────┘
```

## Security Guarantees

### Playwright Docker Best Practices

Following [Playwright Docker recommendations](https://playwright.dev/docs/docker) for all browsers (Chromium, Firefox, WebKit/Safari):

| Flag                               | Purpose                                | Browsers                                   | Implementation                  |
| ---------------------------------- | -------------------------------------- | ------------------------------------------ | ------------------------------- |
| `--user pwuser`                    | Non-root execution for untrusted code  | All                                        | ✅ Required - security critical |
| `--security-opt seccomp=...`       | Enable Chromium sandbox as non-root    | Chromium                                   | ✅ Custom seccomp profile       |
| `--init`                           | Avoid zombie processes (PID 1 issues)  | All                                        | ✅ Added to container executor  |
| `--ipc=host`                       | Chromium IPC - prevents memory crashes | Chromium (required), Firefox/WebKit (safe) | ✅ Added to container executor  |
| `--shm-size=512m`                  | Shared memory for browser processes    | All (especially Chromium)                  | ✅ Already configured           |
| `--security-opt=no-new-privileges` | Prevent privilege escalation           | All                                        | ✅ Already configured           |

**CRITICAL: Non-Root Execution**

Since Supercheck executes **user-provided code** (untrusted), we MUST run containers as non-root:

```bash
# How containers are run (simplified)
docker run \
  --user pwuser \
  --security-opt seccomp=seccomp_profile.json \
  --init \
  --ipc=host \
  --security-opt=no-new-privileges \
  --cap-drop=ALL \
  mcr.microsoft.com/playwright:v1.57.0-noble
```

- **`--user pwuser`**: Runs as non-root user (UID 1000) in Playwright image
- **`seccomp_profile.json`**: Enables Chromium sandbox by allowing user namespace syscalls (clone, setns, unshare)
- This enables the Chromium sandbox which provides additional isolation from the host system

**Browser Support:**

- **Chromium** (Chrome/Edge): Default browser, requires `--ipc=host` and seccomp profile for sandbox
- **Firefox**: Uses `@firefox` tag, works with same settings
- **WebKit** (Safari): Uses `@webkit` or `@safari` tag, works with same settings

### Seccomp Profile

The `seccomp_profile.json` file is based on Docker's default seccomp profile with additional permissions for Chromium's sandbox:

```json
{
  "comment": "Allow create user namespaces - required for Chromium sandbox",
  "names": ["clone", "clone3", "setns", "unshare"],
  "action": "SCMP_ACT_ALLOW"
}
```

This allows Chromium to create user namespaces for sandboxing while maintaining security restrictions.

### What's Protected

✅ **Non-Root Execution** - Runs as pwuser (UID 1000), not root
✅ **Chromium Sandbox** - Enabled via seccomp profile for additional isolation
✅ **Path Traversal** - All paths validated, no `../` or `~` allowed
✅ **Command Injection** - No shell interpolation, argument arrays only
✅ **Resource DoS** - CPU, memory, and process limits enforced
✅ **Privilege Escalation** - Non-root user, no new privileges, capabilities dropped
✅ **File System Access** - Limited write access, isolated workspace
✅ **Network Access** - Configurable network isolation
✅ **Code Execution** - Sandboxed environment, auto-cleanup

### Attack Surface Reduction

| Attack Vector           | Mitigation                                       |
| ----------------------- | ------------------------------------------------ |
| Root privilege abuse    | Non-root user (pwuser), all capabilities dropped |
| Browser sandbox escape  | Chromium sandbox enabled via seccomp profile     |
| Malicious script paths  | Path validation + sanitization                   |
| Shell command injection | Argument arrays, no shell interpolation          |
| Infinite loops          | Timeout enforcement                              |
| Memory bombs            | Memory limits (512MB default, no swap)           |
| Fork bombs              | Process limits (256 max)                         |
| File system attacks     | Isolated workspace, limited write paths          |
| Network attacks         | Network isolation options (default: none)        |
| Privilege escalation    | --security-opt=no-new-privileges                 |

## Monitoring & Debugging

### Check Container Status

```bash
# List active supercheck containers
docker ps --filter "name=supercheck-exec-*"

# View container logs
docker logs <container-name>

# Inspect container
docker inspect <container-name>
```

### Enable Debug Logging

Set log level in your environment:

```env
LOG_LEVEL=debug
```

Debug logs include:

- Container execution attempts
- Fallback decisions
- Path validation results
- Resource usage
- Cleanup operations

### Cleanup Orphaned Processes

The service automatically cleans up child processes via SIGTERM → SIGKILL grace period, but you can also manually check:

```bash
# Check for any orphaned execution processes
ps aux | grep playwright
```

## Performance Considerations

### Execution Overhead

- **Spawn time**: ~100-500ms (child_process.spawn)
- **gVisor overhead**: ~50-100ms additional syscall interception

### Optimization Tips

1. **Pre-install browsers**: Ensure Playwright browsers are pre-installed in the worker image
2. **Tune resource limits**: Adjust CPU/memory for your workload
3. **Use gVisor `platform=systrap`**: Recommended for best syscall interception performance

## Troubleshooting

### Execution is not working

**Check worker logs:**

```bash
# View worker logs for execution errors
docker compose logs worker | grep -i "execution\|error"
```

**Check gVisor availability (production):**

```bash
# Verify gVisor runtime is available
runsc --version
```

### Performance issues

If executions are slow:

1. **Check resource limits**: Ensure adequate CPU/memory
2. **Monitor process count**: High process counts may indicate resource contention
3. **Review gVisor logs**: Check for syscall compatibility issues

## Security Best Practices

1. **Always use gVisor sandboxing in production**
2. **Regularly update worker images** to patch vulnerabilities
3. **Monitor resource usage** to detect anomalies
4. **Review execution logs** for suspicious activity
5. **Use network isolation** when tests don't need network
6. **Implement rate limiting** for test submissions
7. **Monitor orphaned processes** and clean up regularly

## Contributing

When adding new features:

1. Maintain backward compatibility
2. Add tests for new security controls
3. Document configuration options
4. Update this README
5. Follow the principle of least privilege

## References

- [gVisor Documentation](https://gvisor.dev/docs/)
- [Playwright in Docker](https://playwright.dev/docs/docker)
- [Kubernetes RuntimeClass](https://kubernetes.io/docs/concepts/containers/runtime-class/)
