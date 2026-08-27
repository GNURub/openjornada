import { describe, expect, it } from 'vitest';
import {
  clockStatusLabel,
  formatLatency,
  formatTerminalUptime,
  firmwareUpdateErrorLabel,
  firmwareUpdateStatusLabel,
  terminalDatePresentation,
  wifiQuality,
} from './terminal-diagnostics';

describe('terminal diagnostics formatting', () => {
  it.each([
    [-67, 'Buena'],
    [-68, 'Aceptable'],
    [-79, 'Aceptable'],
    [-80, 'Débil'],
  ] as const)('maps %i dBm to %s', (rssi, label) => expect(wifiQuality(rssi)).toBe(label));

  it('formats uptime without treating missing data as zero', () => {
    expect(formatTerminalUptime(null)).toBe('Sin datos');
    expect(formatTerminalUptime(0)).toBe('0 min');
    expect(formatTerminalUptime(90_061)).toBe('1 d 1 h 1 min');
  });

  it('formats latency and clamps negative values', () => {
    expect(formatLatency(-20)).toBe('0 ms');
    expect(formatLatency(850)).toBe('850 ms');
    expect(formatLatency(1_250)).toBe('1,25 s');
  });

  it('uses Spanish relative time and exposes an exact title', () => {
    const result = terminalDatePresentation(
      '2026-08-27T11:59:30Z',
      Date.parse('2026-08-27T12:00:00Z'),
    );
    expect(result.relative).toBe('hace 30 segundos');
    expect(result.exact).toContain('27 ago 2026');
  });

  it('returns safe labels for missing and invalid values', () => {
    expect(wifiQuality(null)).toBe('Sin datos');
    expect(terminalDatePresentation('not-a-date')).toEqual({
      relative: 'Sin datos',
      exact: 'Sin datos',
    });
    expect(clockStatusLabel('')).toBe('Sin datos');
    expect(clockStatusLabel('stale')).toBe('Desactualizado');
  });

  it('explains firmware update and rollback states in Spanish', () => {
    expect(firmwareUpdateStatusLabel('')).toBe('Sin datos');
    expect(firmwareUpdateStatusLabel('idle')).toBe('En espera');
    expect(firmwareUpdateStatusLabel('downloading')).toBe('Descargando');
    expect(firmwareUpdateStatusLabel('rolled_back')).toBe('Revertido');
    expect(firmwareUpdateErrorLabel('rollback')).toContain('versión anterior');
  });
});
