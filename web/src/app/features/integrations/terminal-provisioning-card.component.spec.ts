import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { PocketBaseService } from '../../core/pocketbase.service';
import type { TerminalRecord } from '../../core/terminal.models';
import { TerminalService } from '../../core/terminal.service';
import { IntegrationsComponent } from './integrations.component';
import { TerminalProvisioningCardComponent } from './terminal-provisioning-card.component';

@Component({
  imports: [TerminalProvisioningCardComponent],
  template: `
    @if (token()) {
      <app-terminal-provisioning-card [terminalToken]="token()" />
    }
  `,
})
class HostComponent {
  readonly token = signal('ojterm_first_1234567890');
}

describe('TerminalProvisioningCardComponent', () => {
  let fixture: ComponentFixture<TerminalProvisioningCardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TerminalProvisioningCardComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(TerminalProvisioningCardComponent);
    fixture.componentRef.setInput('terminalToken', 'ojterm_test_1234567890');
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.restoreAllMocks();
  });

  it('starts masked, preloads the browser origin and never submits from an eye button', () => {
    const host = fixture.nativeElement as HTMLElement;
    const password = host.querySelector<HTMLInputElement>('#provisioning_wifi_password')!;
    const token = host.querySelector<HTMLInputElement>('#provisioning_terminal_token')!;
    const eyes = [...host.querySelectorAll<HTMLButtonElement>('[data-secret-toggle]')];

    expect(password.type).toBe('password');
    expect(token.type).toBe('password');
    expect(eyes.map((button) => button.type)).toEqual(['button', 'button']);
    expect(eyes.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
    expect(host.querySelector<HTMLInputElement>('#provisioning_base_url')!.value).toBe(
      location.origin,
    );

    eyes[0].click();
    fixture.detectChanges();

    expect(password.type).toBe('text');
    expect(eyes[0].getAttribute('aria-pressed')).toBe('true');
    expect(eyes[0].getAttribute('aria-label')).toBe('Ocultar contraseña Wi-Fi');
  });

  it('clears Wi-Fi, token-derived QR and reveal state before dismissing', async () => {
    const component = fixture.componentInstance;
    const dismissed = vi.fn();
    component.dismissed.subscribe(dismissed);
    component.setSsid('Red Demo');
    component.setWifiPassword('Clave WiFi 123!');
    component.setBaseUrl('https://jornada.example.com');
    await component.generateQr();
    component.toggleWifiPassword();
    component.toggleToken();

    expect(component.qrDataUrl()).not.toBe('');

    component.dismiss();

    expect(component.ssid()).toBe('');
    expect(component.wifiPassword()).toBe('');
    expect(component.baseUrl()).toBe(location.origin);
    expect(component.qrDataUrl()).toBe('');
    expect(component.wifiPasswordVisible()).toBe(false);
    expect(component.tokenVisible()).toBe(false);
    expect(dismissed).toHaveBeenCalledOnce();
  });

  it('invalidates a generated QR whenever an editable field changes', async () => {
    const component = fixture.componentInstance;
    component.setSsid('Red Demo');
    component.setWifiPassword('Clave WiFi 123!');
    component.setBaseUrl('https://jornada.example.com');
    await component.generateQr();
    component.openExpanded();

    component.setSsid('Otra red');

    expect(component.qrDataUrl()).toBe('');
    expect(component.expanded()).toBe(false);
  });

  it('explains open networks and never reuses a previous Wi-Fi password', async () => {
    const component = fixture.componentInstance;
    const host = fixture.nativeElement as HTMLElement;
    const password = host.querySelector<HTMLInputElement>('#provisioning_wifi_password')!;
    const hint = host.querySelector<HTMLElement>('#provisioning_wifi_password_hint')!;
    component.setSsid('Red Demo');
    component.setWifiPassword('Clave WiFi 123!');
    component.setBaseUrl('https://jornada.example.com');
    await component.generateQr();
    const passwordQr = component.qrDataUrl();

    expect(password.getAttribute('aria-describedby')).toBe(hint.id);
    expect(hint.textContent).toContain('Déjala vacía sólo si la red Wi-Fi es abierta.');

    component.setWifiPassword('');
    expect(component.qrDataUrl()).toBe('');
    await component.generateQr();

    expect(component.wifiPassword()).toBe('');
    expect(component.qrDataUrl()).not.toBe('');
    expect(component.qrDataUrl()).not.toBe(passwordQr);
  });

  it('removes every secret from state and DOM synchronously on pagehide', async () => {
    const component = fixture.componentInstance;
    const host = fixture.nativeElement as HTMLElement;
    component.setSsid('Red BFCache');
    component.setBaseUrl('https://jornada.example.com');
    const password = host.querySelector<HTMLInputElement>('#provisioning_wifi_password')!;
    password.value = 'Clave BFCache 123!';
    password.dispatchEvent(new Event('input', { bubbles: true }));
    await component.generateQr();
    component.toggleWifiPassword();
    component.toggleToken();
    fixture.detectChanges();

    expect(host.querySelector<HTMLInputElement>('#provisioning_terminal_token')?.value).toBe(
      'ojterm_test_1234567890',
    );
    expect(password.value).toBe('Clave BFCache 123!');

    window.dispatchEvent(new Event('pagehide'));

    expect(component.ssid()).toBe('');
    expect(component.wifiPassword()).toBe('');
    expect(component.qrDataUrl()).toBe('');
    expect(component.wifiPasswordVisible()).toBe(false);
    expect(component.tokenVisible()).toBe(false);
    expect(host.childElementCount).toBe(0);
    expect(host.textContent).not.toContain('Red BFCache');
    expect(host.textContent).not.toContain('Clave BFCache 123!');
    expect(host.textContent).not.toContain('ojterm_test_1234567890');
  });

  it('does not persist or send locally entered provisioning data', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const xhrOpenSpy = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    const component = fixture.componentInstance;

    component.setSsid('Red local');
    component.setWifiPassword('Clave local 123!');
    component.setBaseUrl('https://jornada.example.com');
    await component.generateQr();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrOpenSpy).not.toHaveBeenCalled();
    expect(storageSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
    xhrOpenSpy.mockRestore();
    storageSpy.mockRestore();
  });

  it('closes the expanded QR with Escape and returns focus to its trigger', async () => {
    const component = fixture.componentInstance;
    component.setSsid('Red Demo');
    component.setWifiPassword('Clave WiFi 123!');
    component.setBaseUrl('https://jornada.example.com');
    await component.generateQr();
    fixture.detectChanges();

    const expandButton = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '[data-testid="expand-provisioning-qr"]',
    )!;
    fixture.autoDetectChanges();
    expandButton.focus();
    expandButton.click();
    await fixture.whenStable();

    const dialog = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      '[role="dialog"]',
    );
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('button')).toBe(document.activeElement);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    await Promise.resolve();

    expect((fixture.nativeElement as HTMLElement).querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(expandButton);
  });

  it('keeps keyboard focus inside the expanded QR', async () => {
    const component = fixture.componentInstance;
    component.setSsid('Red Demo');
    component.setWifiPassword('Clave WiFi 123!');
    component.setBaseUrl('https://jornada.example.com');
    await component.generateQr();
    fixture.detectChanges();

    const expandButton = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '[data-testid="expand-provisioning-qr"]',
    )!;
    expandButton.click();
    fixture.detectChanges();
    await Promise.resolve();
    const closeButton = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '[role="dialog"] button',
    )!;

    expandButton.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(closeButton);

    expandButton.focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(closeButton);
  });
});

interface TestableIntegrationsComponent {
  terminalName: string;
  terminalPin: string;
  loadTerminals(page?: number): Promise<void>;
  createTerminal(): Promise<void>;
  saveTerminalPin(): Promise<void>;
  rotateTerminal(terminal: TerminalRecord): Promise<void>;
  terminals(): TerminalRecord[];
  adminPinConfigured(): boolean;
  terminalPage(): number;
  terminalTotalItems(): number;
  terminalTotalPages(): number;
  terminalSaving(): boolean;
  generatedTerminalToken(): string;
}

function terminalRecord(id: string, token?: string): TerminalRecord {
  const record = {
    id,
    collectionId: 'attendance_terminals',
    collectionName: 'attendance_terminals',
    organization: 'organization-1',
    name: 'Recepción',
    prefix: 'demo',
    protocolVersion: 1,
    clientVersion: '',
    cacheRevision: 0,
    lastSeenAt: '',
    lastPendingCount: 0,
    revokedAt: '',
    createdBy: 'admin-1',
    created: '2026-08-22 18:00:00.000Z',
  } as TerminalRecord;
  return token ? { ...record, token } : record;
}

describe('IntegrationsComponent terminal credential lifecycle', () => {
  let createTerminal: ReturnType<typeof vi.fn>;
  let listTerminals: ReturnType<typeof vi.fn>;
  let rotateTerminalKey: ReturnType<typeof vi.fn>;
  let updateAdminPin: ReturnType<typeof vi.fn>;
  let fixture: ComponentFixture<IntegrationsComponent>;
  let component: TestableIntegrationsComponent;

  beforeEach(async () => {
    createTerminal = vi.fn();
    listTerminals = vi.fn().mockResolvedValue({
      items: [terminalRecord('terminal-1')],
      adminPinConfigured: true,
      page: 1,
      perPage: 10,
      totalItems: 1,
      totalPages: 1,
    });
    rotateTerminalKey = vi.fn();
    updateAdminPin = vi.fn();
    await TestBed.configureTestingModule({
      imports: [IntegrationsComponent],
      providers: [
        { provide: AuthService, useValue: { user: signal({ role: 'admin' }) } },
        {
          provide: PocketBaseService,
          useValue: { client: { send: vi.fn().mockResolvedValue({ items: [], mcpUrl: '' }) } },
        },
        {
          provide: TerminalService,
          useValue: {
            listTerminals,
            createTerminal,
            rotateTerminalKey,
            updateAdminPin,
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(IntegrationsComponent);
    component = fixture.componentInstance as unknown as TestableIntegrationsComponent;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
    vi.restoreAllMocks();
  });

  it('stores a newly issued token only in the one-time signal', async () => {
    createTerminal.mockResolvedValue(terminalRecord('terminal-2', 'ojterm_created_1234567890'));
    component.terminalName = 'Almacén';

    await component.createTerminal();

    expect(component.generatedTerminalToken()).toBe('ojterm_created_1234567890');
    expect(component.terminals()[0].id).toBe('terminal-2');
    expect(component.terminals()[0]).not.toHaveProperty('token');
  });

  it('loads terminal pages and exposes their server metadata', async () => {
    listTerminals.mockResolvedValueOnce({
      items: [terminalRecord('terminal-11')],
      adminPinConfigured: true,
      page: 2,
      perPage: 10,
      totalItems: 11,
      totalPages: 2,
    });

    await component.loadTerminals(2);
    fixture.detectChanges();

    expect(listTerminals).toHaveBeenLastCalledWith(2);
    expect(component.terminals().map((terminal) => terminal.id)).toEqual(['terminal-11']);
    expect(component.terminalPage()).toBe(2);
    expect(component.terminalTotalItems()).toBe(11);
    expect(component.terminalTotalPages()).toBe(2);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Mostrando 11–11 de 11');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Página 2 de 2');
  });

  it('keeps paginator focus while the next page is loading', async () => {
    listTerminals.mockResolvedValueOnce({
      items: Array.from({ length: 10 }, (_, index) => terminalRecord(`terminal-${index + 1}`)),
      adminPinConfigured: true,
      page: 1,
      perPage: 10,
      totalItems: 11,
      totalPages: 2,
    });
    await component.loadTerminals(1);
    fixture.detectChanges();
    let finishList!: (response: {
      items: TerminalRecord[];
      adminPinConfigured: boolean;
      page: number;
      perPage: number;
      totalItems: number;
      totalPages: number;
    }) => void;
    listTerminals.mockReturnValueOnce(
      new Promise((resolve) => {
        finishList = resolve;
      }),
    );
    const nextButton = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === 'Siguiente');
    expect(nextButton).toBeDefined();
    nextButton?.focus();

    nextButton?.click();
    fixture.detectChanges();

    expect(nextButton?.isConnected).toBe(true);
    expect(document.activeElement).toBe(nextButton);
    expect(nextButton?.disabled).toBe(true);
    finishList({
      items: [terminalRecord('terminal-11')],
      adminPinConfigured: true,
      page: 2,
      perPage: 10,
      totalItems: 11,
      totalPages: 2,
    });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(document.activeElement).toBe(nextButton);
  });

  it('returns to the first ordered page after creating from another page', async () => {
    listTerminals.mockResolvedValueOnce({
      items: [terminalRecord('terminal-11')],
      adminPinConfigured: true,
      page: 2,
      perPage: 10,
      totalItems: 11,
      totalPages: 2,
    });
    await component.loadTerminals(2);
    createTerminal.mockResolvedValue(terminalRecord('terminal-12', 'ojterm_created_1234567890'));
    listTerminals.mockResolvedValueOnce({
      items: [terminalRecord('terminal-12'), terminalRecord('terminal-1')],
      adminPinConfigured: true,
      page: 1,
      perPage: 10,
      totalItems: 12,
      totalPages: 2,
    });
    component.terminalName = 'Almacén';

    await component.createTerminal();

    expect(listTerminals).toHaveBeenLastCalledWith(1);
    expect(component.terminalPage()).toBe(1);
    expect(component.terminals()[0].id).toBe('terminal-12');
    expect(component.terminals()[0]).not.toHaveProperty('token');
    expect(component.generatedTerminalToken()).toBe('ojterm_created_1234567890');
  });

  it('does not create while a terminal page request is pending', async () => {
    let finishList!: (response: {
      items: TerminalRecord[];
      adminPinConfigured: boolean;
      page: number;
      perPage: number;
      totalItems: number;
      totalPages: number;
    }) => void;
    listTerminals.mockReturnValueOnce(
      new Promise((resolve) => {
        finishList = resolve;
      }),
    );
    const loading = component.loadTerminals(1);
    component.terminalName = 'Almacén';

    await component.createTerminal();

    expect(createTerminal).not.toHaveBeenCalled();
    finishList({
      items: [terminalRecord('terminal-1')],
      adminPinConfigured: true,
      page: 1,
      perPage: 10,
      totalItems: 1,
      totalPages: 1,
    });
    await loading;
  });

  it('does not refresh while a terminal credential creation is pending', async () => {
    let finishCreation!: (terminal: TerminalRecord) => void;
    createTerminal.mockReturnValue(
      new Promise<TerminalRecord>((resolve) => {
        finishCreation = resolve;
      }),
    );
    component.terminalName = 'Almacén';
    const creation = component.createTerminal();
    const listCallsBeforeRefresh = listTerminals.mock.calls.length;

    await component.loadTerminals(1);

    expect(listTerminals).toHaveBeenCalledTimes(listCallsBeforeRefresh);
    finishCreation(terminalRecord('terminal-2', 'ojterm_created_1234567890'));
    await creation;
    expect(component.terminals().filter((terminal) => terminal.id === 'terminal-2')).toHaveLength(
      1,
    );
    expect(component.terminalTotalItems()).toBe(2);
  });

  it('does not refresh with stale PIN state while the PIN update is pending', async () => {
    let finishPinUpdate!: (response: { configured: boolean }) => void;
    updateAdminPin.mockReturnValue(
      new Promise((resolve) => {
        finishPinUpdate = resolve;
      }),
    );
    component.terminalPin = '9669';
    const update = component.saveTerminalPin();
    const listCallsBeforeRefresh = listTerminals.mock.calls.length;

    await component.loadTerminals(1);

    expect(listTerminals).toHaveBeenCalledTimes(listCallsBeforeRefresh);
    finishPinUpdate({ configured: true });
    await update;
    expect(component.adminPinConfigured()).toBe(true);
  });

  it('removes the one-time token and child secrets synchronously on pagehide', async () => {
    createTerminal.mockResolvedValue(terminalRecord('terminal-2', 'ojterm_bfcache_1234567890'));
    component.terminalName = 'Almacén';
    await component.createTerminal();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const child = fixture.debugElement.query(By.directive(TerminalProvisioningCardComponent))
      .componentInstance as TerminalProvisioningCardComponent;
    child.setSsid('Red padre BFCache');
    child.setWifiPassword('Clave padre BFCache 123!');
    child.toggleWifiPassword();
    child.toggleToken();
    await child.generateQr();
    fixture.detectChanges();

    expect(component.generatedTerminalToken()).toBe('ojterm_bfcache_1234567890');
    expect(host.querySelector<HTMLInputElement>('#provisioning_terminal_token')?.value).toBe(
      'ojterm_bfcache_1234567890',
    );

    window.dispatchEvent(new Event('pagehide'));

    expect(component.generatedTerminalToken()).toBe('');
    expect(child.ssid()).toBe('');
    expect(child.wifiPassword()).toBe('');
    expect(child.qrDataUrl()).toBe('');
    expect(child.wifiPasswordVisible()).toBe(false);
    expect(child.tokenVisible()).toBe(false);
    expect(host.querySelector('#provisioning_terminal_token')).toBeNull();
    expect(host.querySelector('#provisioning_wifi_password')).toBeNull();
    expect(host.textContent).not.toContain('ojterm_bfcache_1234567890');
    expect(host.textContent).not.toContain('Clave padre BFCache 123!');
  });

  it('discards a terminal credential when creation resolves after pagehide', async () => {
    let finishCreation!: (terminal: TerminalRecord) => void;
    createTerminal.mockReturnValue(
      new Promise<TerminalRecord>((resolve) => {
        finishCreation = resolve;
      }),
    );
    component.terminalName = 'Almacén';

    const creation = component.createTerminal();
    window.dispatchEvent(new Event('pagehide'));
    finishCreation(terminalRecord('terminal-2', 'ojterm_late_create_1234567890'));
    await creation;

    expect(component.generatedTerminalToken()).toBe('');
    expect(component.terminals()).not.toContainEqual(expect.objectContaining({ id: 'terminal-2' }));
  });

  it('discards a terminal credential when rotation resolves after pagehide', async () => {
    let finishRotation!: (terminal: TerminalRecord) => void;
    rotateTerminalKey.mockReturnValue(
      new Promise<TerminalRecord>((resolve) => {
        finishRotation = resolve;
      }),
    );
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);

    const rotation = component.rotateTerminal(component.terminals()[0]);
    window.dispatchEvent(new Event('pagehide'));
    finishRotation(terminalRecord('terminal-1', 'ojterm_late_rotate_1234567890'));
    await rotation;

    expect(component.generatedTerminalToken()).toBe('');
    expect(component.terminals()[0]).not.toHaveProperty('token');
  });

  it('stores a rotated token only in the one-time signal', async () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    rotateTerminalKey.mockResolvedValue(terminalRecord('terminal-1', 'ojterm_rotated_1234567890'));

    await component.rotateTerminal(component.terminals()[0]);

    expect(component.generatedTerminalToken()).toBe('ojterm_rotated_1234567890');
    expect(component.terminals()[0]).not.toHaveProperty('token');
  });

  it('prevents a rotation while another credential is being issued', async () => {
    let finishCreation!: (terminal: TerminalRecord) => void;
    createTerminal.mockReturnValue(
      new Promise<TerminalRecord>((resolve) => {
        finishCreation = resolve;
      }),
    );
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    component.terminalName = 'Almacén';

    const creation = component.createTerminal();
    await component.rotateTerminal(component.terminals()[0]);

    expect(component.terminalSaving()).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(rotateTerminalKey).not.toHaveBeenCalled();

    finishCreation(terminalRecord('terminal-2', 'ojterm_created_1234567890'));
    await creation;
    expect(component.terminalSaving()).toBe(false);
  });
});

describe('TerminalProvisioningCardComponent lifecycle', () => {
  it('resets local state when the one-time key changes and removes it on destroy', async () => {
    const hostFixture = TestBed.createComponent(HostComponent);
    hostFixture.detectChanges();
    const child = hostFixture.debugElement.query(By.directive(TerminalProvisioningCardComponent))
      .componentInstance as TerminalProvisioningCardComponent;
    child.setSsid('Red efímera');
    child.setWifiPassword('Clave efímera 123!');
    child.setBaseUrl('https://jornada.example.com');
    await child.generateQr();

    hostFixture.componentInstance.token.set('ojterm_second_1234567890');
    hostFixture.detectChanges();

    expect(child.ssid()).toBe('');
    expect(child.wifiPassword()).toBe('');
    expect(child.qrDataUrl()).toBe('');

    child.setSsid('Otra red efímera');
    child.setWifiPassword('Otra clave efímera');
    hostFixture.componentInstance.token.set('');
    hostFixture.detectChanges();

    expect(child.ssid()).toBe('');
    expect(child.wifiPassword()).toBe('');
    expect(hostFixture.nativeElement.querySelector('app-terminal-provisioning-card')).toBeNull();
    expect((hostFixture.nativeElement as HTMLElement).textContent).not.toContain(
      'ojterm_second_1234567890',
    );

    hostFixture.destroy();
  });
});
