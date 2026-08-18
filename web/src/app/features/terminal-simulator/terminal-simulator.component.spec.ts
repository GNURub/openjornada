import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalService } from '../../core/terminal.service';
import { TerminalSimulatorComponent } from './terminal-simulator.component';

describe('TerminalSimulatorComponent', () => {
  let fixture: ComponentFixture<TerminalSimulatorComponent>;

  beforeEach(async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({
      imports: [TerminalSimulatorComponent],
      providers: [{ provide: TerminalService, useValue: {} }],
    }).compileComponents();

    fixture = TestBed.createComponent(TerminalSimulatorComponent);
    fixture.detectChanges();
  });

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
});
