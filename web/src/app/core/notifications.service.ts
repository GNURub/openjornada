import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { BrandingService } from './branding.service';
import { NotificationRecord } from './models';
import { PocketBaseService } from './pocketbase.service';

export const NOTIFICATIONS_POLL_MS = 30_000;
const DISMISSED_KEY = 'openjornada.dismissedNotifications';

/**
 * Avisos sin leer de la persona que ha iniciado sesión. Alimenta el contador del menú,
 * el número del título de la pestaña y las ventanas emergentes; se refresca cada 30 s
 * y cada vez que la pestaña vuelve a estar visible.
 */
@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly pb = inject(PocketBaseService).client;
  private readonly auth = inject(AuthService);
  private readonly branding = inject(BrandingService);
  private readonly document = inject(DOCUMENT);

  readonly unread = signal<NotificationRecord[]>([]);
  readonly unreadCount = computed(() => this.unread().length);
  private readonly dismissed = signal<ReadonlySet<string>>(this.readDismissed());
  /** Avisos sin leer que todavía no se han cerrado en esta sesión del navegador. */
  readonly pending = computed(() => {
    const dismissed = this.dismissed();
    return this.unread().filter((item) => !dismissed.has(item.id));
  });

  private timer: ReturnType<typeof setInterval> | null = null;
  private loadSequence = 0;
  private readonly onVisibility = () => {
    if (this.document.visibilityState === 'visible') void this.refresh();
  };

  constructor() {
    effect(() => this.branding.setUnreadCount(this.unreadCount()));
    effect(() => {
      if (this.auth.user()) {
        void this.refresh();
        this.start();
      } else {
        this.stop();
        this.unread.set([]);
      }
    });
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  async refresh(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    const sequence = ++this.loadSequence;
    try {
      const page = await this.pb.collection('notifications').getList(1, 50, {
        filter: this.pb.filter('recipient = {:recipient} && read = false', { recipient: user.id }),
        sort: '-created',
      });
      if (sequence === this.loadSequence) {
        this.unread.set(page.items as NotificationRecord[]);
      }
    } catch {
      // Sin conexión o sesión caducada: se mantiene lo último conocido y se reintenta en el
      // siguiente ciclo. La página de avisos muestra sus propios errores.
    }
  }

  async markRead(id: string): Promise<boolean> {
    try {
      await this.pb.collection('notifications').update(id, { read: true });
      this.unread.update((items) => items.filter((item) => item.id !== id));
      return true;
    } catch {
      return false;
    }
  }

  /** Oculta la ventana emergente de un aviso sin marcarlo como leído (solo en esta sesión). */
  dismiss(id: string): void {
    this.dismissed.update((current) => new Set([...current, id]));
    try {
      sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...this.dismissed()]));
    } catch {
      // Navegación privada o almacenamiento bloqueado: basta con el estado en memoria.
    }
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), NOTIFICATIONS_POLL_MS);
    this.document.addEventListener('visibilitychange', this.onVisibility);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private readDismissed(): ReadonlySet<string> {
    try {
      const stored = JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? '[]');
      return new Set(Array.isArray(stored) ? stored.map(String) : []);
    } catch {
      return new Set();
    }
  }
}
