import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkStatus } from '../core/models';
import { WorktimeService } from '../core/worktime.service';
import { ActiveWorktimeWidgetComponent } from './active-worktime-widget.component';
import { WorktimePictureInPictureService } from './worktime-picture-in-picture.service';

describe('ActiveWorktimeWidgetComponent', () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
  });
  let fixture: ComponentFixture<ActiveWorktimeWidgetComponent>;
  let pagehideListener: EventListener | undefined;
  let pipDocument: Document;
  let pipWindow: Window;
  const closePipWindow = vi.fn();
  const requestPipWindow = vi.fn<() => Promise<Window>>();
  const originalPictureInPictureDescriptor = Object.getOwnPropertyDescriptor(
    window,
    'documentPictureInPicture',
  );
  const status = signal<WorkStatus>('off');
  const loading = signal(false);
  const submitting = signal(false);
  const error = signal('');
  const record = vi.fn<(kind: string) => Promise<boolean>>();
  const openReview = vi.fn();
  const worktime = {
    status,
    loading,
    submitting,
    error,
    workedTodayTimer: vi.fn(() => '01:02:03'),
    record,
    openReview,
  };

  beforeEach(async () => {
    status.set('off');
    loading.set(false);
    submitting.set(false);
    error.set('');
    record.mockReset();
    record.mockResolvedValue(true);
    openReview.mockReset();
    closePipWindow.mockReset();
    requestPipWindow.mockReset();
    window.localStorage.removeItem('openjornada.worktimePip.autoOpen');
    pagehideListener = undefined;
    pipDocument = document.implementation.createHTMLDocument('Jornada activa');
    pipWindow = {
      document: pipDocument,
      closed: false,
      close: closePipWindow,
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'pagehide' && typeof listener === 'function') {
          pagehideListener = listener;
        }
      }),
    } as unknown as Window;
    requestPipWindow.mockResolvedValue(pipWindow);
    Object.defineProperty(window, 'documentPictureInPicture', {
      configurable: true,
      value: {
        window: null,
        requestWindow: requestPipWindow,
      },
    });

    await TestBed.configureTestingModule({
      imports: [ActiveWorktimeWidgetComponent],
      providers: [{ provide: WorktimeService, useValue: worktime }],
    }).compileComponents();

    fixture = TestBed.createComponent(ActiveWorktimeWidgetComponent);
    fixture.detectChanges();
  });

  afterAll(() => {
    if (originalPictureInPictureDescriptor) {
      Object.defineProperty(window, 'documentPictureInPicture', originalPictureInPictureDescriptor);
    } else {
      Reflect.deleteProperty(window, 'documentPictureInPicture');
    }
  });

  it('only appears while the workday is active or paused', () => {
    expect(
      fixture.nativeElement.querySelector('[data-testid="active-worktime-widget"]'),
    ).toBeNull();

    status.set('working');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Jornada en curso');
    expect(fixture.nativeElement.textContent).toContain('01:02:03');

    status.set('paused');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Jornada en pausa');
  });

  it('does not offer Picture-in-Picture when the document API is unavailable', () => {
    TestBed.inject(WorktimePictureInPictureService).supported.set(false);
    status.set('working');
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-testid="worktime-widget-pip"]'),
    ).toBeNull();
  });

  it('opens Picture-in-Picture from the clock-in gesture and attaches the widget afterwards', async () => {
    const pip = TestBed.inject(WorktimePictureInPictureService);

    expect(pip.autoOpen()).toBe(true);
    expect(pip.openForClockIn()).toBe(true);
    expect(requestPipWindow).toHaveBeenCalledWith({
      width: 384,
      height: 220,
    });

    status.set('working');
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => window.setTimeout(resolve));
    fixture.detectChanges();

    expect(
      pipDocument.body.querySelector('[data-testid="active-worktime-widget"]'),
    ).not.toBeNull();
  });

  it('persists the automatic Picture-in-Picture preference', () => {
    const pip = TestBed.inject(WorktimePictureInPictureService);

    pip.setAutoOpen(false);

    expect(pip.autoOpen()).toBe(false);
    expect(window.localStorage.getItem('openjornada.worktimePip.autoOpen')).toBe(
      'false',
    );
    expect(pip.openForClockIn()).toBe(false);
    expect(requestPipWindow).not.toHaveBeenCalled();
  });

  it('offers the valid actions for each state', () => {
    status.set('working');
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector(
        '[data-testid="worktime-widget-pause"]',
      ) as HTMLButtonElement
    ).click();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="worktime-widget-finish"]',
      ) as HTMLButtonElement
    ).click();
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith('break_start');
    expect(openReview).toHaveBeenCalledWith('clock_out');

    status.set('paused');
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="worktime-widget-resume"]',
      ) as HTMLButtonElement
    ).click();
    expect(openReview).toHaveBeenNthCalledWith(2, 'break_end');
  });

  it('disables actions while saving and exposes service errors', () => {
    status.set('working');
    submitting.set(true);
    error.set('No se ha podido guardar el fichaje.');
    fixture.detectChanges();

    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ) as HTMLButtonElement[];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'No se ha podido guardar el fichaje.',
    );
  });

  it('moves the active widget into Document Picture-in-Picture and restores it on close', async () => {
    status.set('working');
    fixture.detectChanges();
    const widget = fixture.nativeElement.querySelector(
      '[data-testid="active-worktime-widget"]',
    ) as HTMLElement;
    const pipButton = fixture.nativeElement.querySelector(
      '[data-testid="worktime-widget-pip"]',
    ) as HTMLButtonElement;

    pipButton.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(requestPipWindow).toHaveBeenCalledWith({
      width: 320,
      height: 180,
    });
    expect(pipDocument.body.contains(widget)).toBe(true);
    expect(pipDocument.title).toBe('Jornada activa');
    expect(pipButton.getAttribute('aria-label')).toBe('Cerrar ventana flotante de jornada');

    pagehideListener?.(new Event('pagehide'));
    fixture.detectChanges();

    expect(fixture.nativeElement.contains(widget)).toBe(true);
    expect(pipButton.getAttribute('aria-label')).toBe('Abrir jornada en ventana flotante');
  });

  it('shows a useful error when the browser rejects Picture-in-Picture', async () => {
    requestPipWindow.mockRejectedValueOnce(new DOMException('Not allowed'));
    status.set('working');
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector(
        '[data-testid="worktime-widget-pip"]',
      ) as HTMLButtonElement
    ).click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Revisa los permisos de Picture-in-Picture del navegador.',
    );
  });
});
