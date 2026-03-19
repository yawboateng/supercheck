jest.mock('fs/promises');

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  ContainerExecutionOptions,
  ContainerExecutorService,
} from './container-executor.service';
import { CancellationService } from '../services/cancellation.service';

const defaultOptions: ContainerExecutionOptions = {
  inlineScriptContent: 'console.log("hello")',
  inlineScriptFileName: 'test.spec.ts',
  timeoutMs: 30000,
  memoryLimitMb: 512,
  cpuLimit: 0.5,
};

describe('ContainerExecutorService', () => {
  let service: ContainerExecutorService;
  let mockConfigGet: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockConfigGet = jest.fn((key: string, defaultValue?: string) => {
      const config: Record<string, string> = {
        WORKER_IMAGE: 'ghcr.io/supercheck-io/worker:test',
      };
      return config[key] ?? defaultValue;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContainerExecutorService,
        {
          provide: ConfigService,
          useValue: {
            get: mockConfigGet,
          },
        },
        {
          provide: CancellationService,
          useValue: {
            isCancelled: jest.fn().mockResolvedValue(false),
            clearCancellationSignal: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<ContainerExecutorService>(ContainerExecutorService);
    jest
      .spyOn(service as any, 'ensureKubernetesClients')
      .mockResolvedValue(undefined);
    await service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe('backend configuration', () => {
    it('initializes kubernetes clients on startup', async () => {
      const ensureClients = jest.spyOn(service as any, 'ensureKubernetesClients');
      await service.onModuleInit();
      expect(ensureClients).toHaveBeenCalled();
    });
  });

  describe('input validation', () => {
    it('rejects non-null scriptPath (legacy mode)', async () => {
      const result = await service.executeInContainer(
        '/tmp/test.ts',
        ['node'],
        defaultOptions,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Legacy execution mode not supported');
    });

    it('rejects missing inlineScriptContent', async () => {
      const result = await service.executeInContainer(null, ['node'], {
        inlineScriptFileName: 'test.ts',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing inline script content');
    });

    it('rejects missing inlineScriptFileName', async () => {
      const result = await service.executeInContainer(null, ['node'], {
        inlineScriptContent: 'console.log("hi")',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing script filename');
    });

    it('rejects invalid additional file paths', async () => {
      const result = await service.executeInContainer(null, ['node'], {
        ...defaultOptions,
        additionalFiles: {
          '../../../etc/passwd': 'bad',
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid characters');
    });

    it('rejects extractFromContainer without extractToHost', async () => {
      const result = await service.executeInContainer(null, ['node'], {
        ...defaultOptions,
        extractFromContainer: '/tmp/report',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid extraction configuration');
    });
  });

  describe('resource limits', () => {
    it('rejects memory below 128MB', async () => {
      const result = await service.executeInContainer(null, ['node'], {
        ...defaultOptions,
        memoryLimitMb: 32,
      });

      expect(result.success).toBe(false);
      expect(result.stderr).toContain('memoryLimitMb');
      expect(result.stderr).toContain('below minimum');
    });

    it('rejects CPU above 4', async () => {
      const result = await service.executeInContainer(null, ['node'], {
        ...defaultOptions,
        cpuLimit: 8,
      });

      expect(result.success).toBe(false);
      expect(result.stderr).toContain('cpuLimit');
      expect(result.stderr).toContain('exceeds maximum');
    });
  });

  describe('kubernetes execution', () => {
    it('delegates valid executions to the kubernetes backend', async () => {
      const executeInKubernetes = jest
        .spyOn(service as any, 'executeInKubernetes')
        .mockResolvedValue({
          success: true,
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          duration: 10,
          timedOut: false,
        });

      const result = await service.executeInContainer(
        null,
        ['npx', 'playwright', 'test'],
        defaultOptions,
      );

      expect(result.success).toBe(true);
      expect(result.stdout).toBe('ok');
      expect(executeInKubernetes).toHaveBeenCalledWith(
        ['npx', 'playwright', 'test'],
        defaultOptions,
        expect.objectContaining({
          memoryLimitMb: 512,
          cpuLimit: 0.5,
          timeoutMs: 30000,
        }),
      );
    });
  });

  describe('shell script building', () => {
    it('uses a hashed workspace when one is not provided', () => {
      const script = service.buildShellScript(
        {
          ...defaultOptions,
          runId: '../tenant-a',
        },
        ['node', '/tmp/test.spec.ts'],
      );

      expect(script).toContain('/tmp/supercheck/run-');
      expect(script).not.toContain('../tenant-a');
      expect(script).toContain('/tmp/supercheck/run-');
    });

    it('base64-encodes the inline script content', () => {
      const script = service.buildShellScript(
        {
          inlineScriptContent: 'console.log("hello world")',
          inlineScriptFileName: 'test.ts',
          _workspace: '/tmp/supercheck/run-123',
        } as any,
        ['node', 'test.ts'],
      );

      expect(script).toContain(
        Buffer.from('console.log("hello world")').toString('base64'),
      );
      expect(script).toContain('/tmp/supercheck/run-123/test.ts');
      expect(script).toContain('node /tmp/supercheck/run-123/test.ts');
    });

    it('rewrites /tmp paths into the execution workspace', () => {
      const script = service.buildShellScript(
        {
          ...defaultOptions,
          ensureDirectories: ['/tmp/reports', '/tmp/output'],
          _workspace: '/tmp/supercheck/run-456',
        } as any,
        ['playwright', 'test', '/tmp/test.ts'],
      );

      expect(script).toContain("mkdir -p '/tmp/supercheck/run-456/reports'");
      expect(script).toContain("mkdir -p '/tmp/supercheck/run-456/output'");
      expect(script).toContain('playwright test /tmp/supercheck/run-456/test.ts');
      expect(script).not.toContain("'/tmp/test.ts'");
    });

    it('symlinks node_modules into the workspace', () => {
      const script = service.buildShellScript(
        {
          ...defaultOptions,
          _workspace: '/tmp/supercheck/run-789',
        } as any,
        ['node', 'test.ts'],
      );

      expect(script).toContain(
        "ln -s \"$PWD/node_modules\" '/tmp/supercheck/run-789/node_modules'",
      );
    });
  });

  describe('log collection', () => {
    it('suppresses live forwarding during replay windows', async () => {
      const onStdoutChunk = jest.fn();
      const collector = (service as any).createLogCollector({
        onStdoutChunk,
      });

      collector.stream.write('line-1\n');
      collector.stream.suppressLiveForwarding();
      collector.stream.write('line-2\n');
      collector.stream.resumeLiveForwarding();
      collector.stream.write('line-3\n');

      expect(onStdoutChunk).toHaveBeenCalledTimes(2);
      expect(onStdoutChunk).toHaveBeenNthCalledWith(1, 'line-1\n');
      expect(onStdoutChunk).toHaveBeenNthCalledWith(2, 'line-3\n');
      expect(collector.getOutput()).toBe('line-1\nline-2\nline-3\n');
    });
  });
});
