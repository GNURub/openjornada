import { expect, test, type APIRequestContext } from '@playwright/test';
import { createServer, type Server, type Socket } from 'node:net';
import { acknowledgePrivacyNotice } from './helpers/privacy';

const apiBase = 'http://127.0.0.1:8090/api';

async function signIn(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    try {
      await expect(page).toHaveURL(/\/$/, { timeout: 2_500 });
      await acknowledgePrivacyNotice(page);
      return;
    } catch {
      if (attempt === 2) throw new Error(`No se pudo iniciar sesión como ${email}`);
      await page.waitForTimeout(3_200);
    }
  }
}

async function authenticate(
  request: APIRequestContext,
  identity: string,
  password: string,
): Promise<{ token: string }> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await request.post(`${apiBase}/collections/users/auth-with-password`, {
      data: { identity, password },
    });
    if (response.ok()) return (await response.json()) as { token: string };
    const body = await response.text();
    if (attempt === 3 || response.status() !== 429) {
      throw new Error(`No se pudo autenticar ${identity}: ${response.status()} ${body}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_200));
  }
  throw new Error(`No se pudo autenticar ${identity}`);
}

async function startSmtpServer(): Promise<{
  nextMessage: () => Promise<string>;
  close: () => Promise<void>;
}> {
  const messages: string[] = [];
  const waiters: Array<(message: string) => void> = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.write('220 openjornada-e2e ESMTP\r\n');
    let buffer = '';
    let collecting = false;
    let dataLines: string[] = [];

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);

        if (collecting) {
          if (line === '.') {
            const message = dataLines.join('\n');
            dataLines = [];
            collecting = false;
            const waiter = waiters.shift();
            if (waiter) waiter(message);
            else messages.push(message);
            socket.write('250 2.0.0 accepted\r\n');
          } else {
            dataLines.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }

        if (/^(EHLO|HELO)\b/i.test(line)) {
          socket.write('250-openjornada-e2e\r\n250 PIPELINING\r\n');
        } else if (/^(MAIL FROM|RCPT TO)\b/i.test(line)) {
          socket.write('250 2.1.0 ok\r\n');
        } else if (/^DATA\b/i.test(line)) {
          collecting = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (/^QUIT\b/i.test(line)) {
          socket.end('221 2.0.0 bye\r\n');
        } else if (line) {
          socket.write('250 ok\r\n');
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(1026, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    nextMessage: () =>
      new Promise<string>((resolve, reject) => {
        const message = messages.shift();
        if (message) {
          resolve(message);
          return;
        }
        const timeout = setTimeout(
          () => reject(new Error('No se recibió el correo de invitación.')),
          10_000,
        );
        waiters.push((value) => {
          clearTimeout(timeout);
          resolve(value);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

test('an invitation expires in 72 hours, sets the password and signs the employee in', async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución cubre el ciclo del correo; el shell responsive se prueba por separado.',
  );

  const smtp = await startSmtpServer();
  let smtpOpen = true;
  const email = `invitada-${Date.now().toString(36)}@example.com`;
  const initialPassword = 'TemporaryPassword123!';
  const acceptedPassword = 'AcceptedPassword123!';

  try {
    await signIn(page, 'admin@example.com', 'TestPassword123!');
    await page.goto('/equipo');
    await page.getByRole('button', { name: 'Añadir persona' }).click();
    await page.getByLabel('Nombre completo').fill('Empleada invitada');
    await page.getByLabel('Correo').fill(email);
    await page.getByLabel('Código de empleada').fill(`INV-${Date.now().toString(36)}`);
    await page.getByLabel('Contraseña temporal').fill(initialPassword);
    await page.getByRole('button', { name: 'Crear acceso' }).click();
    await expect(page.getByText('Persona añadida.')).toBeVisible();

    const row = page.locator(`[data-member-email="${email}"]`);
    await expect(row.getByText('Sin invitación')).toBeVisible();
    const emailPromise = smtp.nextMessage();
    const invitationResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/openjornada/team/') &&
        response.url().endsWith('/invitation'),
    );
    await row.getByRole('button', { name: 'Enviar invitación a Empleada invitada' }).click();
    const invitationResponse = await invitationResponsePromise;
    const invitationBody = await invitationResponse.text();
    expect(invitationResponse.status(), invitationBody).toBe(201);
    const invitationResult = JSON.parse(invitationBody) as { userId: string };
    await expect(page.getByRole('status')).toContainText(`Invitación enviada a ${email}`);
    await expect(row.getByText('Invitación pendiente')).toBeVisible();

    const rawMessage = await emailPromise;
    const decodedMessage = rawMessage
      .replace(/=\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    const link = decodedMessage.match(
      /http:\/\/127\.0\.0\.1:4217\/invitacion\/[A-Za-z0-9]{64}/,
    )?.[0];
    expect(link).toBeTruthy();

    const adminToken = (
      await authenticate(request, 'admin@example.com', 'TestPassword123!')
    ).token;
    const memberResponse = await request.get(
      `${apiBase}/collections/users/records/${invitationResult.userId}`,
      {
        headers: { Authorization: adminToken },
        params: {
          fields: 'id,invitationSentAt,invitationExpiresAt',
        },
      },
    );
    expect(memberResponse.ok(), await memberResponse.text()).toBeTruthy();
    const member = (await memberResponse.json()) as {
      id: string;
      invitationSentAt: string;
      invitationExpiresAt: string;
    };
    expect(
      new Date(member.invitationExpiresAt).getTime() - new Date(member.invitationSentAt).getTime(),
    ).toBe(72 * 60 * 60 * 1000);

    await page.goto(link!);
    await expect(page.getByRole('heading', { name: 'Hola, Empleada invitada' })).toBeVisible();
    await page.getByLabel('Nueva contraseña').fill(acceptedPassword);
    await page.getByLabel('Repite la contraseña').fill(acceptedPassword);
    await page.getByRole('button', { name: 'Crear contraseña y entrar' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('Empleada invitada').first()).toBeVisible();
    await acknowledgePrivacyNotice(page);

    const token = link!.split('/').at(-1);
    const reused = await request.get(`${apiBase}/openjornada/invitations/${token}`);
    expect(reused.status()).toBe(400);

    await page.getByRole('complementary').getByRole('button', { name: 'Cerrar sesión' }).click();
    await signIn(page, 'admin@example.com', 'TestPassword123!');
    await page.goto('/equipo');
    const acceptedRow = page.locator(`[data-member-email="${email}"]`);
    await expect(acceptedRow.getByText('Invitación aceptada')).toBeVisible();

    await smtp.close();
    smtpOpen = false;
    await acceptedRow
      .getByRole('button', { name: 'Reenviar invitación a Empleada invitada' })
      .click();
    await expect(page.getByRole('alert')).toContainText('No se pudo enviar la invitación');
    await expect(acceptedRow.getByText('Invitación aceptada')).toBeVisible();
  } finally {
    if (smtpOpen) await smtp.close();
  }
});
