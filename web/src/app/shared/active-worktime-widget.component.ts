import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { WorkEventKind } from '../core/models';
import { WorktimeService } from '../core/worktime.service';
import { WorktimePictureInPictureService } from './worktime-picture-in-picture.service';

@Component({
  selector: 'app-active-worktime-widget',
  templateUrl: './active-worktime-widget.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActiveWorktimeWidgetComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly widget = viewChild<ElementRef<HTMLElement>>('activeWorktimeWidget');

  protected readonly worktime = inject(WorktimeService);
  protected readonly now = signal(new Date());
  protected readonly pip = inject(WorktimePictureInPictureService);

  constructor() {
    const timer = window.setInterval(() => this.now.set(new Date()), 1_000);
    const destroyRef = inject(DestroyRef);
    this.pip.registerHost(this.host.nativeElement);
    destroyRef.onDestroy(() => {
      window.clearInterval(timer);
      this.pip.close();
      this.pip.unregisterHost(this.host.nativeElement);
    });

    effect(() => {
      if (this.worktime.loading() || this.worktime.status() === 'off') {
        this.pip.close();
      }
    });
  }

  protected record(kind: WorkEventKind): void {
    if (kind === 'clock_out' || kind === 'break_end') {
      this.pip.close();
      this.worktime.openReview(kind);
      return;
    }
    void this.worktime.record(kind);
  }

  protected async togglePictureInPicture(): Promise<void> {
    const widget = this.widget()?.nativeElement;
    if (widget) {
      await this.pip.toggle(widget, this.host.nativeElement);
    }
  }
}
