import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { McpTokenRecord } from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';
import { TerminalRecord } from '../../core/terminal.models';
import { TerminalService } from '../../core/terminal.service';

interface TokenListResponse {
  items: McpTokenRecord[];
  mcpUrl: string;
}

@Component({
  selector: 'app-integrations',
  imports: [FormsModule],
  templateUrl: './integrations.component.html',
})
export class IntegrationsComponent {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly auth = inject(AuthService);
  private readonly terminalService = inject(TerminalService);
  protected readonly tokens = signal<McpTokenRecord[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly revoking = signal('');
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly generatedToken = signal('');
  protected readonly terminals = signal<TerminalRecord[]>([]);
  protected readonly terminalsLoading = signal(true);
  protected readonly terminalSaving = signal(false);
  protected readonly generatedTerminalToken = signal('');
  protected readonly adminPinConfigured = signal(false);
  protected readonly mcpUrl = signal('https://tu-dominio.example/mcp');
  protected readonly codexConfig = computed(
    () => `[mcp_servers.openjornada]
url = "${this.mcpUrl()}"
bearer_token_env_var = "OPENJORNADA_MCP_TOKEN"
default_tools_approval_mode = "writes"`,
  );
  protected readonly activeTokens = computed(
    () =>
      this.tokens().filter(
        (token) => !token.revokedAt && new Date(token.expiresAt).getTime() > Date.now(),
      ).length,
  );

  protected name = '';
  protected terminalName = '';
  protected terminalPin = '';
  protected expiresOn = this.defaultExpiry();
  protected readonly minExpiry = this.dateInput(new Date(Date.now() + 24 * 60 * 60 * 1000));
  protected readonly maxExpiry = this.dateInput(this.addDays(this.addMonths(new Date(), 6), -1));

  constructor() {
    void this.load();
    void this.loadTerminals();
  }

  protected async loadTerminals(): Promise<void> {
    this.terminalsLoading.set(true);
    try {
      const response = await this.terminalService.listTerminals();
      this.terminals.set(response.items);
      this.adminPinConfigured.set(response.adminPinConfigured);
    } catch (error) {
      this.error.set(this.errorMessage(error, 'No se pudieron cargar los terminales RFID.'));
    } finally {
      this.terminalsLoading.set(false);
    }
  }

  protected async createTerminal(): Promise<void> {
    const name = this.terminalName.trim();
    if (name.length < 3 || this.terminalSaving()) return;
    this.terminalSaving.set(true);
    this.error.set('');
    try {
      const terminal = await this.terminalService.createTerminal(name);
      this.terminals.update((items) => [terminal, ...items]);
      this.generatedTerminalToken.set(terminal.token ?? '');
      this.terminalName = '';
      this.success.set('Terminal creado. Copia la API key ahora.');
    } catch (error) {
      this.error.set(this.errorMessage(error, 'No se pudo crear el terminal.'));
    } finally {
      this.terminalSaving.set(false);
    }
  }

  protected async rotateTerminal(terminal: TerminalRecord): Promise<void> {
    if (
      terminal.lastPendingCount > 0 &&
      !confirm(
        'El terminal informó de fichajes pendientes. Rotar la key impedirá sincronizarlos. ¿Continuar?',
      )
    ) {
      return;
    }
    if (!confirm(`¿Rotar la API key de “${terminal.name}”? La anterior dejará de funcionar.`))
      return;
    try {
      const updated = await this.terminalService.rotateTerminalKey(terminal.id);
      this.terminals.update((items) =>
        items.map((item) => (item.id === terminal.id ? updated : item)),
      );
      this.generatedTerminalToken.set(updated.token ?? '');
      this.success.set('API key rotada. Copia la nueva credencial ahora.');
    } catch (error) {
      this.error.set(this.errorMessage(error, 'No se pudo rotar la API key.'));
    }
  }

  protected async renameTerminal(terminal: TerminalRecord): Promise<void> {
    const name = prompt('Nuevo nombre del terminal:', terminal.name)?.trim();
    if (!name || name === terminal.name) return;
    try {
      const updated = await this.terminalService.renameTerminal(terminal.id, name);
      this.terminals.update((items) =>
        items.map((item) => (item.id === terminal.id ? updated : item)),
      );
      this.success.set('Terminal renombrado.');
    } catch (error) {
      this.error.set(this.errorMessage(error, 'No se pudo renombrar el terminal.'));
    }
  }

  protected async revokeTerminal(terminal: TerminalRecord): Promise<void> {
    const pending =
      terminal.lastPendingCount > 0 ? ' Tiene fichajes pendientes sin sincronizar.' : '';
    if (!confirm(`¿Revocar “${terminal.name}”?${pending}`)) return;
    try {
      const updated = await this.terminalService.revokeTerminal(terminal.id);
      this.terminals.update((items) =>
        items.map((item) => (item.id === terminal.id ? updated : item)),
      );
      this.success.set('Terminal revocado.');
    } catch (error) {
      this.error.set(this.errorMessage(error, 'No se pudo revocar el terminal.'));
    }
  }

  protected async saveTerminalPin(): Promise<void> {
    if (!/^\d{4}$/.test(this.terminalPin)) {
      this.error.set('El PIN debe contener exactamente cuatro cifras.');
      return;
    }
    try {
      await this.terminalService.updateAdminPin(this.terminalPin);
      this.terminalPin = '';
      this.adminPinConfigured.set(true);
      this.success.set(
        'PIN de administración actualizado. Las sesiones anteriores se han cerrado.',
      );
    } catch (error) {
      this.error.set(this.errorMessage(error, 'No se pudo actualizar el PIN.'));
    }
  }

  protected async copyTerminalToken(): Promise<void> {
    const token = this.generatedTerminalToken();
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      this.success.set('API key del terminal copiada.');
    } catch {
      this.error.set('No se pudo copiar automáticamente. Selecciona la key y cópiala.');
    }
  }

  protected formatTerminalDate(value: string): string {
    return value ? this.formatDate(value) : 'Nunca';
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const response = await this.pb.send<TokenListResponse>('/api/openjornada/mcp-tokens', {
        method: 'GET',
      });
      this.tokens.set(response.items);
      if (response.mcpUrl) this.mcpUrl.set(response.mcpUrl);
    } catch (error) {
      this.error.set(this.errorMessage(error, 'No se pudieron cargar los tokens MCP.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected async create(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    this.generatedToken.set('');
    try {
      const expiresAt = new Date(`${this.expiresOn}T23:59:59`);
      const token = await this.pb.send<McpTokenRecord>('/api/openjornada/mcp-tokens', {
        method: 'POST',
        body: { name: this.name.trim(), expiresAt: expiresAt.toISOString() },
      });
      this.tokens.update((items) => [token, ...items]);
      this.generatedToken.set(token.token ?? '');
      this.name = '';
      this.expiresOn = this.defaultExpiry();
      this.success.set('Token creado. Cópialo ahora: no volverá a mostrarse.');
    } catch (error) {
      this.error.set(this.errorMessage(error, 'No se pudo crear el token MCP.'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async revoke(token: McpTokenRecord): Promise<void> {
    if (this.revoking()) return;
    this.revoking.set(token.id);
    this.error.set('');
    this.success.set('');
    try {
      const updated = await this.pb.send<McpTokenRecord>(
        `/api/openjornada/mcp-tokens/${token.id}/revoke`,
        { method: 'POST' },
      );
      this.tokens.update((items) => items.map((item) => (item.id === token.id ? updated : item)));
      this.success.set(`Se ha revocado “${token.name}”.`);
    } catch (error) {
      this.error.set(this.errorMessage(error, 'No se pudo revocar el token MCP.'));
    } finally {
      this.revoking.set('');
    }
  }

  protected async copyToken(): Promise<void> {
    const token = this.generatedToken();
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      this.success.set('Token copiado al portapapeles.');
    } catch {
      this.error.set('No se pudo copiar automáticamente. Selecciona el token y cópialo.');
    }
  }

  protected dismissToken(): void {
    this.generatedToken.set('');
  }

  protected isActive(token: McpTokenRecord): boolean {
    return !token.revokedAt && new Date(token.expiresAt).getTime() > Date.now();
  }

  protected statusLabel(token: McpTokenRecord): string {
    if (token.revokedAt) return 'Revocado';
    if (!this.isActive(token)) return 'Caducado';
    return 'Activo';
  }

  protected formatDate(value: string): string {
    if (!value) return 'Nunca';
    return new Intl.DateTimeFormat('es-ES', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  }

  private defaultExpiry(): string {
    return this.dateInput(this.addMonths(new Date(), 1));
  }

  private addMonths(date: Date, months: number): Date {
    const result = new Date(date);
    result.setMonth(result.getMonth() + months);
    return result;
  }

  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }

  private dateInput(date: Date): string {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 10);
  }

  private errorMessage(error: unknown, fallback: string): string {
    if (
      typeof error === 'object' &&
      error !== null &&
      'response' in error &&
      typeof error.response === 'object' &&
      error.response !== null &&
      'message' in error.response
    ) {
      return String(error.response.message);
    }
    return fallback;
  }
}
