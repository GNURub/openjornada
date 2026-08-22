import type { TerminalProvisioningInput } from './terminal-provisioning-qr';

export const TERMINAL_PROVISIONING_V1_VECTOR: Readonly<{
  input: TerminalProvisioningInput;
  canonicalJson: string;
  url: string;
}> = Object.freeze({
  input: Object.freeze({
    ssid: 'Red Demo',
    wifiPassword: 'Clave WiFi 123!',
    baseUrl: 'https://jornada.example.com',
    terminalToken: 'ojterm_demo_1234567890',
  }),
  canonicalJson:
    '{"v":1,"s":"Red Demo","p":"Clave WiFi 123!","u":"https://jornada.example.com","t":"ojterm_demo_1234567890"}',
  url: 'http://192.168.4.1/#ojp=eyJ2IjoxLCJzIjoiUmVkIERlbW8iLCJwIjoiQ2xhdmUgV2lGaSAxMjMhIiwidSI6Imh0dHBzOi8vam9ybmFkYS5leGFtcGxlLmNvbSIsInQiOiJvanRlcm1fZGVtb18xMjM0NTY3ODkwIn0',
});
