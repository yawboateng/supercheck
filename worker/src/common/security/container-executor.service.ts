/**
 * Secure Script Execution Service
 *
 * Production execution backend:
 *
 * - `kubernetes`: Used for both cloud and self-hosted Docker/K3s deployments.
 *   Creates an ephemeral Job in the
 *   `supercheck-execution` namespace so untrusted code is isolated away from the
 *   long-lived worker control plane.
 */

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import * as path from 'path';
import * as tar from 'tar';
import type * as k8s from '@kubernetes/client-node';
import { Readable, Writable } from 'stream';
import { finished } from 'stream/promises';
import { CancellationService } from '../services/cancellation.service';

export interface ContainerExecutionOptions {
  /**
   * Run ID for cancellation tracking.
   * If provided, the executor will poll for cancellation signals.
   */
  runId?: string;

  /**
   * Timeout in milliseconds.
   */
  timeoutMs?: number;

  /**
   * Memory limit in megabytes (validated but advisory — actual enforcement
   * is at the container runtime level via Docker/K8s resource limits).
   */
  memoryLimitMb?: number;

  /**
   * CPU limit (fraction of CPU, e.g., 0.5 for 50%).
   * Validated but advisory — actual enforcement is at the container runtime level.
   */
  cpuLimit?: number;

  /**
   * Environment variables to pass to the execution process.
   */
  env?: Record<string, string>;

  /**
   * Working directory for the child process.
   */
  workingDir?: string;

  /**
   * Container image (ignored — included for caller compatibility).
   */
  image?: string;

  /**
   * Network mode (reserved for future use).
   */
  networkMode?: 'none' | 'bridge' | 'host';

  /**
   * Whether to remove container after execution (reserved for future use).
   */
  autoRemove?: boolean;

  /**
   * Path to extract after execution (same local filesystem).
   */
  extractFromContainer?: string;

  /**
   * Host path where extracted files should be placed.
   * Required if extractFromContainer is specified.
   */
  extractToHost?: string;

  /**
   * Inline script content to write before execution.
   */
  inlineScriptContent?: string;

  /**
   * Filename for inline script (required if inlineScriptContent is provided).
   * Example: 'test.spec.ts'
   */
  inlineScriptFileName?: string;

  /**
   * Additional files to write before execution.
   * Key: relative path, Value: file content.
   */
  additionalFiles?: Record<string, string>;

  /**
   * Directories to create before execution.
   */
  ensureDirectories?: string[];

  /**
   * Streaming hooks for stdout/stderr chunks (used for live log streaming).
   */
  onStdoutChunk?: (chunk: string) => void | Promise<void>;
  onStderrChunk?: (chunk: string) => void | Promise<void>;
}

export interface ContainerExecutionResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
  error?: string;
}

/** Internal validated resource limits */
interface ValidatedLimits {
  valid: boolean;
  error?: string;
  memoryLimitMb: number;
  cpuLimit: number;
  timeoutMs: number;
}

@Injectable()
export class ContainerExecutorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContainerExecutorService.name);
  private static readonly WORKSPACE_ROOT = '/tmp/supercheck';
  private readonly activeCancellationIntervals: Set<NodeJS.Timeout> =
    new Set();

  /** Max combined stdout+stderr size in bytes (10 MB) */
  private static readonly MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

  /** Max artifact tar archive size in bytes (100 MB) */
  private static readonly MAX_ARTIFACT_ARCHIVE_BYTES = 100 * 1024 * 1024;

  /**
   * Memory overhead added to the pod memory limit to account for:
   * - gVisor Sentry process (~100 MB)
   * - /dev/shm tmpfs counts against cgroup memory in K8s (unlike Docker --shm-size)
   *
   * In Docker, --memory and --shm-size are independent limits.
   * In Kubernetes, emptyDir with medium: Memory counts against the container's
   * cgroup memory limit.  Without this headroom, tests that used close to the
   * Docker memory ceiling will OOM under K8s/gVisor.
   */
  private static readonly SHM_SIZE_MB = 512;
  private static readonly GVISOR_SENTRY_OVERHEAD_MB = 150;
  private static readonly TOTAL_MEMORY_OVERHEAD_MB =
    ContainerExecutorService.SHM_SIZE_MB +
    ContainerExecutorService.GVISOR_SENTRY_OVERHEAD_MB;

  /** Allowed filename pattern: alphanumeric, dots, hyphens, underscores */
  private static readonly SAFE_FILENAME_RE = /^[\w.\-]+$/;
  private readonly defaultImage: string;
  private readonly executionNamespace: string;
  private k8sModule: typeof import('@kubernetes/client-node') | null = null;
  private kubeConfig: k8s.KubeConfig | null = null;
  private batchApi: k8s.BatchV1Api | null = null;
  private coreApi: k8s.CoreV1Api | null = null;
  private logClient: k8s.Log | null = null;
  private execClient: k8s.Exec | null = null;
  private readonly runningJobs: Map<string, string> = new Map();

  constructor(
    private configService: ConfigService,
    private cancellationService: CancellationService,
  ) {
    this.defaultImage = this.configService.get<string>(
      'WORKER_IMAGE',
      'ghcr.io/supercheck-io/supercheck/worker:latest',
    );
    this.executionNamespace = this.configService.get<string>(
      'EXECUTION_NAMESPACE',
      'supercheck-execution',
    );
  }

  async onModuleInit(): Promise<void> {
    await this.ensureKubernetesClients();
    this.logger.log('Container executor initialized');
    this.logger.log(`Execution namespace: ${this.executionNamespace}`);
    this.logger.log(`Default execution image: ${this.defaultImage}`);
  }

  async onModuleDestroy(): Promise<void> {
    // Clear all cancellation intervals
    for (const interval of this.activeCancellationIntervals) {
      clearInterval(interval);
    }
    this.activeCancellationIntervals.clear();

    const jobCleanup = Array.from(this.runningJobs.entries()).map(
      async ([runId, jobName]) => {
        this.logger.warn(`Deleting orphaned execution job ${jobName} for ${runId}`);
        await this.deleteExecutionJob(jobName);
      },
    );
    await Promise.allSettled(jobCleanup);
    this.runningJobs.clear();
  }

  // =====================================================================
  //  PUBLIC API
  // =====================================================================

  /**
   * Resolves the worker directory. Returns `/worker` if it exists (Docker),
   * otherwise falls back to `process.cwd()` (local dev).
   */
  async resolveWorkerDir(): Promise<string> {
    try {
      await fs.access('/worker');
      return '/worker';
    } catch {
      return process.cwd();
    }
  }

  /**
   * Resolves the Playwright browsers path. Returns `/ms-playwright` if it
   * exists (Docker image with pre-installed browsers), otherwise `undefined`
   * so Playwright falls back to its system default (e.g. ~/Library/Caches/ms-playwright).
   */
  async resolveBrowsersPath(): Promise<string | undefined> {
    try {
      await fs.access('/ms-playwright');
      return '/ms-playwright';
    } catch {
      return undefined;
    }
  }

  /**
   * Executes a script as a child process inside the worker container.
   *
   * All callers (execution.service.ts, k6-execution.service.ts) pass the
   * same arguments — gVisor isolation is transparent at the runtime level.
   */
  async executeInContainer(
    scriptPath: string | null,
    command: string[],
    options: ContainerExecutionOptions = {},
  ): Promise<ContainerExecutionResult> {
    // Validate that scriptPath is null (legacy mode is not supported)
    if (scriptPath !== null) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr:
          'Legacy mode with scriptPath is no longer supported. Use inlineScriptContent instead.',
        duration: 0,
        timedOut: false,
        error: 'Legacy execution mode not supported',
      };
    }

    // Validate inline script options
    if (!options.inlineScriptContent) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: 'inlineScriptContent is required for container execution',
        duration: 0,
        timedOut: false,
        error: 'Missing inline script content',
      };
    }

    if (!options.inlineScriptFileName) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr:
          'inlineScriptFileName is required when using inlineScriptContent',
        duration: 0,
        timedOut: false,
        error: 'Missing script filename',
      };
    }

    // Validate filename safety — reject path traversal and shell metacharacters
    if (
      !ContainerExecutorService.SAFE_FILENAME_RE.test(
        options.inlineScriptFileName,
      )
    ) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: `Invalid script filename: ${options.inlineScriptFileName}`,
        duration: 0,
        timedOut: false,
        error: 'Script filename contains invalid characters',
      };
    }

    // Validate additionalFiles keys — no path traversal, no absolute paths
    if (options.additionalFiles) {
      for (const filePath of Object.keys(options.additionalFiles)) {
        if (
          filePath.includes('..') ||
          filePath.startsWith('/') ||
          !filePath
        ) {
          return {
            success: false,
            exitCode: 1,
            stdout: '',
            stderr: `Invalid additional file path: ${filePath}`,
            duration: 0,
            timedOut: false,
            error: 'Additional file path contains invalid characters',
          };
        }
      }
    }

    // Validate extraction options
    if (options.extractFromContainer && !options.extractToHost) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr:
          'extractToHost is required when extractFromContainer is specified',
        duration: 0,
        timedOut: false,
        error: 'Invalid extraction configuration',
      };
    }

    // Default options
    const {
      timeoutMs = 300000,
      memoryLimitMb = 512,
      cpuLimit = 0.5,
    } = options;

    // Validate resource limits
    const validatedLimits = this.validateResourceLimits({
      memoryLimitMb,
      cpuLimit,
      timeoutMs,
    });

    if (!validatedLimits.valid) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: validatedLimits.error || 'Invalid resource limits',
        duration: 0,
        timedOut: false,
        error: validatedLimits.error,
      };
    }

    return this.executeInKubernetes(command, options, validatedLimits);
  }

  private async ensureKubernetesClients(): Promise<void> {
    if (this.kubeConfig && this.batchApi && this.coreApi && this.logClient && this.execClient) {
      return;
    }

    const k8sModule =
      this.k8sModule || (await import('@kubernetes/client-node'));
    this.k8sModule = k8sModule;

    const kubeConfig = new k8sModule.KubeConfig();
    kubeConfig.loadFromDefault();

    this.kubeConfig = kubeConfig;
    this.batchApi = kubeConfig.makeApiClient(k8sModule.BatchV1Api);
    this.coreApi = kubeConfig.makeApiClient(k8sModule.CoreV1Api);
    this.logClient = new k8sModule.Log(kubeConfig);
    this.execClient = new k8sModule.Exec(kubeConfig);
  }

  private async executeInKubernetes(
    command: string[],
    options: ContainerExecutionOptions,
    limits: ValidatedLimits,
  ): Promise<ContainerExecutionResult> {
    const startTime = Date.now();
    const workspace = this.buildWorkspacePath(options.runId);
    const shellScript = this.buildShellScript(
      { ...options, _workspace: workspace },
      command,
    );
    const jobName = this.buildExecutionJobName(options.runId);
    const workingDir = options.workingDir || '/worker';

    let podName: string | null = null;
    let logAbort: AbortController | null = null;
    let cancellationInterval: NodeJS.Timeout | null = null;
    let killed = false;
    let timedOut = false;
    let combinedLogs = '';
    const logCollector = this.createLogCollector(options);

    try {
      await this.ensureKubernetesClients();

      const job = this.buildExecutionJob({
        jobName,
        workspace,
        shellScript,
        workingDir,
        limits,
        options,
      });

      await this.batchApi!.createNamespacedJob({
        namespace: this.executionNamespace,
        body: job,
      });

      if (options.runId) {
        this.runningJobs.set(options.runId, jobName);
        cancellationInterval = this.startKubernetesCancellationPoller(
          options.runId,
          jobName,
          () => {
            killed = true;
          },
        );
      }

      podName = await this.waitForExecutionPod(jobName);

      logAbort = this.startLogStreamWithReconnect(
        podName,
        logCollector.stream,
        jobName,
      );

      const outcome = await this.waitForExecutionOutcome(
        podName,
        workspace,
        limits.timeoutMs,
      );
      timedOut = outcome.timedOut;
      killed = killed || outcome.cancelled;

      if (options.extractFromContainer && options.extractToHost && !timedOut && !killed) {
        const extractSource = this.rewriteTmpPath(options.extractFromContainer, workspace);
        try {
          await this.extractPodArtifacts(podName, extractSource, options.extractToHost, workspace);
        } catch (extractError) {
          this.logger.error(
            `Failed to extract pod artifacts: ${
              extractError instanceof Error ? extractError.message : String(extractError)
            }`,
          );
        }
      }

      if (logAbort) {
        logAbort.abort();
      }

      combinedLogs = logCollector.getOutput();
      const finalLogs = await this.fetchPodLogsSnapshot(podName).catch(
        () => combinedLogs,
      );
      if (finalLogs.length >= combinedLogs.length) {
        combinedLogs = finalLogs;
      }

      const duration = Date.now() - startTime;
      const exitCode = killed
        ? 137
        : (outcome.exitCode ?? (timedOut ? 124 : 1));

      return {
        success: exitCode === 0 && !timedOut && !killed,
        exitCode,
        stdout: combinedLogs,
        stderr: '',
        duration,
        timedOut,
        error: timedOut
          ? `Execution timed out after ${limits.timeoutMs}ms`
          : killed
            ? 'Execution cancelled (exit code 137)'
            : exitCode !== 0
              ? outcome.message || `Process exited with code ${exitCode}`
              : undefined,
      };
    } catch (error) {
      return {
        success: false,
        exitCode: 1,
        stdout: logCollector.getOutput(),
        stderr: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
        timedOut,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (logAbort) {
        logAbort.abort();
      }
      if (cancellationInterval) {
        clearInterval(cancellationInterval);
        this.activeCancellationIntervals.delete(cancellationInterval);
      }
      if (options.runId) {
        this.runningJobs.delete(options.runId);
      }
      await this.deleteExecutionJob(jobName);
    }
  }

  private buildExecutionJob(params: {
    jobName: string;
    workspace: string;
    shellScript: string;
    workingDir: string;
    limits: ValidatedLimits;
    options: ContainerExecutionOptions;
  }): k8s.V1Job {
    const { jobName, workspace, shellScript, workingDir, limits, options } = params;
    const image = options.image || this.defaultImage;
    const envVars = this.buildKubernetesEnv(options.env, workspace);
    const deadlineSeconds = Math.ceil((limits.timeoutMs + 120_000) / 1000);
    const resourceCpuLimit = `${Math.max(100, Math.round(limits.cpuLimit * 1000))}m`;
    const resourceCpuRequest = `${Math.max(100, Math.round(limits.cpuLimit * 500))}m`;
    // Add overhead for /dev/shm tmpfs (counts against cgroup in K8s) and gVisor Sentry
    const effectiveMemoryMb = limits.memoryLimitMb + ContainerExecutorService.TOTAL_MEMORY_OVERHEAD_MB;
    const resourceMemoryLimit = `${effectiveMemoryMb}Mi`;
    const resourceMemoryRequest = `${Math.max(128, Math.round(effectiveMemoryMb * 0.75))}Mi`;
    const exitCodeFile = this.getWorkspaceExitCodeFile(workspace);
    const wrappedScript = this.buildKubernetesWrapperScript(shellScript, exitCodeFile);
    const runLabel = this.buildLabelValue(options.runId);

    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace: this.executionNamespace,
        labels: {
          'app.kubernetes.io/managed-by': 'supercheck-worker',
          'app.kubernetes.io/component': 'execution',
          'supercheck.io/run-id': runLabel,
        },
      },
      spec: {
        ttlSecondsAfterFinished: 600,
        backoffLimit: 0,
        activeDeadlineSeconds: deadlineSeconds,
        template: {
          metadata: {
            labels: {
              'app.kubernetes.io/managed-by': 'supercheck-worker',
              'app.kubernetes.io/component': 'execution',
              'supercheck.io/run-id': runLabel,
            },
          },
          spec: {
            runtimeClassName: 'gvisor',
            restartPolicy: 'Never',
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            nodeSelector: {
              workload: 'worker',
            },
            terminationGracePeriodSeconds: 1,
            tolerations: [
              {
                key: 'workload',
                operator: 'Equal',
                value: 'worker',
                effect: 'NoSchedule',
              },
            ],
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'execution',
                image,
                imagePullPolicy: 'IfNotPresent',
                command: ['/bin/sh', '-c', wrappedScript],
                workingDir,
                env: envVars,
                resources: {
                  requests: {
                    cpu: resourceCpuRequest,
                    memory: resourceMemoryRequest,
                  },
                  limits: {
                    cpu: resourceCpuLimit,
                    memory: resourceMemoryLimit,
                  },
                },
                securityContext: {
                  runAsNonRoot: true,
                  runAsUser: 1000,
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: {
                    drop: ['ALL'],
                  },
                  seccompProfile: {
                    type: 'RuntimeDefault',
                  },
                },
                volumeMounts: [
                  {
                    name: 'tmp',
                    mountPath: '/tmp',
                  },
                  {
                    name: 'dshm',
                    mountPath: '/dev/shm',
                  },
                ],
              },
            ],
            volumes: [
              {
                name: 'tmp',
                emptyDir: {},
              },
              {
                name: 'dshm',
                emptyDir: {
                  medium: 'Memory',
                  sizeLimit: `${ContainerExecutorService.SHM_SIZE_MB}Mi`,
                },
              },
            ],
          },
        },
      },
    };
  }

  private buildKubernetesWrapperScript(
    shellScript: string,
    exitCodeFile: string,
  ): string {
    const escapedExitCodeFile = this.escapeShellArg(exitCodeFile);
    return [
      `(${shellScript})`,
      'EXIT_CODE=$?',
      `printf '%s' "$EXIT_CODE" > ${escapedExitCodeFile}`,
      "trap 'exit 0' TERM INT",
      'while true; do sleep 5; done',
    ].join('; ');
  }

  private buildKubernetesEnv(
    env: Record<string, string> | undefined,
    workspace: string,
  ): k8s.V1EnvVar[] {
    const merged = new Map<string, string>([
      ['HOME', `${workspace}/home`],
      ['npm_config_cache', `${workspace}/.npm`],
      ['NPM_CONFIG_CACHE', `${workspace}/.npm`],
      ['TMPDIR', workspace],
      ['TEMP', workspace],
      ['TMP', workspace],
    ]);

    if (env) {
      for (const [name, value] of Object.entries(env)) {
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          merged.set(name, this.rewriteTmpPath(value, workspace));
        }
      }
    }

    return Array.from(merged.entries()).map(([name, value]) => ({
      name,
      value,
    }));
  }

  private buildExecutionJobName(runId?: string): string {
    const suffix = crypto
      .createHash('sha256')
      .update(runId || crypto.randomUUID())
      .digest('hex')
      .slice(0, 20);
    return `sc-exec-${suffix}`;
  }

  private buildLabelValue(value?: string): string {
    const normalized = (value || crypto.randomUUID())
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!normalized) {
      return 'unknown';
    }
    return normalized.slice(0, 63);
  }

  private async waitForExecutionPod(jobName: string): Promise<string> {
    const timeoutAt = Date.now() + 120_000;
    const labelSelector = `job-name=${jobName}`;

    while (Date.now() < timeoutAt) {
      const pods = await this.coreApi!.listNamespacedPod({
        namespace: this.executionNamespace,
        labelSelector,
      });
      const pod = pods.items[0];
      if (pod?.metadata?.name) {
        return pod.metadata.name;
      }
      await this.sleep(1000);
    }

    throw new Error(`Execution pod for job ${jobName} did not appear within 120s`);
  }

  private createLogCollector(options: ContainerExecutionOptions): {
    stream: Writable & {
      suppressLiveForwarding: () => void;
      resumeLiveForwarding: () => void;
    };
    getOutput: () => string;
    suppressLiveForwarding: () => void;
    resumeLiveForwarding: () => void;
  } {
    let output = '';
    let suppressLive = false;
    const stream = new Writable({
      write: (chunk, _encoding, callback) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (output.length < ContainerExecutorService.MAX_OUTPUT_BYTES) {
          output += text;
        }
        // Skip forwarding during reconnect replay to avoid duplicating
        // lines in the live console. The buffer still accumulates for the
        // final snapshot (which replaces it anyway).
        if (!suppressLive && options.onStdoutChunk) {
          try {
            void options.onStdoutChunk(text);
          } catch {
            /* ignore log callback failures */
          }
        }
        callback();
      },
    });
    const streamWithControls = Object.assign(stream, {
      suppressLiveForwarding: () => {
        suppressLive = true;
      },
      resumeLiveForwarding: () => {
        suppressLive = false;
      },
    });

    return {
      stream: streamWithControls,
      getOutput: () => output,
      suppressLiveForwarding: streamWithControls.suppressLiveForwarding,
      resumeLiveForwarding: streamWithControls.resumeLiveForwarding,
    };
  }

  /**
   * Start log streaming with automatic reconnect on network errors.
   *
   * K8s log follow streams can disconnect prematurely due to API server
   * timeouts, load-balancer idle timeouts, or transient network blips.
   * When the stream drops, we wait briefly and reconnect using
   * `sinceSeconds` so the API server resumes from roughly where we left
   * off (duplicates are harmless — the collector appends to the same
   * buffer and the final snapshot replaces it anyway).
   *
   * Completion is determined by `waitForExecutionOutcome()` (exit-code
   * file polling), NOT by the log stream lifecycle.
   *
   * On reconnect, `sinceSeconds: 5` replays the last few seconds to
   * avoid gaps. The collector's live-forwarding is suppressed during
   * the replay window so duplicate lines are not published to the
   * live console via `onStdoutChunk`.
   */
  private startLogStreamWithReconnect(
    podName: string,
    sink: Writable & { suppressLiveForwarding?: () => void; resumeLiveForwarding?: () => void },
    jobName: string,
  ): AbortController {
    const controller = new AbortController();
    const reconnectDelayMs = 2_000;
    const maxReconnects = 10;
    const sinceSecondsOnReconnect = 5;

    const connect = async (attempt: number) => {
      if (controller.signal.aborted) return;

      // On reconnect, suppress live forwarding for the replay window
      // to prevent duplicating lines in the user-visible streaming output.
      let replayTimer: ReturnType<typeof setTimeout> | null = null;
      if (attempt > 0 && sink.suppressLiveForwarding) {
        sink.suppressLiveForwarding();
        // Resume after the replay window (sinceSeconds + reconnect delay buffer)
        replayTimer = setTimeout(() => {
          sink.resumeLiveForwarding?.();
          replayTimer = null;
        }, (sinceSecondsOnReconnect + 1) * 1_000);
      }

      try {
        const abort = await this.logClient!.log(
          this.executionNamespace,
          podName,
          'execution',
          sink,
          {
            follow: true,
            timestamps: false,
            ...(attempt > 0 ? { sinceSeconds: sinceSecondsOnReconnect } : {}),
          },
        );

        // When the outer controller is aborted, also abort the active stream.
        const onAbort = () => abort.abort();
        controller.signal.addEventListener('abort', onAbort, { once: true });

        // Listen for the underlying response closing unexpectedly.
        // The K8s client resolves the log call immediately once the
        // stream is established; the actual data flows via piping.
        // We detect disconnects through the response's 'close' / 'error'
        // events surfacing on the underlying socket, which k8s client-node
        // propagates by aborting its own internal controller.
        abort.signal.addEventListener(
          'abort',
          () => {
            controller.signal.removeEventListener('abort', onAbort);
            if (replayTimer) {
              clearTimeout(replayTimer);
              sink.resumeLiveForwarding?.();
            }
            if (!controller.signal.aborted && attempt < maxReconnects) {
              this.logger.warn(
                `Log stream for ${jobName} disconnected (attempt ${attempt + 1}/${maxReconnects}), reconnecting in ${reconnectDelayMs}ms`,
              );
              setTimeout(() => connect(attempt + 1), reconnectDelayMs);
            }
          },
          { once: true },
        );
      } catch (error) {
        if (replayTimer) {
          clearTimeout(replayTimer);
          sink.resumeLiveForwarding?.();
        }
        if (controller.signal.aborted) return;
        if (attempt < maxReconnects) {
          this.logger.warn(
            `Failed to start log stream for ${jobName} (attempt ${attempt + 1}/${maxReconnects}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          setTimeout(() => connect(attempt + 1), reconnectDelayMs);
        } else {
          this.logger.warn(
            `Exhausted log stream reconnect attempts for ${jobName}; final logs will be fetched via snapshot`,
          );
        }
      }
    };

    void connect(0);
    return controller;
  }

  private async fetchPodLogsSnapshot(podName: string): Promise<string> {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write: (chunk, _encoding, callback) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        callback();
      },
    });

    await this.logClient!.log(
      this.executionNamespace,
      podName,
      'execution',
      sink,
      { follow: false, timestamps: false },
    );
    await finished(sink);

    return Buffer.concat(chunks).toString('utf8');
  }

  private async waitForExecutionOutcome(
    podName: string,
    workspace: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number; timedOut: boolean; cancelled: boolean; message?: string }> {
    const timeoutAt = Date.now() + timeoutMs;
    const exitCodeFile = this.getWorkspaceExitCodeFile(workspace);

    while (Date.now() < timeoutAt) {
      const exitCode = await this.readExecutionExitCode(podName, exitCodeFile);
      if (exitCode !== null) {
        return {
          exitCode,
          timedOut: false,
          cancelled: false,
        };
      }

      let pod;
      try {
        pod = await this.coreApi!.readNamespacedPod({
          name: podName,
          namespace: this.executionNamespace,
        });
      } catch (podError) {
        const msg = podError instanceof Error ? podError.message : String(podError);
        if (msg.includes('404') || msg.includes('NotFound') || msg.includes('not found')) {
          // Pod was deleted externally — most likely by the cancellation poller.
          // Treat as a user-initiated cancellation so processors record it correctly
          // instead of returning a generic exitCode=1 failure.
          this.logger.warn(
            `Pod ${podName} no longer exists — treating as cancellation`,
          );
          return {
            exitCode: 137,
            timedOut: false,
            cancelled: true,
            message: 'Pod deleted during execution (cancelled)',
          };
        }
        throw podError;
      }

      const terminated = pod.status?.containerStatuses
        ?.find((container) => container.name === 'execution')
        ?.state?.terminated;
      if (terminated) {
        const timedOut =
          terminated.reason === 'DeadlineExceeded' ||
          terminated.message?.includes('DeadlineExceeded') === true;
        return {
          exitCode: terminated.exitCode ?? (timedOut ? 124 : 1),
          timedOut,
          cancelled: terminated.exitCode === 137,
          message: terminated.message || terminated.reason,
        };
      }

      await this.sleep(1000);
    }

    return {
      exitCode: 124,
      timedOut: true,
      cancelled: false,
      message: `Execution timed out after ${timeoutMs}ms`,
    };
  }

  private async readExecutionExitCode(
    podName: string,
    exitCodeFile: string,
  ): Promise<number | null> {
    const command = [
      '/bin/sh',
      '-c',
      `if [ -f ${this.escapeShellArg(exitCodeFile)} ]; then cat ${this.escapeShellArg(exitCodeFile)}; fi`,
    ];
    const stdout = await this.execInPod(podName, command).catch((err) => {
      this.logger.debug(
        `Exit code read failed for ${podName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return '';
    });
    const trimmed = stdout.trim();
    if (!trimmed) {
      return null;
    }

    const exitCode = Number.parseInt(trimmed, 10);
    return Number.isFinite(exitCode) ? exitCode : null;
  }

  private async execInPod(podName: string, command: string[]): Promise<string> {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdout = new Writable({
      write: (chunk, _encoding, callback) => {
        stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        callback();
      },
    });
    const stderr = new Writable({
      write: (chunk, _encoding, callback) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        callback();
      },
    });

    const socket = await this.execClient!.exec(
      this.executionNamespace,
      podName,
      'execution',
      command,
      stdout,
      stderr,
      null,
      false,
    );

    await new Promise<void>((resolve, reject) => {
      socket.on('close', () => resolve());
      socket.on('error', (error) => reject(error));
    });

    const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
    if (stderrText) {
      this.logger.debug(`exec stderr from ${podName}: ${stderrText}`);
    }

    return Buffer.concat(stdoutChunks).toString('utf8');
  }

  private async extractPodArtifacts(
    podName: string,
    sourcePath: string,
    destPath: string,
    workspaceRoot: string,
  ): Promise<void> {
    const cleanSource = sourcePath.replace(/\/\.$/g, '');
    if (!this.isPathWithinBase(cleanSource, workspaceRoot)) {
      throw new Error(`Refusing to extract artifacts outside workspace: ${cleanSource}`);
    }

    const archive = await this.capturePodTarStream(podName, cleanSource);
    if (archive.length === 0) {
      this.logger.debug(`No artifacts found at ${cleanSource} in ${podName}`);
      return;
    }

    await fs.mkdir(destPath, { recursive: true });
    await this.validateTarArchive(archive);
    const extractor = tar.x({
      cwd: destPath,
      preservePaths: false,
      strict: true,
      filter: (entryPath, entry) => {
        this.validateTarEntry(entryPath, entry);
        return true;
      },
    });
    await finished(Readable.from(archive).pipe(extractor));
  }

  private async capturePodTarStream(
    podName: string,
    sourcePath: string,
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const stdout = new Writable({
      write: (chunk, _encoding, callback) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > ContainerExecutorService.MAX_ARTIFACT_ARCHIVE_BYTES) {
          callback(
            new Error(
              `Artifact archive exceeded ${ContainerExecutorService.MAX_ARTIFACT_ARCHIVE_BYTES} bytes`,
            ),
          );
          return;
        }
        chunks.push(buffer);
        callback();
      },
    });
    const stderrChunks: Buffer[] = [];
    const stderr = new Writable({
      write: (chunk, _encoding, callback) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        callback();
      },
    });

    const command = [
      '/bin/sh',
      '-c',
      `if [ -e ${this.escapeShellArg(sourcePath)} ]; then tar cf - -C ${this.escapeShellArg(sourcePath)} .; fi`,
    ];
    const socket = await this.execClient!.exec(
      this.executionNamespace,
      podName,
      'execution',
      command,
      stdout,
      stderr,
      null,
      false,
    );

    await new Promise<void>((resolve, reject) => {
      socket.on('close', () => resolve());
      socket.on('error', (error) => reject(error));
    });

    const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
    if (stderrText) {
      throw new Error(`tar extraction failed: ${stderrText}`);
    }

    return Buffer.concat(chunks);
  }

  private async validateTarArchive(archive: Buffer): Promise<void> {
    const parser = tar.t({
      onReadEntry: (entry) => {
        this.validateTarEntry(entry.path, entry);
        entry.resume();
      },
    });
    await finished(Readable.from(archive).pipe(parser));
  }

  private validateTarEntry(
    entryPath: string,
    entry: unknown,
  ): void {
    const normalized = entryPath.replace(/\\/g, '/');
    if (
      path.posix.isAbsolute(normalized) ||
      normalized.split('/').includes('..')
    ) {
      throw new Error(`Unsafe path in artifact archive: ${entryPath}`);
    }

    const disallowedTypes = new Set([
      'SymbolicLink',
      'Link',
      'CharacterDevice',
      'BlockDevice',
      'FIFO',
      'ContiguousFile',
    ]);
    const entryType =
      entry && typeof entry === 'object' && 'type' in entry
        ? (entry as { type?: string }).type
        : undefined;
    if (entryType && disallowedTypes.has(entryType)) {
      throw new Error(`Unsupported artifact entry type: ${entryType}`);
    }
  }

  private getWorkspaceExitCodeFile(workspace: string): string {
    return `${workspace}/.supercheck-exit-code`;
  }

  private rewriteTmpPath(value: string, workspace: string): string {
    if (value.startsWith('/tmp/')) {
      return `${workspace}/${value.slice(5)}`;
    }
    if (value === '/tmp' || value === '/tmp/') {
      return workspace;
    }
    return value;
  }

  private escapeShellArg(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private startKubernetesCancellationPoller(
    runId: string,
    jobName: string,
    onCancelled: () => void,
  ): NodeJS.Timeout {
    const interval = setInterval(() => {
      void (async () => {
        try {
          const isCancelled = await this.cancellationService.isCancelled(runId);
          if (!isCancelled) {
            return;
          }

          this.logger.warn(
            `[${runId}] Cancellation detected — deleting execution job ${jobName}`,
          );
          onCancelled();
          await this.deleteExecutionJob(jobName);
          await this.cancellationService.clearCancellationSignal(runId);
          clearInterval(interval);
          this.activeCancellationIntervals.delete(interval);
        } catch (error) {
          this.logger.error(
            `Cancellation check error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
    }, 1000);

    this.activeCancellationIntervals.add(interval);
    return interval;
  }

  private async deleteExecutionJob(jobName: string): Promise<void> {
    if (!jobName) {
      return;
    }

    try {
      await this.ensureKubernetesClients();
      await this.batchApi!.deleteNamespacedJob({
        name: jobName,
        namespace: this.executionNamespace,
        gracePeriodSeconds: 0,
        propagationPolicy: 'Background',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !message.includes('404') &&
        !message.includes('NotFound') &&
        !message.includes('not found')
      ) {
        this.logger.warn(`Failed to delete execution job ${jobName}: ${message}`);
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private buildWorkspacePath(runId?: string): string {
    const rawToken = runId || crypto.randomUUID();
    const safeToken = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex')
      .slice(0, 24);
    return `${ContainerExecutorService.WORKSPACE_ROOT}/run-${safeToken}`;
  }

  private isPathWithinBase(candidatePath: string, basePath: string): boolean {
    const relativePath = candidatePath.startsWith(basePath)
      ? candidatePath.slice(basePath.length)
      : null;
    return (
      relativePath !== null &&
      (relativePath.length === 0 || relativePath.startsWith('/'))
    );
  }

  // =====================================================================
  //  Shell script builder
  // =====================================================================

  /**
   * Builds the shell script that runs inside the execution environment.
   *
   * Base64-decodes inline scripts, creates directories, symlinks
   * node_modules, then executes the command.
   */
  buildShellScript(
    options: ContainerExecutionOptions & { _workspace?: string },
    command: string[],
  ): string {
    const shellCommands: string[] = [];

    // Per-run workspace: isolates each execution to prevent cross-tenant
    // file contamination (GVISOR-002). Production always uses a dedicated
    // hashed workspace under /tmp/supercheck.
    const ws = options._workspace || this.buildWorkspacePath(options.runId);
    shellCommands.push(`mkdir -p '${ws.replace(/'/g, "'\\''")}'`);

    // Ensure required directories exist before writing files
    if (options.ensureDirectories && options.ensureDirectories.length > 0) {
      const uniqueDirs = Array.from(new Set(options.ensureDirectories));
      for (const dir of uniqueDirs) {
        if (!dir || typeof dir !== 'string') {
          continue;
        }
        // Relocate /tmp-rooted paths into the isolated workspace
        const resolvedDir = dir.startsWith('/tmp/')
          ? `${ws}/${dir.slice(5)}`
          : dir === '/tmp'
            ? ws
            : dir;
        const escapedDir = resolvedDir.replace(/'/g, "'\\''");
        shellCommands.push(`mkdir -p '${escapedDir}'`);
      }
    }

    // Symlink node_modules into workspace so specs can resolve dependencies.
    // Each run gets its own symlink — no shared /tmp/node_modules.
    const wsEscaped = ws.replace(/'/g, "'\\''");
    shellCommands.push(
      `[ -d "$PWD/node_modules" ] && [ ! -e '${wsEscaped}/node_modules' ] && ln -s "$PWD/node_modules" '${wsEscaped}/node_modules' || true`,
    );

    // Write main script file via base64 decode
    // Filename is pre-validated by SAFE_FILENAME_RE in executeInContainer.
    const scriptContent = Buffer.from(options.inlineScriptContent!).toString(
      'base64',
    );
    const scriptPath = `${ws}/${options.inlineScriptFileName}`;
    const escapedScriptPath = scriptPath.replace(/'/g, "'\\''");
    shellCommands.push(
      `printf '%s' "${scriptContent}" | base64 -d > '${escapedScriptPath}'`,
    );
    shellCommands.push(`chmod +x '${escapedScriptPath}'`);

    // Write additional files if provided
    // Paths are pre-validated (no absolute, no '..') in executeInContainer.
    if (options.additionalFiles) {
      for (const [filePath, content] of Object.entries(
        options.additionalFiles,
      )) {
        const encodedContent = Buffer.from(content).toString('base64');
        const targetPath = `${ws}/${filePath}`;
        const escapedTarget = targetPath.replace(/'/g, "'\\''");
        // Ensure parent directory exists for nested files
        const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
        if (parentDir && parentDir !== ws) {
          shellCommands.push(`mkdir -p '${parentDir.replace(/'/g, "'\\''")}'`);
        }
        shellCommands.push(
          `printf '%s' "${encodedContent}" | base64 -d > '${escapedTarget}'`,
        );
      }
    }

    // Build the execution command with proper quoting.
    // Replace both the bare filename and /tmp/<filename> references with the
    // workspace-scoped path so callers that pass /tmp/ paths still work.
    const adjustedCommand = command.map((arg) => {
      if (arg === options.inlineScriptFileName) return scriptPath;
      // Rewrite /tmp/ prefixed paths to the per-run workspace
      if (arg.startsWith('/tmp/') && options._workspace) {
        return `${ws}/${arg.slice(5)}`;
      }
      if (arg === '/tmp/' && options._workspace) {
        return `${ws}/`;
      }
      return arg;
    });
    const quotedCommand = adjustedCommand
      .map((arg) => {
        if (/[\s|&;<>()$`"'\\]/.test(arg)) {
          return `'${arg.replace(/'/g, "'\\''")}'`;
        }
        return arg;
      })
      .join(' ');
    shellCommands.push(quotedCommand);

    return shellCommands.join(' && ');
  }

  // =====================================================================
  //  Resource limit validation
  // =====================================================================

  /**
   * Validates resource limits to prevent invalid configurations.
   */
  validateResourceLimits(limits: {
    memoryLimitMb: number;
    cpuLimit: number;
    timeoutMs: number;
  }): ValidatedLimits {
    const MIN_MEMORY_MB = 128;
    const MAX_MEMORY_MB = 8192;
    const MIN_CPU = 0.1;
    const MAX_CPU = 4.0;
    const MIN_TIMEOUT_MS = 5000;
    const MAX_TIMEOUT_MS = 3600000;

    const errors: string[] = [];

    if (limits.memoryLimitMb < MIN_MEMORY_MB) {
      errors.push(
        `memoryLimitMb (${limits.memoryLimitMb}) is below minimum ${MIN_MEMORY_MB}MB`,
      );
    }
    if (limits.memoryLimitMb > MAX_MEMORY_MB) {
      errors.push(
        `memoryLimitMb (${limits.memoryLimitMb}) exceeds maximum ${MAX_MEMORY_MB}MB`,
      );
    }

    if (limits.cpuLimit < MIN_CPU) {
      errors.push(`cpuLimit (${limits.cpuLimit}) is below minimum ${MIN_CPU}`);
    }
    if (limits.cpuLimit > MAX_CPU) {
      errors.push(`cpuLimit (${limits.cpuLimit}) exceeds maximum ${MAX_CPU}`);
    }

    if (limits.timeoutMs < MIN_TIMEOUT_MS) {
      errors.push(
        `timeoutMs (${limits.timeoutMs}) is below minimum ${MIN_TIMEOUT_MS}ms`,
      );
    }
    if (limits.timeoutMs > MAX_TIMEOUT_MS) {
      errors.push(
        `timeoutMs (${limits.timeoutMs}) exceeds maximum ${MAX_TIMEOUT_MS}ms`,
      );
    }

    if (errors.length > 0) {
      return {
        valid: false,
        error: `Invalid resource limits: ${errors.join('; ')}`,
        memoryLimitMb: limits.memoryLimitMb,
        cpuLimit: limits.cpuLimit,
        timeoutMs: limits.timeoutMs,
      };
    }

    return {
      valid: true,
      memoryLimitMb: limits.memoryLimitMb,
      cpuLimit: limits.cpuLimit,
      timeoutMs: limits.timeoutMs,
    };
  }
}
