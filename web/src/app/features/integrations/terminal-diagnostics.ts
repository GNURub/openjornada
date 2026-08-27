import type { TerminalFirmwareUpdateStatus, TerminalRecord } from '../../core/terminal.models';

const relativeFormatter = new Intl.RelativeTimeFormat('es-ES', { numeric: 'always' });
const exactFormatter = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const latencyFormatter = new Intl.NumberFormat('es-ES', {
  maximumFractionDigits: 2,
});

export function wifiQuality(rssi: number | null): 'Buena' | 'Aceptable' | 'Débil' | 'Sin datos' {
  if (rssi === null || !Number.isFinite(rssi)) return 'Sin datos';
  if (rssi >= -67) return 'Buena';
  if (rssi >= -79) return 'Aceptable';
  return 'Débil';
}

export function formatTerminalUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'Sin datos';
  let remainingMinutes = Math.floor(Math.max(0, seconds) / 60);
  const days = Math.floor(remainingMinutes / (24 * 60));
  remainingMinutes -= days * 24 * 60;
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes - hours * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} d`);
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} min`);
  return parts.join(' ');
}

export function formatLatency(milliseconds: number): string {
  const safeMilliseconds = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  if (safeMilliseconds < 1000) return `${Math.round(safeMilliseconds)} ms`;
  return `${latencyFormatter.format(safeMilliseconds / 1000)} s`;
}

export function terminalDatePresentation(
  value: string,
  now = Date.now(),
): { relative: string; exact: string } {
  const timestamp = Date.parse(value);
  if (!value || !Number.isFinite(timestamp) || !Number.isFinite(now)) {
    return { relative: 'Sin datos', exact: 'Sin datos' };
  }
  const deltaSeconds = (timestamp - now) / 1000;
  const absoluteSeconds = Math.abs(deltaSeconds);
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  let divisor = 1;
  if (absoluteSeconds >= 86_400) {
    unit = 'day';
    divisor = 86_400;
  } else if (absoluteSeconds >= 3_600) {
    unit = 'hour';
    divisor = 3_600;
  } else if (absoluteSeconds >= 60) {
    unit = 'minute';
    divisor = 60;
  }
  return {
    relative: relativeFormatter.format(Math.round(deltaSeconds / divisor), unit),
    exact: exactFormatter.format(new Date(timestamp)),
  };
}

export function clockStatusLabel(value: TerminalRecord['lastClockStatus']): string {
  switch (value) {
    case 'synced':
      return 'Sincronizado';
    case 'stale':
      return 'Desactualizado';
    case 'unsynced':
      return 'Sin sincronizar';
    default:
      return 'Sin datos';
  }
}

export function firmwareUpdateStatusLabel(value: TerminalFirmwareUpdateStatus | ''): string {
  switch (value) {
    case 'idle':
      return 'En espera';
    case 'checking':
      return 'Comprobando';
    case 'available':
      return 'Disponible';
    case 'downloading':
      return 'Descargando';
    case 'verifying':
      return 'Verificando';
    case 'pending_reboot':
      return 'Reiniciando';
    case 'updated':
      return 'Actualizado';
    case 'failed':
      return 'Error';
    case 'rolled_back':
      return 'Revertido';
    case 'blocked':
      return 'Bloqueado';
    default:
      return 'Sin datos';
  }
}

export function firmwareUpdateErrorLabel(value: string): string {
  switch (value) {
    case 'manifest_signature':
      return 'La firma de la actualización no es válida.';
    case 'manifest_invalid':
      return 'La información de la actualización no es válida.';
    case 'incompatible':
      return 'La actualización no es compatible con este terminal.';
    case 'size':
      return 'El firmware no tiene el tamaño esperado.';
    case 'hash':
      return 'El firmware descargado está dañado.';
    case 'flash':
      return 'No se pudo escribir el firmware.';
    case 'boot_validation':
      return 'El firmware nuevo no superó la comprobación de arranque.';
    case 'rollback':
      return 'El terminal recuperó automáticamente la versión anterior.';
    case 'manifest_fetch':
    case 'download':
      return 'No se pudo descargar la actualización.';
    default:
      return '';
  }
}
