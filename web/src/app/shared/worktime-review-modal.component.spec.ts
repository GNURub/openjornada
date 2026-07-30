import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkEventRecord } from '../core/models';
import { WorktimeService } from '../core/worktime.service';
import { WorktimeReviewModalComponent } from './worktime-review-modal.component';

function event(kind: WorkEventRecord['kind'], occurredAt: string): WorkEventRecord {
  return { id: `${kind}-${occurredAt}`, kind, occurredAt } as WorkEventRecord;
}

describe('WorktimeReviewModalComponent', () => {
  let fixture: ComponentFixture<WorktimeReviewModalComponent>;
  const reviewKind = signal<'clock_out' | 'break_end' | null>(null);
  const reviewEndAt = signal('');
  const reviewRecordedAt = signal('');
  const reviewReason = signal('');
  const events = signal<WorkEventRecord[]>([]);
  const submitting = signal(false);
  const error = signal('');
  const record =
    vi.fn<(kind: string, occurredAt: string, adjustmentReason: string) => Promise<boolean>>();
  const closeReview = vi.fn();
  const worktime = {
    reviewKind,
    reviewEndAt,
    reviewRecordedAt,
    reviewReason,
    events,
    submitting,
    error,
    record,
    closeReview,
  };

  beforeEach(async () => {
    reviewKind.set(null);
    reviewEndAt.set('');
    reviewRecordedAt.set('');
    reviewReason.set('');
    events.set([]);
    submitting.set(false);
    error.set('');
    record.mockReset();
    record.mockResolvedValue(true);
    closeReview.mockReset();

    await TestBed.configureTestingModule({
      imports: [WorktimeReviewModalComponent],
      providers: [{ provide: WorktimeService, useValue: worktime }],
    }).compileComponents();

    fixture = TestBed.createComponent(WorktimeReviewModalComponent);
  });

  it('shows the reviewed effective duration for the workday', () => {
    events.set([event('clock_in', '2026-07-30T08:00:00')]);
    reviewKind.set('clock_out');
    reviewEndAt.set('2026-07-30T10:00:00');
    reviewRecordedAt.set('2026-07-30T10:00:00');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Revisar fin de jornada');
    expect(fixture.nativeElement.textContent).toContain('02:00:00');
  });

  it('blocks an end time before the latest event', () => {
    events.set([
      event('break_start', '2026-07-30T10:00:00'),
      event('clock_in', '2026-07-30T08:00:00'),
    ]);
    reviewKind.set('break_end');
    reviewEndAt.set('2026-07-30T09:59:59');
    reviewRecordedAt.set('2026-07-30T10:00:00');
    reviewReason.set('Olvidé cerrar la pausa');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'anterior al último fichaje',
    );
    expect(
      fixture.nativeElement.querySelector('[data-testid="confirm-reviewed-worktime"]').disabled,
    ).toBe(true);
  });

  it('confirms a reviewed timestamp and closes after saving', async () => {
    events.set([event('clock_in', '2020-07-30T08:00:00')]);
    reviewKind.set('clock_out');
    reviewEndAt.set('2020-07-30T10:00:00');
    reviewRecordedAt.set('2020-07-30T10:00:00');
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector(
        '[data-testid="confirm-reviewed-worktime"]',
      ) as HTMLButtonElement
    ).click();
    await fixture.whenStable();

    expect(record).toHaveBeenCalledWith(
      'clock_out',
      new Date('2020-07-30T10:00:00').toISOString(),
      '',
    );
    expect(closeReview).toHaveBeenCalledOnce();
  });

  it('requires and submits a reason for a material adjustment', async () => {
    events.set([event('clock_in', '2020-07-30T08:00:00')]);
    reviewKind.set('clock_out');
    reviewEndAt.set('2020-07-30T09:55:00');
    reviewRecordedAt.set('2020-07-30T10:00:00Z');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Motivo del ajuste');
    expect(
      fixture.nativeElement.querySelector('[data-testid="confirm-reviewed-worktime"]').disabled,
    ).toBe(true);

    reviewReason.set('Olvidé finalizar al salir');
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="confirm-reviewed-worktime"]',
      ) as HTMLButtonElement
    ).click();
    await fixture.whenStable();

    expect(record).toHaveBeenCalledWith(
      'clock_out',
      new Date('2020-07-30T09:55:00').toISOString(),
      'Olvidé finalizar al salir',
    );
  });
});
