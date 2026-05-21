/**
 * Mega-audit barrel. Two tools: `start_mega_audit` (returns the
 * instructional body the model follows) and `record_audit_progress`
 * (JSONL streaming for the live UI tail in PR #61).
 */

export { createStartMegaAuditTool } from './start-mega-audit.ts';
export type { CreateStartMegaAuditToolArgs } from './start-mega-audit.ts';
export { createRecordAuditProgressTool } from './record-audit-progress.ts';
export type { CreateRecordAuditProgressToolArgs } from './record-audit-progress.ts';
export { MEGA_AUDIT_INSTRUCTIONS, renderInstructions } from './instructions.ts';
