// WhatsApp client — same system as the "Whatsapp Auto Replay" project:
// whatsapp-web.js + LocalAuth session + QR code + exponential-backoff reconnect.
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

let client = null;
let qrCodeData = null;
let status = 'DISCONNECTED';
let userInfo = null;
let reconnectAttempts = 0;
let manualDisconnect = false;
let initInProgress = false;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 5;

// whatsapp-web.js can throw unhandled rejections while wiping a logged-out
// profile (EBUSY on the browser lockfile). Log them instead of crashing.
process.on('unhandledRejection', (err) => {
  console.error('[Process] Unhandled rejection (kept alive):', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception (kept alive):', err && err.message ? err.message : err);
});

const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');

const cleanStaleCache = () => {
  const cacheDir = path.join(__dirname, '.wwebjs_cache');
  try {
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.log('[Session] Cleaned stale cache');
    }
  } catch (e) {
    console.error('[Session] Could not clean cache:', e.message);
  }
};

const initializeWhatsApp = () => {
  if (initInProgress) {
    console.log('[WhatsApp] Initialization already in progress, skipping...');
    return;
  }
  if (status === 'INITIALIZING' || status === 'QR_READY' || status === 'CONNECTED') {
    console.log('[WhatsApp] Already initializing/connected, skipping...');
    return;
  }

  initInProgress = true;
  cleanStaleCache();
  manualDisconnect = false;
  status = 'INITIALIZING';
  console.log('[WhatsApp] Initializing client...');

  const puppeteerConfig = {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-extensions'
    ],
    headless: true,
    defaultViewport: {
      width: 1280,
      height: 720
    }
  };

  // Use system Chrome if specified, otherwise let whatsapp-web.js use bundled Chromium
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const currentClient = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: puppeteerConfig
  });

  client = currentClient;

  currentClient.on('qr', async (qr) => {
    status = 'QR_READY';
    reconnectAttempts = 0;
    try {
      qrCodeData = await qrcode.toDataURL(qr);
      console.log('[WhatsApp] QR Code generated');
    } catch (err) {
      console.error('[WhatsApp] QR error:', err.message);
    }
  });

  currentClient.on('ready', () => {
    status = 'CONNECTED';
    qrCodeData = null;
    userInfo = currentClient.info;
    reconnectAttempts = 0;
    console.log('[WhatsApp] Connected as:', userInfo?.pushname || 'Unknown');
  });

  currentClient.on('authenticated', () => {
    console.log('[WhatsApp] Authenticated');
  });

  currentClient.on('auth_failure', (msg) => {
    console.error('[WhatsApp] Auth failed:', msg);
    status = 'ERROR';
    if (client === currentClient) client = null;
  });

  currentClient.on('disconnected', (reason) => {
    console.log('[WhatsApp] Disconnected:', reason);
    if (client === currentClient) {
      status = 'DISCONNECTED';
      qrCodeData = null;
      userInfo = null;
      client = null;

      if (manualDisconnect) return; // admin pressed Disconnect — stay off until they Connect again

      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 30000);
        reconnectAttempts++;
        console.log(`[WhatsApp] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(async () => {
          reconnectTimer = null;
          // Make sure the old browser is fully gone before restarting
          try { if (currentClient) await currentClient.destroy(); } catch (e) { /* already dead */ }
          if (status === 'DISCONNECTED' && !client) initializeWhatsApp();
        }, delay);
      } else {
        console.log('[WhatsApp] Max reconnect attempts reached — click Connect in the admin panel to retry with a fresh QR code.');
        reconnectAttempts = 0;
      }
    }
  });

  currentClient.on('error', (err) => {
    console.error('[WhatsApp] Error:', err.message);
    if (client === currentClient) { status = 'ERROR'; client = null; }
  });

  const initTimeout = setTimeout(() => {
    initInProgress = false;
    if (status === 'INITIALIZING') {
      console.error('[WhatsApp] Init timeout');
      status = 'ERROR';
      if (client === currentClient) client = null;
    }
  }, 60000);

  currentClient.initialize()
    .then(() => { clearTimeout(initTimeout); initInProgress = false; })
    .catch(err => {
      clearTimeout(initTimeout);
      initInProgress = false;
      console.error('[WhatsApp] Init failed:', err.message || err);
      if (client === currentClient) { status = 'ERROR'; client = null; }
      try { currentClient.destroy().catch(() => { }); } catch (e) { /* ignore */ }
    });
};

const getStatus = () => ({
  status,
  qrCodeData,
  userInfo: userInfo
    ? { pushname: userInfo.pushname || null, phone: (userInfo.wid && userInfo.wid.user) || null }
    : null
});

/**
 * Send a message to a WhatsApp number
 * @param {string} phoneNumber - phone number with country code
 * @param {string} message
 * @returns {Promise<{success: boolean, error?: string}>}
 */
const sendMessage = async (phoneNumber, message) => {
  if (!client || status !== 'CONNECTED') {
    return { success: false, error: 'WhatsApp is not connected' };
  }

  try {
    const formattedNumber = String(phoneNumber).replace(/[^0-9]/g, '');

    if (formattedNumber.length < 10) {
      return { success: false, error: 'Phone number must include country code (e.g., 91XXXXXXXXXX for India)' };
    }

    const chatId = formattedNumber + '@c.us';

    const isRegistered = await client.isRegisteredUser(chatId);
    if (!isRegistered) {
      return { success: false, error: 'This phone number is not registered on WhatsApp' };
    }

    await client.sendMessage(chatId, message);
    console.log(`[SendMessage] Message sent to ${formattedNumber}`);
    return { success: true };
  } catch (error) {
    console.error('[SendMessage] Error:', error.message);
    return { success: false, error: error.message };
  }
};

const logoutWhatsApp = async () => {
  manualDisconnect = true;
  initInProgress = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const clientToDestroy = client;
  client = null;
  status = 'DISCONNECTED';
  qrCodeData = null;
  userInfo = null;
  reconnectAttempts = 0;

  if (clientToDestroy) {
    try { await clientToDestroy.destroy(); } catch (e) { /* already destroyed */ }
  }

  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true, maxRetries: 4 });
      console.log('[Disconnect] Session cleared');
    }
  } catch (e) {
    console.error('[Disconnect] Session cleanup error:', e.message);
  }

  console.log('[Disconnect] Disconnected. Click Connect to re-link.');
};

module.exports = { initializeWhatsApp, getStatus, logoutWhatsApp, sendMessage };
