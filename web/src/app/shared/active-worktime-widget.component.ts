import {
  ChangeDetectionStrategy,
  Component,
  computed,
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

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  startRect: DOMRect;
}

const VIEWPORT_MARGIN = 8;

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
  protected readonly dragging = signal(false);
  protected readonly widgetTransform = computed(() => {
    if (this.pip.active()) return null;
    const { x, y } = this.dragOffset();
    return x || y ? `translate3d(${x}px, ${y}px, 0)` : null;
  });

  private readonly dragOffset = signal({ x: 0, y: 0 });
  private dragSession: DragSession | null = null;

  constructor() {
    const timer = window.setInterval(() => this.now.set(new Date()), 1_000);
    const keepInsideViewport = () => {
      if (!this.pip.active()) this.shiftPosition(0, 0);
    };
    window.addEventListener('resize', keepInsideViewport);
    const destroyRef = inject(DestroyRef);
    this.pip.registerHost(this.host.nativeElement);
    destroyRef.onDestroy(() => {
      window.clearInterval(timer);
      window.removeEventListener('resize', keepInsideViewport);
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

  protected startDrag(event: PointerEvent): void {
    const widget = this.widget()?.nativeElement;
    if (!widget || this.pip.active() || event.button !== 0) return;

    const { x, y } = this.dragOffset();
    this.dragSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: x,
      originY: y,
      startRect: widget.getBoundingClientRect(),
    };
    this.dragging.set(true);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  protected moveDrag(event: PointerEvent): void {
    const drag = this.dragSession;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const requestedX = event.clientX - drag.startX;
    const requestedY = event.clientY - drag.startY;
    const left = this.clamp(
      drag.startRect.left + requestedX,
      VIEWPORT_MARGIN,
      Math.max(
        VIEWPORT_MARGIN,
        window.innerWidth - drag.startRect.width - VIEWPORT_MARGIN,
      ),
    );
    const top = this.clamp(
      drag.startRect.top + requestedY,
      VIEWPORT_MARGIN,
      Math.max(
        VIEWPORT_MARGIN,
        window.innerHeight - drag.startRect.height - VIEWPORT_MARGIN,
      ),
    );
    this.dragOffset.set({
      x: drag.originX + left - drag.startRect.left,
      y: drag.originY + top - drag.startRect.top,
    });
  }

  protected endDrag(event: PointerEvent): void {
    if (this.dragSession?.pointerId !== event.pointerId) return;
    this.dragSession = null;
    this.dragging.set(false);
    const handle = event.currentTarget as HTMLElement;
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  }

  protected moveWithKeyboard(event: KeyboardEvent): void {
    if (this.pip.active()) return;
    const movement: Record<string, [number, number]> = {
      ArrowUp: [0, -16],
      ArrowRight: [16, 0],
      ArrowDown: [0, 16],
      ArrowLeft: [-16, 0],
    };
    if (event.key === 'Home') {
      event.preventDefault();
      this.resetPosition();
      return;
    }
    const delta = movement[event.key];
    if (!delta) return;
    event.preventDefault();
    this.shiftPosition(...delta);
  }

  protected resetPosition(): void {
    this.dragOffset.set({ x: 0, y: 0 });
  }

  private shiftPosition(deltaX: number, deltaY: number): void {
    const widget = this.widget()?.nativeElement;
    if (!widget) return;
    const rect = widget.getBoundingClientRect();
    const left = this.clamp(
      rect.left + deltaX,
      VIEWPORT_MARGIN,
      Math.max(
        VIEWPORT_MARGIN,
        window.innerWidth - rect.width - VIEWPORT_MARGIN,
      ),
    );
    const top = this.clamp(
      rect.top + deltaY,
      VIEWPORT_MARGIN,
      Math.max(
        VIEWPORT_MARGIN,
        window.innerHeight - rect.height - VIEWPORT_MARGIN,
      ),
    );
    this.dragOffset.update(({ x, y }) => ({
      x: x + left - rect.left,
      y: y + top - rect.top,
    }));
  }

  private clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
  }
}
