import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  TerminalProvisioningQrErrorCode,
  buildTerminalProvisioningUrl,
  renderTerminalProvisioningQr,
} from '../../core/terminal-provisioning-qr';

@Component({
  selector: 'app-terminal-provisioning-card',
  imports: [FormsModule],
  templateUrl: './terminal-provisioning-card.component.html',
})
export class TerminalProvisioningCardComponent implements OnDestroy {
  readonly terminalToken = input.required<string>();
  readonly copyToken = output<void>();
  readonly dismissed = output<void>();
  private readonly defaultBaseUrl = globalThis.location?.origin ?? 'https://tu-dominio.example';
  readonly ssid = signal('');
  readonly wifiPassword = signal('');
  readonly baseUrl = signal(this.defaultBaseUrl);
  readonly wifiPasswordVisible = signal(false);
  readonly tokenVisible = signal(false);
  readonly qrDataUrl = signal('');
  readonly qrError = signal('');
  readonly rendering = signal(false);
  readonly expanded = signal(false);
  private readonly expandButton = viewChild<ElementRef<HTMLButtonElement>>('expandButton');
  private readonly closeExpandedButton =
    viewChild<ElementRef<HTMLButtonElement>>('closeExpandedButton');
  private generation = 0;

  constructor() {
    let previousToken = '';
    effect(() => {
      const nextToken = this.terminalToken();
      if (previousToken && previousToken !== nextToken) this.clearEphemeralState();
      previousToken = nextToken;
    });
    effect(() => {
      const closeButton = this.closeExpandedButton();
      if (this.expanded() && closeButton) closeButton.nativeElement.focus();
    });
  }

  setSsid(value: string): void {
    this.ssid.set(value);
    this.invalidateQr();
  }

  setWifiPassword(value: string): void {
    this.wifiPassword.set(value);
    this.invalidateQr();
  }

  setBaseUrl(value: string): void {
    this.baseUrl.set(value);
    this.invalidateQr();
  }

  toggleWifiPassword(): void {
    this.wifiPasswordVisible.update((visible) => !visible);
  }

  toggleToken(): void {
    this.tokenVisible.update((visible) => !visible);
  }

  async generateQr(): Promise<void> {
    const request = ++this.generation;
    this.qrDataUrl.set('');
    this.qrError.set('');
    const result = buildTerminalProvisioningUrl({
      ssid: this.ssid(),
      wifiPassword: this.wifiPassword(),
      baseUrl: this.baseUrl(),
      terminalToken: this.terminalToken(),
    });

    if (!result.ok) {
      this.qrError.set(this.errorMessage(result.error));
      return;
    }

    this.rendering.set(true);
    try {
      const image = await renderTerminalProvisioningQr(result.url);
      if (request === this.generation) this.qrDataUrl.set(image);
    } catch {
      if (request === this.generation) {
        this.qrError.set('No se pudo generar el QR. Introduce los datos manualmente.');
      }
    } finally {
      if (request === this.generation) this.rendering.set(false);
    }
  }

  openExpanded(): void {
    if (!this.qrDataUrl()) return;
    this.expanded.set(true);
  }

  closeExpanded(): void {
    if (!this.expanded()) return;
    this.expanded.set(false);
    queueMicrotask(() => this.expandButton()?.nativeElement.focus());
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeExpanded();
  }

  @HostListener('document:keydown.shift.tab', ['$event'])
  @HostListener('document:keydown.tab', ['$event'])
  onModalTab(event: Event): void {
    if (!this.expanded()) return;
    event.preventDefault();
    this.closeExpandedButton()?.nativeElement.focus();
  }

  dismiss(): void {
    this.clearEphemeralState();
    this.dismissed.emit();
  }

  clearEphemeralState(): void {
    this.generation += 1;
    this.ssid.set('');
    this.wifiPassword.set('');
    this.baseUrl.set(this.defaultBaseUrl);
    this.qrDataUrl.set('');
    this.qrError.set('');
    this.rendering.set(false);
    this.expanded.set(false);
    this.wifiPasswordVisible.set(false);
    this.tokenVisible.set(false);
  }

  ngOnDestroy(): void {
    this.clearEphemeralState();
  }

  private invalidateQr(): void {
    this.generation += 1;
    this.qrDataUrl.set('');
    this.qrError.set('');
    this.rendering.set(false);
    this.expanded.set(false);
  }

  private errorMessage(error: TerminalProvisioningQrErrorCode): string {
    const messages: Record<TerminalProvisioningQrErrorCode, string> = {
      ssid_required: 'Introduce el nombre de la red Wi-Fi.',
      ssid_too_long: 'El nombre de la red supera 32 bytes.',
      wifi_password_too_long: 'La contraseña Wi-Fi supera 63 bytes.',
      base_url_required: 'Introduce la URL de OpenJornada.',
      base_url_too_long: 'La URL de OpenJornada supera 255 bytes.',
      base_url_invalid:
        'Introduce una URL HTTP o HTTPS válida, sin credenciales, consulta ni fragmento.',
      terminal_token_required: 'La API key ya no está disponible. Rótala para generar otro QR.',
      terminal_token_too_long: 'La API key supera 96 bytes.',
      terminal_token_invalid: 'La API key debe empezar por ojterm_.',
      invalid_text: 'Los campos contienen caracteres no permitidos.',
      qr_url_too_long:
        'Los datos son válidos, pero no caben en un QR seguro. Usa la entrada manual.',
    };
    return messages[error];
  }
}
