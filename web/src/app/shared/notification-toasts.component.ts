import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';
import { NotificationRecord } from '../core/models';
import { NotificationsService } from '../core/notifications.service';
import { WorktimeService } from '../core/worktime.service';

export const MAX_NOTIFICATION_TOASTS = 3;
/** Tiempo que un aviso emergente sigue en pantalla antes de recogerse solo. */
export const NOTIFICATION_TOAST_MS = 6_000;

@Component({
  selector: 'app-notification-toasts',
  imports: [RouterLink],
  templateUrl: './notification-toasts.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotificationToastsComponent {
  private readonly router = inject(Router);
  private readonly worktime = inject(WorktimeService);
  protected readonly notifications = inject(NotificationsService);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** No se muestran en la propia página de avisos ni encima de la revisión de un fichaje. */
  protected readonly visible = computed(
    () => !this.url().startsWith('/avisos') && this.worktime.reviewKind() === null,
  );
  protected readonly toasts = computed(() =>
    this.notifications.pending().slice(0, MAX_NOTIFICATION_TOASTS),
  );
  protected readonly hidden = computed(
    () => this.notifications.pending().length - this.toasts().length,
  );

  /** Temporizador de cada aviso; `null` mientras el ratón o el foco están encima. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout> | null>();

  constructor() {
    effect(() => {
      if (!this.visible()) return;
      for (const notification of this.toasts()) {
        if (!this.timers.has(notification.id)) this.schedule(notification.id);
      }
    });
    inject(DestroyRef).onDestroy(() => {
      for (const timer of this.timers.values()) if (timer) clearTimeout(timer);
    });
  }

  /** Mientras se lee o se usa con el teclado, el aviso no se recoge. */
  protected pause(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.set(id, null);
  }

  protected resume(id: string): void {
    if (this.timers.get(id) === null) this.schedule(id);
  }

  private schedule(id: string): void {
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.notifications.dismiss(id);
      }, NOTIFICATION_TOAST_MS),
    );
  }

  protected async open(notification: NotificationRecord): Promise<void> {
    await this.notifications.markRead(notification.id);
    await this.router.navigateByUrl(notification.link || '/avisos');
  }

  protected formatTime(value: string): string {
    return new Intl.DateTimeFormat('es-ES', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  }
}
