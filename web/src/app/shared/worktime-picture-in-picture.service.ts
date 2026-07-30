import { inject, Injectable, NgZone, signal } from '@angular/core';

interface DocumentPictureInPictureController {
  requestWindow(options?: { width: number; height: number }): Promise<Window>;
}

const AUTO_OPEN_STORAGE_KEY = 'openjornada.worktimePip.autoOpen';

@Injectable({ providedIn: 'root' })
export class WorktimePictureInPictureService {
  private readonly zone = inject(NgZone);

  readonly supported = signal(this.pictureInPictureController() !== null);
  readonly active = signal(false);
  readonly error = signal('');
  readonly autoOpen = signal(this.loadAutoOpenPreference());

  private pipWindow: Window | null = null;
  private opening: Promise<Window | null> | null = null;
  private openingGeneration = 0;
  private widget: HTMLElement | null = null;
  private home: HTMLElement | null = null;
  private widgetObserver: MutationObserver | null = null;

  setAutoOpen(enabled: boolean): void {
    this.autoOpen.set(enabled);
    try {
      window.localStorage.setItem(AUTO_OPEN_STORAGE_KEY, String(enabled));
    } catch {
      // La preferencia sigue funcionando durante la sesión.
    }
  }

  openForClockIn(): boolean {
    if (!this.supported() || !this.autoOpen()) return false;
    void this.open({ width: 384, height: 220 }).then((pipWindow) => {
      if (pipWindow) this.watchForWidget(pipWindow);
    });
    return true;
  }

  registerHost(home: HTMLElement): void {
    this.home = home;
  }

  unregisterHost(home: HTMLElement): void {
    if (this.home !== home) return;
    this.widgetObserver?.disconnect();
    this.widgetObserver = null;
    this.home = null;
    this.widget = null;
  }

  async toggle(widget: HTMLElement, home: HTMLElement): Promise<void> {
    if (this.pipWindow || this.opening) {
      this.close();
      return;
    }

    const bounds = widget.getBoundingClientRect();
    const pipWindow = await this.open({
      width: Math.max(320, Math.round(bounds.width)),
      height: Math.max(180, Math.round(bounds.height)),
    });
    if (pipWindow) {
      this.attach(widget, home, pipWindow);
    }
  }

  close(): void {
    this.openingGeneration += 1;
    const pipWindow = this.pipWindow;
    this.restore(pipWindow);
    pipWindow?.close();
  }

  private open(options: {
    width: number;
    height: number;
  }): Promise<Window | null> {
    const controller = this.pictureInPictureController();
    if (!controller) {
      this.supported.set(false);
      return Promise.resolve(null);
    }

    this.error.set('');
    const generation = ++this.openingGeneration;
    let request: Promise<Window>;
    try {
      request = controller.requestWindow(options);
    } catch {
      this.error.set(
        'No se ha podido abrir la ventana flotante. Revisa los permisos de Picture-in-Picture del navegador.',
      );
      return Promise.resolve(null);
    }
    this.opening = request
      .then((pipWindow) => {
        if (generation !== this.openingGeneration) {
          pipWindow.close();
          return null;
        }

        this.pipWindow = pipWindow;
        this.prepareDocument(pipWindow.document);
        pipWindow.addEventListener(
          'pagehide',
          () => this.zone.run(() => this.restore(pipWindow)),
          { once: true },
        );
        return pipWindow;
      })
      .catch(() => {
        if (generation === this.openingGeneration) {
          const failedWindow = this.pipWindow;
          this.restore(failedWindow);
          failedWindow?.close();
          this.error.set(
            'No se ha podido abrir la ventana flotante. Revisa los permisos de Picture-in-Picture del navegador.',
          );
        }
        return null;
      })
      .finally(() => {
        if (generation === this.openingGeneration) {
          this.opening = null;
        }
      });
    return this.opening;
  }

  private attach(
    widget: HTMLElement,
    home: HTMLElement,
    pipWindow: Window,
  ): void {
    if (this.pipWindow !== pipWindow || pipWindow.closed) return;
    this.widget = widget;
    this.home = home;
    pipWindow.document.body.append(widget);
    this.active.set(true);
  }

  private watchForWidget(pipWindow: Window): void {
    const home = this.home;
    if (!home || this.pipWindow !== pipWindow) return;

    const attachRenderedWidget = (): boolean => {
      const widget = home.querySelector<HTMLElement>(
        '[data-testid="active-worktime-widget"]',
      );
      if (!widget) return false;
      this.widgetObserver?.disconnect();
      this.widgetObserver = null;
      this.attach(widget, home, pipWindow);
      return true;
    };

    if (attachRenderedWidget()) return;
    this.widgetObserver?.disconnect();
    this.widgetObserver = new MutationObserver(() => {
      attachRenderedWidget();
    });
    this.widgetObserver.observe(home, { childList: true, subtree: true });
  }

  private restore(pipWindow: Window | null): void {
    if (pipWindow && this.pipWindow !== pipWindow) return;

    if (this.widget && this.home?.isConnected) {
      this.home.append(this.widget);
    }
    this.widgetObserver?.disconnect();
    this.widgetObserver = null;
    this.pipWindow = null;
    this.opening = null;
    this.widget = null;
    this.active.set(false);
  }

  private pictureInPictureController(): DocumentPictureInPictureController | null {
    if (window.isSecureContext === false) return null;

    const controller = (
      window as Window & {
        documentPictureInPicture?: DocumentPictureInPictureController;
      }
    ).documentPictureInPicture;
    return controller && typeof controller.requestWindow === 'function'
      ? controller
      : null;
  }

  private loadAutoOpenPreference(): boolean {
    try {
      return window.localStorage.getItem(AUTO_OPEN_STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  }

  private prepareDocument(target: Document): void {
    target.title = 'Jornada activa';

    for (const styleSheet of Array.from(document.styleSheets)) {
      try {
        const style = target.createElement('style');
        style.textContent = Array.from(styleSheet.cssRules)
          .map((rule) => rule.cssText)
          .join('\n');
        target.head.append(style);
      } catch {
        if (!styleSheet.href) continue;
        const link = target.createElement('link');
        link.rel = 'stylesheet';
        link.href = styleSheet.href;
        target.head.append(link);
      }
    }

    const overrides = target.createElement('style');
    overrides.textContent = `
      html, body {
        min-height: 100%;
        margin: 0;
        background: #0c0a09;
      }
      [data-testid="active-worktime-widget"] {
        position: static !important;
        width: auto !important;
        margin: 0 !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        transform: none !important;
      }
    `;
    target.head.append(overrides);
  }
}
