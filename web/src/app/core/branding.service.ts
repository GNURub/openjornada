import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, signal } from '@angular/core';
import { OrganizationRecord } from './models';
import { PocketBaseService } from './pocketbase.service';

export const DEFAULT_PRIMARY_COLOR = '#ef4d32';
export const DEFAULT_SECONDARY_COLOR = '#1c1917';
export const DEFAULT_PRODUCT_NAME = 'OpenJornada';
export const DEFAULT_LOGO_URL = '/brand/openjornada-mark.png';
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

type Rgb = readonly [number, number, number];

function toRgb(color: string): Rgb {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function toHex(values: Rgb): string {
  return `#${values.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
}

function mix(color: string, target: Rgb, amount: number): string {
  const source = toRgb(color);
  return toHex([
    source[0] + (target[0] - source[0]) * amount,
    source[1] + (target[1] - source[1]) * amount,
    source[2] + (target[2] - source[2]) * amount,
  ]);
}

export function normalizeBrandColor(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim().toLowerCase() ?? '';
  return HEX_COLOR_PATTERN.test(normalized) ? normalized : fallback;
}

export function createPrimaryPalette(primary: string): Record<string, string> {
  const color = normalizeBrandColor(primary, DEFAULT_PRIMARY_COLOR);
  return {
    '50': mix(color, [255, 255, 255], 0.92),
    '100': mix(color, [255, 255, 255], 0.82),
    '200': mix(color, [255, 255, 255], 0.65),
    '300': mix(color, [255, 255, 255], 0.42),
    '400': mix(color, [255, 255, 255], 0.18),
    '500': color,
    '600': mix(color, [0, 0, 0], 0.12),
    '700': mix(color, [0, 0, 0], 0.28),
    '950': mix(color, [0, 0, 0], 0.7),
  };
}

@Injectable({ providedIn: 'root' })
export class BrandingService {
  private readonly document = inject(DOCUMENT);
  private readonly pb = inject(PocketBaseService).client;
  private readonly organization = signal<OrganizationRecord | null>(null);
  private loadSequence = 0;

  readonly primaryColor = computed(() =>
    normalizeBrandColor(this.organization()?.brandPrimaryColor, DEFAULT_PRIMARY_COLOR),
  );
  readonly secondaryColor = computed(() =>
    normalizeBrandColor(this.organization()?.brandSecondaryColor, DEFAULT_SECONDARY_COLOR),
  );
  readonly displayName = computed(
    () =>
      this.organization()?.pwaName?.trim() ||
      this.organization()?.name?.trim() ||
      DEFAULT_PRODUCT_NAME,
  );
  readonly shortName = computed(
    () => this.organization()?.pwaShortName?.trim() || this.displayName().slice(0, 20),
  );
  readonly logoUrl = computed(() => {
    const record = this.organization();
    return record?.brandLogo ? this.pb.files.getURL(record, record.brandLogo) : DEFAULT_LOGO_URL;
  });
  readonly iconUrl = computed(() => {
    const record = this.organization();
    return record?.pwaIcon
      ? this.pb.files.getURL(record, record.pwaIcon)
      : '/icons/icon-512x512.png';
  });

  constructor() {
    this.applyToDocument();
  }

  async syncForOrganization(organizationId: string | null): Promise<void> {
    const sequence = ++this.loadSequence;
    if (!organizationId) {
      this.organization.set(null);
      this.applyToDocument();
      return;
    }
    try {
      const record = (await this.pb
        .collection('organizations')
        .getOne(organizationId)) as OrganizationRecord;
      if (sequence === this.loadSequence) this.applyOrganization(record);
    } catch {
      if (sequence === this.loadSequence) {
        this.organization.set(null);
        this.applyToDocument();
      }
    }
  }

  applyOrganization(record: OrganizationRecord): void {
    this.organization.set(record);
    this.applyToDocument();
  }

  private applyToDocument(): void {
    const root = this.document.documentElement;
    const palette = createPrimaryPalette(this.primaryColor());
    root.style.setProperty('--brand-primary', this.primaryColor());
    root.style.setProperty('--brand-secondary', this.secondaryColor());
    for (const [shade, value] of Object.entries(palette)) {
      root.style.setProperty(`--color-coral-${shade}`, value);
    }

    this.document.title = `${this.displayName()} · Gestión laboral`;
    this.setMetaContent('theme-color', this.secondaryColor());
    this.setMetaContent('apple-mobile-web-app-title', this.shortName());

    const record = this.organization();
    this.setLinkHref(
      'manifest',
      record
        ? `${this.pb.baseURL}/api/openjornada/branding/${record.id}/manifest.json`
        : 'manifest.json',
    );
    this.setLinkHref(
      'apple-touch-icon',
      record?.pwaIcon
        ? this.pb.files.getURL(record, record.pwaIcon, { thumb: '180x180' })
        : 'apple-touch-icon.png',
    );
    for (const icon of Array.from(
      this.document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'),
    )) {
      if (record?.pwaIcon) {
        const sizes = icon.getAttribute('sizes') ?? '';
        const thumb = sizes === '16x16' || sizes === '32x32' ? sizes : '';
        icon.href = this.pb.files.getURL(record, record.pwaIcon, thumb ? { thumb } : undefined);
        icon.type = 'image/png';
      } else {
        icon.href = icon.dataset['defaultHref'] ?? icon.getAttribute('href') ?? '';
        icon.type = icon.dataset['defaultType'] ?? icon.type;
      }
    }
  }

  private setMetaContent(name: string, content: string): void {
    this.document
      .querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
      ?.setAttribute('content', content);
  }

  private setLinkHref(rel: string, href: string): void {
    this.document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)?.setAttribute('href', href);
  }
}
