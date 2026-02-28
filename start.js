const { spawn } = require('child_process');

const PORT = process.env.PORT || '3001';
const url = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ['server.js'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT,
  },
  shell: false,
});

let browserOpened = false;

function openChrome(targetUrl) {
  if (browserOpened) return;
  browserOpened = true;

  if (process.platform === 'win32') {
    const opener = spawn('cmd', ['/c', 'start', '', 'chrome', targetUrl], {
      detached: true,
      stdio: 'ignore',
    });
    opener.unref();
    return;
  }

  const openerCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const openerArgs = process.platform === 'darwin' ? ['-a', 'Google Chrome', targetUrl] : [targetUrl];
  const opener = spawn(openerCmd, openerArgs, {
    detached: true,
    stdio: 'ignore',
  });
  opener.unref();
}

server.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);

  if (!browserOpened && (text.includes('Server listening') || text.includes(url))) {
    openChrome(url);
  }
});

server.stderr.on('data', (chunk) => {
  process.stderr.write(chunk.toString());
});

server.on('exit', (code) => {
  process.exit(code ?? 0);
});

process.on('SIGINT', () => server.kill('SIGINT'));
process.on('SIGTERM', () => server.kill('SIGTERM'));
