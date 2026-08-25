import { createServer, type Socket } from 'node:net';

export interface SmtpTestServer {
  message: () => Promise<string>;
  close: () => Promise<void>;
}

interface MessageWaiter {
  resolve: (message: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export async function startSmtpServer(): Promise<SmtpTestServer> {
  const messages: string[] = [];
  const waiters: MessageWaiter[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.write('220 openjornada-e2e ESMTP\r\n');
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
            const message = lines.join('\n');
            lines = [];
            const waiter = waiters.shift();
            if (waiter) {
              clearTimeout(waiter.timeout);
              waiter.resolve(message);
            } else messages.push(message);
            socket.write('250 accepted\r\n');
          } else lines.push(line);
        } else if (/^(EHLO|HELO)\b/i.test(line)) socket.write('250 openjornada-e2e\r\n');
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
    message: () => {
      const queued = messages.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<string>((resolve, reject) => {
        const waiter: MessageWaiter = {
          resolve,
          reject,
          timeout: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error('No se recibió el correo esperado.'));
          }, 10_000),
        };
        waiters.push(waiter);
      });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timeout);
          waiter.reject(new Error('El servidor SMTP se cerró antes de recibir el correo.'));
        }
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function otpFromMessage(message: string): string {
  const match = message.match(/\b(\d{8})\b/);
  if (!match) throw new Error('El correo no contiene un OTP de ocho dígitos.');
  return match[1];
}
