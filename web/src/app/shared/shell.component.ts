import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { BrandingService } from '../core/branding.service';
import { NotificationsService } from '../core/notifications.service';
import { WorktimeService } from '../core/worktime.service';
import { ActiveWorktimeWidgetComponent } from './active-worktime-widget.component';
import { WorktimeReviewModalComponent } from './worktime-review-modal.component';
import { PrivacyNoticeModalComponent } from './privacy-notice-modal.component';
import { NotificationToastsComponent } from './notification-toasts.component';

@Component({
  selector: 'app-shell',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    ActiveWorktimeWidgetComponent,
    WorktimeReviewModalComponent,
    PrivacyNoticeModalComponent,
    NotificationToastsComponent,
  ],
  templateUrl: './shell.component.html',
})
export class ShellComponent {
  protected readonly auth = inject(AuthService);
  protected readonly branding = inject(BrandingService);
  protected readonly worktime = inject(WorktimeService);
  protected readonly notifications = inject(NotificationsService);

  constructor() {
    void this.worktime.loadToday();
  }
}
