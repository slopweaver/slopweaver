import { err, ok, type Result } from '@slopweaver/errors';
import { z } from 'zod';

export const NodeEnvSchema = z.enum(['development', 'production', 'test']);
export type NodeEnv = z.infer<typeof NodeEnvSchema>;

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

// process.env contains many unrelated keys (PATH, HOME, …) so the schema is
// deliberately not strict — Zod's default `strip` mode discards unknowns.
export const EnvSchema = z.object({
  XDG_DATA_HOME: z.string().min(1).optional(),
  NODE_ENV: NodeEnvSchema.default('production'),
  LOG_LEVEL: LogLevelSchema.default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export type EnvIssue = {
  readonly path: string;
  readonly message: string;
  readonly received: string | undefined;
};

function formatIssues(issues: ReadonlyArray<EnvIssue>): string {
  const lines = issues.map((i) => `  - ${i.path}: ${i.message}`);
  return `Environment validation failed:\n${lines.join('\n')}`;
}

export class EnvValidationError extends Error {
  readonly issues: ReadonlyArray<EnvIssue>;
  constructor(issues: ReadonlyArray<EnvIssue>) {
    super(formatIssues(issues));
    this.name = 'EnvValidationError';
    this.issues = Object.freeze([...issues]);
  }
}

export function loadEnv({
  env = process.env,
}: {
  env?: NodeJS.ProcessEnv;
} = {}): Result<Readonly<Env>, EnvValidationError> {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues: EnvIssue[] = result.error.issues.map((i) => {
      const firstKey = i.path[0];
      const path = i.path.map(String).join('.');
      const received =
        typeof firstKey === 'string' && typeof env[firstKey] === 'string'
          ? env[firstKey]
          : undefined;
      return { path, message: i.message, received };
    });
    return err(new EnvValidationError(issues));
  }
  return ok(Object.freeze(result.data));
}
