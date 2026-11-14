'use strict';

/**
 * QA-скриншоты страницы через CDP (без внешних зависимостей).
 * node shot.js <outDir> <width> <height> <name1:selector1> ...
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = 'file:///C:/Users/artem/OneDrive/Desktop/generated-images/index.html';
const PORT = 9333;
const PROFILE = path.join(process.env.TEMP, 'orb-edge-cdp');

const outDir = process.argv[2] || path.join(process.env.TEMP, 'orb-shots');
const width = Number(process.argv[3] || 1440);
const height = Number(process.argv[4] || 1000);
const targets = process.argv.slice(5).map((arg) => {
  const [name, sel] = arg.split(':');
  return { name, sel };
});

fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${width},${height}`,
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let version;
  for (let i = 0; i < 60; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error('Edge DevTools не поднялся');

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('Нет вкладки');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WS error'));
  });

  let seq = 0;
  const pending = new Map();
  const eventWaiters = new Map();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const waiters = eventWaiters.get(msg.method) || [];
      waiters.splice(0).forEach((resolve) => resolve(msg.params));
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const once = (method) =>
    new Promise((resolve) => {
      const list = eventWaiters.get(method) || [];
      list.push(resolve);
      eventWaiters.set(method, list);
    });

  await send('Page.enable');
  await send('Runtime.enable');

  if (width < 900) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: true,
    });
  }

  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url: URL });
  await loaded;
  await sleep(700);

  // Принудительно показываем все reveal-блоки, грузим все картинки, стопорим анимации.
  await send('Runtime.evaluate', {
    expression: `(async () => {
      document.documentElement.style.scrollBehavior = 'auto';
      document.querySelectorAll('.reveal').forEach((el) => el.classList.add('is-in'));
      document.querySelectorAll('.marquee__track').forEach((el) => { el.style.animation = 'none'; });
      document.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = 'eager'; });
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 500));
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 500));
      return true;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  for (let i = 0; i < 40; i++) {
    const { result } = await send('Runtime.evaluate', {
      expression: `Array.from(document.images).filter((img) => !img.complete || !img.naturalWidth).length`,
      returnByValue: true,
    });
    if (result.value === 0) break;
    await sleep(250);
  }

  const results = [];

  for (const target of targets) {
    const { result } = await send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(target.sel)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, r.left + window.scrollX), y: Math.max(0, r.top + window.scrollY), width: r.width, height: r.height };
      })()`,
      returnByValue: true,
    });

    if (!result.value) {
      console.log(`skip ${target.name}: selector not found`);
      continue;
    }

    const { x, y, width: w, height: h } = result.value;
    const clip = { x: Math.floor(x), y: Math.floor(y), width: Math.ceil(w), height: Math.ceil(h), scale: 1 };
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip,
    });
    const file = path.join(outDir, `${target.name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`${target.name}: ${clip.width}x${clip.height} → ${file}`);
    results.push({ name: target.name, file, clip });
  }

  ws.close();
  edge.kill();
  await sleep(300);
  return results;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
