/**
 * Polly cassette setup for @slopweaver/integrations-slack tests.
 *
 * Wires the shared cassette plumbing from `@slopweaver/integrations-core`,
 * extended with Slack-specific PII redactors so cassettes recorded against a
 * real workspace don't commit message text, real names, emails, channel
 * names, or workspace URLs.
 */

import { definePollySetup } from '@slopweaver/integrations-core/test-setup/polly';
import { slackRedactors } from './redact-slack.ts';

definePollySetup({ extraRedactors: slackRedactors });
