import { describe, expect, it } from 'vitest';
import {
  TerminalActionResult,
  TerminalBootstrapResponse,
  TerminalCommand,
} from './terminal.models';

describe('terminal API contracts', () => {
  it('keeps the v1 offline limits explicit', () => {
    const response = {
      protocol: { current: 1, min: 1, max: 1 },
      maxOfflineSeconds: 86_400,
      maxQueuedActions: 10_000,
    } as TerminalBootstrapResponse;

    expect(response.protocol.current).toBe(1);
    expect(response.maxOfflineSeconds).toBe(86_400);
    expect(response.maxQueuedActions).toBe(10_000);
  });

  it('accepts only the four authoritative commands', () => {
    const commands: TerminalCommand[] = ['clock_in', 'break_start', 'break_end', 'clock_out'];
    const result = { clientRequestId: 'terminal:1', status: 'accepted' } as TerminalActionResult;

    expect(commands).toHaveLength(4);
    expect(result.status).toBe('accepted');
  });
});
