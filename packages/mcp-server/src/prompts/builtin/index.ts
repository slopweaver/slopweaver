/**
 * Barrel + one-stop factory for SlopWeaver's builtin prompts. The app
 * layer (`apps/mcp-local`) imports `allBuiltinPrompts()` and passes the
 * result straight into `createMcpServer({ prompts })`.
 */

import type { McpPrompt } from '../registry.ts';
import { createCalibrationReportPrompt } from './calibration-report.ts';
import { createCorrectPrompt } from './correct.ts';
import { createDecidedPrompt } from './decided.ts';
import { createFanOutAuditPrompt } from './fan-out-audit.ts';
import { createFocusPrompt } from './focus.ts';
import { createLockInPrompt } from './lock-in.ts';
import { createReconcilePrompt } from './reconcile.ts';
import { createRecompileProfilePrompt } from './recompile-profile.ts';
import { createSessionStartPrompt } from './session-start.ts';
import { createStyleEditPrompt } from './style-edit.ts';
import { createStyleRulePrompt } from './style-rule.ts';

export function allBuiltinPrompts(): ReadonlyArray<McpPrompt> {
  return [
    createSessionStartPrompt(),
    createFanOutAuditPrompt(),
    createLockInPrompt(),
    createReconcilePrompt(),
    createStyleRulePrompt(),
    createStyleEditPrompt(),
    createCorrectPrompt(),
    createCalibrationReportPrompt(),
    createRecompileProfilePrompt(),
    createDecidedPrompt(),
    createFocusPrompt(),
  ];
}
