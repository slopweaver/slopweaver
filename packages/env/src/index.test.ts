import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './index.ts';

describe('loadEnv', () => {
  it('parses a fully-specified env object', () => {
    const env = loadEnv({
      env: {
        XDG_DATA_HOME: '/tmp/slopweaver-test',
        NODE_ENV: 'test',
        LOG_LEVEL: 'debug',
      },
    });

    expect(env).toEqual({
      XDG_DATA_HOME: '/tmp/slopweaver-test',
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
    });
  });

  it('applies defaults for NODE_ENV and LOG_LEVEL when env is empty', () => {
    const env = loadEnv({ env: {} });

    expect(env.NODE_ENV).toBe('production');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.XDG_DATA_HOME).toBeUndefined();
  });

  it('keeps XDG_DATA_HOME undefined when only the typed fields are set', () => {
    const env = loadEnv({
      env: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'warn',
      },
    });

    expect(env.XDG_DATA_HOME).toBeUndefined();
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('warn');
  });

  it('aggregates every failure into a single EnvValidationError', () => {
    let caught: unknown = null;
    try {
      loadEnv({
        env: {
          XDG_DATA_HOME: '',
          NODE_ENV: 'banana',
          LOG_LEVEL: 'shout',
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvValidationError);
    const error = caught as EnvValidationError;
    expect(error.issues).toHaveLength(3);

    const paths = error.issues.map((i) => i.path).sort();
    expect(paths).toEqual(['LOG_LEVEL', 'NODE_ENV', 'XDG_DATA_HOME']);

    expect(error.message).toContain('XDG_DATA_HOME');
    expect(error.message).toContain('NODE_ENV');
    expect(error.message).toContain('LOG_LEVEL');

    const nodeEnvIssue = error.issues.find((i) => i.path === 'NODE_ENV');
    expect(nodeEnvIssue?.received).toBe('banana');
  });

  it('returns a frozen object that rejects mutation', () => {
    const env = loadEnv({ env: { NODE_ENV: 'test' } });

    expect(Object.isFrozen(env)).toBe(true);
    expect(() => {
      // @ts-expect-error: assigning to a readonly field at runtime to verify the freeze
      env.NODE_ENV = 'development';
    }).toThrow(TypeError);
  });
});
