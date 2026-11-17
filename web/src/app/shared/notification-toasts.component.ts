import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';
import { NotificationRecord } from '../core/models';
import { NotificationsService } from '../core/notifications.service';
import { WorktimeService } from '../core/worktime.service';

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
  /** El aviso más reciente sin leer; el resto se cuenta y se enlaza a /avisos. */
  protected readonly latest = computed(() => this.notifications.pending()[0] ?? null);
  protected readonly others = computed(() => Math.max(this.notifications.pending().length - 1, 0));

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
