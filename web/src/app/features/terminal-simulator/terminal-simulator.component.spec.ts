import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalService } from '../../core/terminal.service';
import { TerminalSimulatorComponent } from './terminal-simulator.component';

describe('TerminalSimulatorComponent', () => {
  let fixture: ComponentFixture<TerminalSimulatorComponent>;
  const terminalService = {
    openAdminSession: vi.fn(),
    closeAdminSession: vi.fn(),
    deviceEmployees: vi.fn(),
    deviceAssign: vi.fn(),
    resolveTag: vi.fn(),
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    terminalService.openAdminSession.mockResolvedValue({
      token: 'ojtadmin_test-capability',
      idleExpiresAt: '2026-08-26T15:00:00Z',
    });
    terminalService.closeAdminSession.mockResolvedValue(undefined);
    terminalService.deviceAssign.mockResolvedValue(undefined);
    terminalService.deviceEmployees.mockResolvedValue({
      items: [{ id: 'employee-1', name: 'Marina', hasRfidTag: false }],
    });
    await TestBed.configureTestingModule({
      imports: [TerminalSimulatorComponent],
      providers: [{ provide: TerminalService, useValue: terminalService }],
    }).compileComponents();

    fixture = TestBed.createComponent(TerminalSimulatorComponent);
    fixture.detectChanges();
  });

  async function enterAdministration(): Promise<void> {
    const hold = fixture.nativeElement.querySelector(
      '[data-testid="simulate-admin-hold"]',
    ) as HTMLButtonElement;
    hold.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(3_000);
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('section button');
    const buttonB = buttons[1] as HTMLButtonElement;
    buttonB.click();
    buttonB.click();
    buttonB.click();
    buttonB.click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
  }

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('opens administration after holding the mouse control for three seconds', () => {
    const button = fixture.nativeElement.querySelector(
      '[data-testid="simulate-admin-hold"]',
    ) as HTMLButtonElement;

    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(1_000);
    fixture.detectChanges();
    expect(button.textContent).toContain('2 s');

    vi.advanceTimersByTime(2_000);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('PIN de administración');
  });

  it('supports holding the administration control with the keyboard', () => {
    const button = fixture.nativeElement.querySelector(
      '[data-testid="simulate-admin-hold"]',
    ) as HTMLButtonElement;

    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    vi.advanceTimersByTime(3_000);
    button.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('PIN de administración');
  });

  it('cancels the administration gesture when the mouse is released early', () => {
    const button = fixture.nativeElement.querySelector(
      '[data-testid="simulate-admin-hold"]',
    ) as HTMLButtonElement;

    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(2_900);
    button.dispatchEvent(new Event('pointerup', { bubbles: true }));
    vi.advanceTimersByTime(100);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Acerca tu tarjeta');
    expect(fixture.nativeElement.textContent).not.toContain('PIN de administración');
  });

  it('cancels the physical A+C gesture when either pointer is cancelled', () => {
    const buttons = fixture.nativeElement.querySelectorAll('section button');
    const buttonA = buttons[0] as HTMLButtonElement;
    const buttonC = buttons[2] as HTMLButtonElement;

    buttonA.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    buttonC.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(1_000);
    buttonA.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    vi.advanceTimersByTime(2_000);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Acerca tu tarjeta');
    expect(fixture.nativeElement.textContent).not.toContain('PIN de administración');
  });

  it('does not change the PIN when releasing A+C after a completed hold', () => {
    const buttons = fixture.nativeElement.querySelectorAll('section button');
    const buttonA = buttons[0] as HTMLButtonElement;
    const buttonC = buttons[2] as HTMLButtonElement;

    buttonA.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    buttonC.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(3_000);
    buttonA.dispatchEvent(new Event('pointerup', { bubbles: true }));
    buttonA.click();
    buttonC.dispatchEvent(new Event('pointerup', { bubbles: true }));
    buttonC.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('PIN de administración');
    expect(fixture.nativeElement.querySelector('main')?.textContent).toContain('0000');
  });

  it('explains and performs A+C exit from tag assignment', async () => {
    await enterAdministration();
    expect(fixture.nativeElement.textContent).toContain('Mantén A+C 3 s para salir');

    const buttons = fixture.nativeElement.querySelectorAll('section button');
    const buttonA = buttons[0] as HTMLButtonElement;
    const buttonC = buttons[2] as HTMLButtonElement;
    buttonA.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    buttonC.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(3_000);
    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Acerca tu tarjeta');
    expect(terminalService.closeAdminSession).toHaveBeenCalledOnce();
  });

  it('returns to idle after five minutes without administrative activity', async () => {
    await enterAdministration();
    expect(fixture.nativeElement.textContent).toContain('Asignar tag');

    vi.advanceTimersByTime(5 * 60_000);
    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Acerca tu tarjeta');
  });

  it('also expires the administration PIN screen after five minutes', () => {
    const hold = fixture.nativeElement.querySelector(
      '[data-testid="simulate-admin-hold"]',
    ) as HTMLButtonElement;
    hold.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(3_000);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('PIN de administración');

    vi.advanceTimersByTime(5 * 60_000);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Acerca tu tarjeta');
  });

  it('ignores RFID outside assignment and resets administrative inactivity', async () => {
    await enterAdministration();
    Reflect.get(fixture.componentInstance, 'connected').set(true);
    fixture.detectChanges();
    const uid = fixture.nativeElement.querySelector(
      'input[placeholder="04:A1:B2:C3"]',
    ) as HTMLInputElement;
    uid.value = '04:A1:B2:C3';
    uid.dispatchEvent(new Event('input', { bubbles: true }));

    vi.advanceTimersByTime(5 * 60_000 - 1);
    const scan = Array.from<HTMLButtonElement>(
      fixture.nativeElement.querySelectorAll('aside button'),
    ).find((button) => button.textContent?.includes('Acercar tag')) as HTMLButtonElement;
    scan.click();
    await Promise.resolve();
    vi.advanceTimersByTime(2);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Asignar tag');
    expect(terminalService.resolveTag).not.toHaveBeenCalled();
  });

  it('stays idle when an administrative request finishes after A+C exit', async () => {
    let finishAssignment: (() => void) | undefined;
    terminalService.deviceAssign.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishAssignment = resolve;
      }),
    );
    await enterAdministration();
    Reflect.get(fixture.componentInstance, 'connected').set(true);
    fixture.detectChanges();

    const physicalButtons = fixture.nativeElement.querySelectorAll('section button');
    (physicalButtons[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    const uid = fixture.nativeElement.querySelector(
      'input[placeholder="04:A1:B2:C3"]',
    ) as HTMLInputElement;
    uid.value = '04:A1:B2:C3';
    uid.dispatchEvent(new Event('input', { bubbles: true }));
    const scan = Array.from<HTMLButtonElement>(
      fixture.nativeElement.querySelectorAll('aside button'),
    ).find((button) => button.textContent?.includes('Acercar tag')) as HTMLButtonElement;
    scan.click();

    (physicalButtons[0] as HTMLButtonElement).dispatchEvent(
      new Event('pointerdown', { bubbles: true }),
    );
    (physicalButtons[2] as HTMLButtonElement).dispatchEvent(
      new Event('pointerdown', { bubbles: true }),
    );
    vi.advanceTimersByTime(3_000);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Acerca tu tarjeta');

    finishAssignment?.();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Acerca tu tarjeta');
  });
});
