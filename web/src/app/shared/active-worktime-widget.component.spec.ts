import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkStatus } from '../core/models';
import { WorktimeService } from '../core/worktime.service';
import { ActiveWorktimeWidgetComponent } from './active-worktime-widget.component';

describe('ActiveWorktimeWidgetComponent', () => {
  let fixture: ComponentFixture<ActiveWorktimeWidgetComponent>;
  const status = signal<WorkStatus>('off');
  const loading = signal(false);
  const submitting = signal(false);
  const error = signal('');
  const record = vi.fn<(kind: string) => Promise<boolean>>();
  const worktime = {
    status,
    loading,
    submitting,
    error,
    workedTodayTimer: vi.fn(() => '01:02:03'),
    record,
  };

  beforeEach(async () => {
    status.set('off');
    loading.set(false);
    submitting.set(false);
    error.set('');
    record.mockReset();
    record.mockResolvedValue(true);

    await TestBed.configureTestingModule({
      imports: [ActiveWorktimeWidgetComponent],
      providers: [{ provide: WorktimeService, useValue: worktime }],
    }).compileComponents();

    fixture = TestBed.createComponent(ActiveWorktimeWidgetComponent);
    fixture.detectChanges();
  });

  it('only appears while the workday is active or paused', () => {
    expect(
      fixture.nativeElement.querySelector('[data-testid="active-worktime-widget"]'),
    ).toBeNull();

    status.set('working');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Jornada en curso');
    expect(fixture.nativeElement.textContent).toContain('01:02:03');

    status.set('paused');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Jornada en pausa');
  });

  it('offers the valid actions for each state', () => {
    status.set('working');
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector(
        '[data-testid="worktime-widget-pause"]',
      ) as HTMLButtonElement
    ).click();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="worktime-widget-finish"]',
      ) as HTMLButtonElement
    ).click();
    expect(record).toHaveBeenNthCalledWith(1, 'break_start');
    expect(record).toHaveBeenNthCalledWith(2, 'clock_out');

    status.set('paused');
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="worktime-widget-resume"]',
      ) as HTMLButtonElement
    ).click();
    expect(record).toHaveBeenNthCalledWith(3, 'break_end');
  });

  it('disables actions while saving and exposes service errors', () => {
    status.set('working');
    submitting.set(true);
    error.set('No se ha podido guardar el fichaje.');
    fixture.detectChanges();

    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ) as HTMLButtonElement[];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'No se ha podido guardar el fichaje.',
    );
  });
});
