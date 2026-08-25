import { expect, test } from '@playwright/test';
import { createServer, type Socket } from 'node:net';

async function startSmtpServer(): Promise<{
  message: () => Promise<string>;
  close: () => Promise<void>;
}> {
  let resolveMessage: ((value: string) => void) | null = null;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.write('220 openjornada-saas-e2e ESMTP\r\n');
    let buffer = '';
    let data = false;
    let lines: string[] = [];
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (data) {
          if (line === '.') {
            data = false;
            resolveMessage?.(lines.join('\n'));
            lines = [];
            socket.write('250 accepted\r\n');
          } else lines.push(line);
        } else if (/^(EHLO|HELO)\b/i.test(line)) socket.write('250 openjornada-saas-e2e\r\n');
        else if (/^(MAIL FROM|RCPT TO)\b/i.test(line)) socket.write('250 ok\r\n');
        else if (/^DATA\b/i.test(line)) {
          data = true;
          socket.write('354 continue\r\n');
        } else if (/^QUIT\b/i.test(line)) socket.end('221 bye\r\n');
        else if (line) socket.write('250 ok\r\n');
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(1026, '127.0.0.1', resolve);
  });
  return {
    message: () =>
      new Promise<string>((resolve, reject) => {
        resolveMessage = resolve;
        setTimeout(() => reject(new Error('No se recibió la invitación SaaS.')), 10_000);
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

test('el área de proveedor está separada y protegida', async ({ page }) => {
  await page.goto('/proveedor');
  await expect(page).toHaveURL(/\/proveedor\/login$/);
  await expect(page.getByRole('heading', { name: 'Gestiona el servicio' })).toBeVisible();
  await expect(page.getByText('verificación en dos pasos')).toBeVisible();
});

test('el alta pública crea una prueba sin pedir tarjeta', async ({ page }) => {
  const smtp = await startSmtpServer();
  const suffix = `${Date.now()}-${test.info().project.name.replace(/\W/g, '')}`;
  const taxId = `T${Date.now().toString(36).toUpperCase()}`;
  try {
    await page.goto('/registro');
    await expect(page.getByText('14 días sin tarjeta')).toBeVisible();
    await page.getByLabel('Empresa').fill(`Empresa SaaS ${suffix}`);
    await page.getByLabel('NIF/CIF').fill(taxId);
    await page.getByLabel('Personas en plantilla').fill('4');
    await page.getByLabel('Tu nombre').fill('Responsable SaaS');
    await page.getByLabel('Correo de administración').fill(`saas-${suffix}@example.com`);
    const message = smtp.message();
    await page.getByRole('button', { name: 'Empezar prueba' }).click();
    await expect(page.getByRole('heading', { name: 'Revisa tu correo' })).toBeVisible();
    await expect(page.getByText('La prueba de 14 días empieza')).toBeVisible();
    await expect(message).resolves.toContain('/invitacion/');
  } finally {
    await smtp.close();
  }
});
