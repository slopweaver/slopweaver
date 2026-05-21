/**
 * `/draft` barrel — currently a single tool wrapping the instructional
 * body. The `/draft` slash command shim lands on top of #54.
 */

export { createStartDraftTool } from './start-draft.ts';
export type { CreateStartDraftToolArgs } from './start-draft.ts';
