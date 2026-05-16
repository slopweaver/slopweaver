import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './index.ts';

describe('loadEnv', () => {
  it('returns ok with a fully-specified env object', () => {
    const result = loadEnv({
      env: {
        XDG_DATA_HOME: '/tmp/slopweaver-test',
        NODE_ENV: 'test',
        LOG_LEVEL: 'debug',
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        XDG_DATA_HOME: '/tmp/slopweaver-test',
        NODE_ENV: 'test',
        LOG_LEVEL: 'debug',
      });
    }
  });

  it('applies defaults for NODE_ENV and LOG_LEVEL when env is empty', () => {
    const result = loadEnv({ env: {} });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.NODE_ENV).toBe('production');
      expect(result.value.LOG_LEVEL).toBe('info');
      expect(result.value.XDG_DATA_HOME).toBeUndefined();
    }
  });

  it('keeps XDG_DATA_HOME undefined when only the typed fields are set', () => {
    const result = loadEnv({
      env: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'warn',
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.XDG_DATA_HOME).toBeUndefined();
      expect(result.value.NODE_ENV).toBe('development');
      expect(result.value.LOG_LEVEL).toBe('warn');
    }
  });

  it('returns err with an EnvValidationError aggregating every failure', () => {
    const result = loadEnv({
      env: {
        XDG_DATA_HOME: '',
        NODE_ENV: 'banana',
        LOG_LEVEL: 'shout',
      },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(EnvValidationError);
      expect(result.error.issues).toHaveLength(3);

      const paths = result.error.issues.map((i) => i.path).sort();
      expect(paths).toEqual(['LOG_LEVEL', 'NODE_ENV', 'XDG_DATA_HOME']);

      expect(result.error.message).toContain('XDG_DATA_HOME');
      expect(result.error.message).toContain('NODE_ENV');
      expect(result.error.message).toContain('LOG_LEVEL');

      const nodeEnvIssue = result.error.issues.find((i) => i.path === 'NODE_ENV');
      expect(nodeEnvIssue?.received).toBe('banana');
    }
  });

  it('returns a frozen object that rejects mutation', () => {
    const result = loadEnv({ env: { NODE_ENV: 'test' } });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(() => {
        // @ts-expect-error: assigning to a readonly field at runtime to verify the freeze
        result.value.NODE_ENV = 'development';
      }).toThrow(TypeError);
    }
  });
});
