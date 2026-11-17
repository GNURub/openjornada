import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { BrandingService } from './branding.service';
import { NotificationsService } from './notifications.service';
import { PocketBaseService } from './pocketbase.service';

function notification(id: string) {
  return { id, title: `Aviso ${id}`, message: '', read: false, created: '2026-11-16 10:00:00.000Z' };
}

describe('NotificationsService', () => {
  const getList = vi.fn();
  const update = vi.fn();
  const filter = vi.fn((expression: string, params: Record<string, string>) => ({ expression, params }));
  const setUnreadCount = vi.fn();
  const user = signal<{ id: string } | null>({ id: 'user-1' });
  let service: NotificationsService;

  beforeEach(() => {
    sessionStorage.clear();
    getList.mockReset().mockResolvedValue({ items: [notification('a'), notification('b')] });
    update.mockReset().mockResolvedValue({});
    setUnreadCount.mockClear();
    user.set({ id: 'user-1' });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PocketBaseService,
          useValue: { client: { filter, collection: () => ({ getList, update }) } },
        },
        { provide: AuthService, useValue: { user } },
        { provide: BrandingService, useValue: { setUnreadCount } },
      ],
    });
    service = TestBed.inject(NotificationsService);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('loads only the unread notifications of the signed-in person', async () => {
    await service.refresh();

    const options = getList.mock.calls.at(-1)?.[2];
    expect(options.filter.expression).toBe('recipient = {:recipient} && read = false');
    expect(options.filter.params).toEqual({ recipient: 'user-1' });
    expect(service.unreadCount()).toBe(2);
  });

  it('shows the unread count in the tab title', async () => {
    await service.refresh();
    TestBed.tick();

    expect(setUnreadCount).toHaveBeenLastCalledWith(2);
  });

  it('marks a notification as read and removes it from the pending list', async () => {
    await service.refresh();

    expect(await service.markRead('a')).toBe(true);

    expect(update).toHaveBeenCalledWith('a', { read: true });
    expect(service.unread().map((item) => item.id)).toEqual(['b']);
  });

  it('keeps a dismissed notification unread but hides its pop-up', async () => {
    await service.refresh();

    service.dismiss('a');

    expect(service.unreadCount()).toBe(2);
    expect(service.pending().map((item) => item.id)).toEqual(['b']);
    expect(JSON.parse(sessionStorage.getItem('openjornada.dismissedNotifications') ?? '[]')).toEqual(['a']);
  });

  it('clears the notifications when the session ends', async () => {
    await service.refresh();
    user.set(null);
    TestBed.tick();

    expect(service.unreadCount()).toBe(0);
  });
});
