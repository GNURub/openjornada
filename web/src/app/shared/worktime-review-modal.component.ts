import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { WorkEventRecord } from '../core/models';
import {
  applyCorrections,
  calculateWorkedMs,
  formatDurationWithSeconds,
} from '../core/time-calculations';
import { WorktimeService } from '../core/worktime.service';

@Component({
  selector: 'app-worktime-review-modal',
  imports: [FormsModule],
  templateUrl: './worktime-review-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorktimeReviewModalComponent {
  protected readonly worktime = inject(WorktimeService);
  protected readonly startEvent = computed(() => {
    const kind = this.worktime.reviewKind();
    if (!kind) return undefined;
    const startKind = kind === 'clock_out' ? 'clock_in' : 'break_start';
    return this.orderedEvents().find((event) => event.kind === startKind);
  });
  protected readonly latestEvent = computed(() => this.orderedEvents()[0]);

  protected title(): string {
    return this.worktime.reviewKind() === 'clock_out'
      ? 'Revisar fin de jornada'
      : 'Revisar fin de pausa';
  }

  protected startLabel(): string {
    return this.worktime.reviewKind() === 'clock_out' ? 'Jornada iniciada' : 'Pausa iniciada';
  }

  protected durationLabel(): string {
    return this.worktime.reviewKind() === 'clock_out'
      ? 'Tiempo efectivo revisado'
      : 'Duración de la pausa';
  }

  protected duration(): string {
    const end = this.endDate();
    const start = this.startEvent();
    if (!end || !start) return '00:00:00';
    const milliseconds =
      this.worktime.reviewKind() === 'clock_out'
        ? calculateWorkedMs(this.worktime.events(), end)
        : Math.max(0, end.getTime() - new Date(start.occurredAt).getTime());
    return formatDurationWithSeconds(milliseconds);
  }

  protected formatDateTime(value: string | Date): string {
    return new Intl.DateTimeFormat('es-ES', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(typeof value === 'string' ? new Date(value) : value);
  }

  protected minEndAt(): string {
    const latest = this.latestEvent();
    return latest ? this.localDateTimeValue(new Date(latest.occurredAt)) : '';
  }

  protected maxEndAt(): string {
    return this.localDateTimeValue(new Date());
  }

  protected validationMessage(): string {
    const start = this.startEvent();
    const end = this.endDate();
    if (!start || !end) return 'Indica una fecha y hora válidas.';
    const latest = this.latestEvent();
    if (
      latest &&
      Math.floor(end.getTime() / 1_000) < Math.floor(new Date(latest.occurredAt).getTime() / 1_000)
    ) {
      return 'La hora final no puede ser anterior al último fichaje.';
    }
    if (end.getTime() > Date.now()) {
      return 'La hora final no puede estar en el futuro.';
    }
    if (this.requiresReason() && this.worktime.reviewReason().trim().length < 8) {
      return 'Explica el ajuste con al menos 8 caracteres.';
    }
    return '';
  }

  protected adjustmentSeconds(): number {
    const end = this.endDate();
    const recordedAt = new Date(this.worktime.reviewRecordedAt());
    if (!end || Number.isNaN(recordedAt.getTime())) return 0;
    return Math.max(0, Math.floor((recordedAt.getTime() - end.getTime()) / 1_000));
  }

  protected requiresReason(): boolean {
    return this.adjustmentSeconds() >= 30;
  }

  protected adjust(minutes: number): void {
    const current = this.endDate() ?? new Date();
    current.setMinutes(current.getMinutes() - minutes);
    this.worktime.reviewEndAt.set(this.localDateTimeValue(current));
  }

  protected useNow(): void {
    this.worktime.reviewEndAt.set(this.localDateTimeValue(new Date()));
  }

  protected async confirm(): Promise<void> {
    const kind = this.worktime.reviewKind();
    const end = this.endDate();
    if (!kind || !end || this.validationMessage()) return;
    const saved = await this.worktime.record(kind, end.toISOString(), this.worktime.reviewReason());
    if (saved) this.worktime.closeReview();
  }

  protected closeFromBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.worktime.closeReview();
  }

  private orderedEvents(): WorkEventRecord[] {
    return applyCorrections(this.worktime.events()).sort(
      (left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime(),
    );
  }

  private endDate(): Date | null {
    const value = this.worktime.reviewEndAt();
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private localDateTimeValue(date: Date): string {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  }
}
