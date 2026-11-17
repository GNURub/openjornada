import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { PocketBaseService } from './pocketbase.service';
import { WorktimeService } from './worktime.service';

function event(kind: string, occurredAt: string) {
  return { id: `${kind}-${occurredAt}`, kind, occurredAt };
}

describe('WorktimeService.loadToday', () => {
  const getList = vi.fn();
  const getFullList = vi.fn();
  const filter = vi.fn((expression: string, params: Record<string, string>) => ({ expression, params }));
  let service: WorktimeService;

  beforeEach(() => {
    getList.mockReset();
    getFullList.mockReset().mockResolvedValue([]);
    filter.mockClear();
    const injector = Injector.create({
      providers: [
        {
          provide: PocketBaseService,
          useValue: { client: { filter, collection: () => ({ getList, getFullList }) } },
        },
        {
          provide: AuthService,
          useValue: { user: () => ({ id: 'employee-1', organization: 'org-1' }) },
        },
      ],
    });
    service = runInInjectionContext(injector, () => new WorktimeService());
  });

  /** Desde dónde se cargaron los fichajes que acaban en pantalla (la última consulta). */
  function loadedFrom(): string {
    return getFullList.mock.calls.at(-1)![0].filter.params.start;
  }

  function startOfToday(): Date {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
  }

  it('loads from midnight when the previous shift was closed', async () => {
    getList.mockResolvedValueOnce({ items: [event('clock_out', '2026-11-05 18:00:00.000Z')] });

    await service.loadToday();

    expect(getList).toHaveBeenCalledTimes(1);
    expect(getFullList).toHaveBeenCalledTimes(1);
    expect(new Date(loadedFrom().replace(' ', 'T')).getTime()).toBe(startOfToday().getTime());
  });

  it('loads from midnight when there are no previous events', async () => {
    getList.mockResolvedValueOnce({ items: [] });

    await service.loadToday();

    expect(new Date(loadedFrom().replace(' ', 'T')).getTime()).toBe(startOfToday().getTime());
  });

  it('loads from the clock-in of a shift left open on a previous day', async () => {
    getList
      .mockResolvedValueOnce({ items: [event('break_end', '2026-11-05 15:00:00.000Z')] })
      .mockResolvedValueOnce({ items: [event('clock_in', '2026-11-05 07:00:00.000Z')] });

    await service.loadToday();

    expect(getList.mock.calls[1][2].filter.params.at).toBe('2026-11-05 15:00:00.000Z');
    expect(getFullList).toHaveBeenCalledTimes(2);
    expect(new Date(loadedFrom().replace(' ', 'T')).toISOString()).toBe('2026-11-05T07:00:00.000Z');
  });

  it('falls back to midnight if the previous events cannot be read', async () => {
    getList.mockRejectedValueOnce(new Error('offline'));

    await service.loadToday();

    expect(new Date(loadedFrom().replace(' ', 'T')).getTime()).toBe(startOfToday().getTime());
    expect(service.error()).toBe('');
  });
});
