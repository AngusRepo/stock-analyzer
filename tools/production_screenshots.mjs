import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const token = process.env.STOCKVISION_AUTH_TOKEN || "";
const outDir = process.env.SCREENSHOT_DIR || "C:\\tmp\\stockvision-cpd-screenshots-auth";
const port = Number(process.env.CDP_PORT || 9409);
const userDataDir = join(tmpdir(), `stockvision-cpd-chrome-${Date.now()}`);

const pages = [
  ["pages-dashboard-auth", "https://stockvision-frontend.pages.dev/"],
  ["pages-model-pool-auth", "https://stockvision-frontend.pages.dev/model-pool"],
  ["pages-data-quality-auth", "https://stockvision-frontend.pages.dev/data-quality"],
  ["pages-observability-auth", "https://stockvision-frontend.pages.dev/obs"],
  ["cloudrun-health", "https://ml-controller-jnmn3apxvq-de.a.run.app/health"],
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

async function waitForChrome() {
  const url = `http://127.0.0.1:${port}/json/version`;
  for (let i = 0; i < 80; i += 1) {
    try {
      return await fetchJson(url);
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Chrome DevTools endpoint did not become ready");
}

class CdpClient {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ws = new WebSocket(wsUrl);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      if (message.method) this.events.push(message);
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  close() {
    this.ws.close();
  }
}

function authShimSource() {
  const serviceUser = {
    id: 0,
    email: "service@stockvision.local",
    name: "StockVision Service",
    role: "admin",
    approval_status: "approved",
  };
  return `
(() => {
  const token = ${JSON.stringify(token)};
  if (token) sessionStorage.setItem("sv_token", token);
  const serviceUser = ${JSON.stringify(serviceUser)};
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input && input.url;
    const url = String(raw || "");
    if (url.endsWith("/api/auth/me") || url.endsWith("/auth/me")) {
      return Promise.resolve(new Response(JSON.stringify(serviceUser), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    return originalFetch(input, init);
  };
})();
`;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-background-networking",
    "--disable-default-apps",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,1100",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    await waitForChrome();
    const tab = await fetchJson(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    const cdp = new CdpClient(tab.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: authShimSource() });

    const results = [];
    for (const [name, url] of pages) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 1100,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.send("Page.navigate", { url });
      await sleep(6500);
      const text = await cdp.send("Runtime.evaluate", {
        expression: "document.body ? document.body.innerText.slice(0, 1200) : ''",
        returnByValue: true,
      });
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const file = join(outDir, `${name}.png`);
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      const bodyText = text.result?.value || "";
      results.push({
        name,
        file,
        bytes: Buffer.byteLength(shot.data, "base64"),
        unauthorized: /Unauthorized|未授權|401/.test(bodyText),
        unexpectedError: /unexpected error|TypeError|ReferenceError/i.test(bodyText),
      });
    }

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.send("Page.navigate", { url: "https://stockvision-frontend.pages.dev/bot" });
    await sleep(6500);
    const mobileText = await cdp.send("Runtime.evaluate", {
      expression: "document.body ? document.body.innerText.slice(0, 1200) : ''",
      returnByValue: true,
    });
    const mobileShot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const mobileFile = join(outDir, "pages-bot-mobile-auth.png");
    writeFileSync(mobileFile, Buffer.from(mobileShot.data, "base64"));
    const mobileBody = mobileText.result?.value || "";
    results.push({
      name: "pages-bot-mobile-auth",
      file: mobileFile,
      bytes: Buffer.byteLength(mobileShot.data, "base64"),
      unauthorized: /Unauthorized|未授權|401/.test(mobileBody),
      unexpectedError: /unexpected error|TypeError|ReferenceError/i.test(mobileBody),
    });

    cdp.close();
    console.log(JSON.stringify(results, null, 2));
  } finally {
    chrome.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
