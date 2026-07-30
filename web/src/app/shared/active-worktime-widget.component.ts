import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { WorkEventKind } from '../core/models';
import { WorktimeService } from '../core/worktime.service';

@Component({
  selector: 'app-active-worktime-widget',
  templateUrl: './active-worktime-widget.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActiveWorktimeWidgetComponent {
  protected readonly worktime = inject(WorktimeService);
  protected readonly now = signal(new Date());

  constructor() {
    const timer = window.setInterval(() => this.now.set(new Date()), 1_000);
    inject(DestroyRef).onDestroy(() => window.clearInterval(timer));
  }

  protected record(kind: WorkEventKind): void {
    void this.worktime.record(kind);
  }
}
