import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  templateUrl: './login.component.html',
})
export class LoginComponent {
  protected readonly auth = inject(AuthService);
  protected readonly resetMode = signal(false);
  protected readonly sent = signal(false);
  protected email = '';
  protected password = '';

  protected async submit(): Promise<void> {
    if (this.resetMode()) {
      this.sent.set(await this.auth.requestPasswordReset(this.email));
      return;
    }
    await this.auth.login(this.email, this.password);
  }
}
