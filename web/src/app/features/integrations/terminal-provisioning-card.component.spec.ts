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
  createTerminal(): Promise<void>;
  rotateTerminal(terminal: TerminalRecord): Promise<void>;
  terminals(): TerminalRecord[];
  terminalSaving(): boolean;
  generatedTerminalToken(): string;
}

function terminalRecord(id: string, token?: string): TerminalRecord {
  return {
    id,
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
    token,
  } as TerminalRecord;
}

describe('IntegrationsComponent terminal credential lifecycle', () => {
  let createTerminal: ReturnType<typeof vi.fn>;
  let rotateTerminalKey: ReturnType<typeof vi.fn>;
  let fixture: ComponentFixture<IntegrationsComponent>;
  let component: TestableIntegrationsComponent;

  beforeEach(async () => {
    createTerminal = vi.fn();
    rotateTerminalKey = vi.fn();
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
            listTerminals: vi.fn().mockResolvedValue({
              items: [terminalRecord('terminal-1')],
              adminPinConfigured: true,
            }),
            createTerminal,
            rotateTerminalKey,
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
