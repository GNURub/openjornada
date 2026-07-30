import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import {
  AnnouncementRecord,
  NotificationRecord,
} from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';

@Component({
  selector: 'app-communications',
  imports: [FormsModule, RouterLink],
  templateUrl: './communications.component.html',
})
export class CommunicationsComponent {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly auth = inject(AuthService);
  protected readonly notifications = signal<NotificationRecord[]>([]);
  protected readonly announcements = signal<AnnouncementRecord[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly formOpen = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly unread = computed(
    () => this.notifications().filter((item) => !item.read).length,
  );
  protected readonly canPublish = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'admin' || role === 'manager';
  });
  protected title = '';
  protected body = '';
  protected audience: AnnouncementRecord['audience'] = 'all';
  protected sendEmail = true;

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const [notifications, announcements] = await Promise.all([
        this.pb.collection('notifications').getFullList({ sort: '-created' }),
        this.pb
          .collection('announcements')
          .getFullList({ sort: '-publishedAt' }),
      ]);
      this.notifications.set(notifications as NotificationRecord[]);
      this.announcements.set(announcements as AnnouncementRecord[]);
    } catch {
      this.error.set('No se han podido cargar los avisos.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async markRead(notification: NotificationRecord): Promise<void> {
    if (notification.read) return;
    try {
      const updated = await this.pb
        .collection('notifications')
        .update(notification.id, { read: true });
      this.notifications.update((items) =>
        items.map((item) =>
          item.id === notification.id
            ? (updated as NotificationRecord)
            : item,
        ),
      );
    } catch {
      this.error.set('No se pudo marcar el aviso como leído.');
    }
  }

  protected async markAllRead(): Promise<void> {
    for (const notification of this.notifications().filter(
      (item) => !item.read,
    )) {
      await this.markRead(notification);
    }
  }

  protected async publish(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      await this.pb.collection('announcements').create({
        organization: user.organization,
        title: this.title,
        body: this.body,
        audience: this.audience,
        sendEmail: this.sendEmail,
        createdBy: user.id,
        publishedAt: new Date().toISOString(),
      });
      this.formOpen.set(false);
      this.title = '';
      this.body = '';
      this.audience = 'all';
      this.sendEmail = true;
      this.success.set(
        'Aviso publicado y distribuido por los canales configurados.',
      );
      await this.load();
    } catch {
      this.error.set('No se ha podido publicar el aviso.');
    } finally {
      this.saving.set(false);
    }
  }

  protected formatDate(value: string): string {
    return new Intl.DateTimeFormat('es-ES', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  }
}
