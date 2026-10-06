// CRISP AND CLOUD — Express server
// Serves the storefront + admin panel and drives WhatsApp order notifications.
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeWhatsApp, getStatus, logoutWhatsApp, sendMessage, clearSession } = require('./whatsappClient');
const { startOrderWatcher, markOrderNotified, startOrderCleanup } = require('./orderWatcher');

const app = express();
const PORT = process.env.PORT || 5000;

// The number that receives every new-order WhatsApp message
const OWNER_NUMBER = process.env.OWNER_NUMBER || '919058767686';

// Middlewares
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── WhatsApp API (same surface as the auto-reply project) ───
app.get('/api/whatsapp/status', (req, res) => {
  res.json(getStatus());
});

app.post('/api/whatsapp/connect', (req, res) => {
  initializeWhatsApp();
  res.json({ success: true, ...getStatus() });
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  await logoutWhatsApp();
  res.json({ success: true, ...getStatus() });
});

// Test message to the owner number
app.post('/api/whatsapp/test', async (req, res) => {
  const msg = '✅ *CRISP AND CLOUD*\nYour WhatsApp connection is working! New order alerts will arrive here.';
  const result = await sendMessage(OWNER_NUMBER, msg);
  res.status(result.success ? 200 : 400).json(result);
});

// ─── Order → WhatsApp notification ───
// Builds a professional, formatted order message (with Google Maps link)
// and sends it from the connected WhatsApp number to OWNER_NUMBER.
const buildOrderMessage = (order) => {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemLines = items.map((it, i) => {
    const qty = it.qty || 1;
    const lineTotal = (it.price || 0) * qty;
    return `*${i + 1}. ${it.name || 'Item'}* x${qty}\n     ₹${lineTotal}`;
  }).join('\n');

  let mapUrl = '';
  if (order.lat && order.lng && !(order.lat === 0 && order.lng === 0)) {
    mapUrl = `https://www.google.com/maps?q=${order.lat},${order.lng}`;
  } else if (order.address) {
    mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.address)}`;
  }

  const orderId = order.id || 'N/A';
  const customer = order.userName || 'Customer';
  const phone = order.userPhone && order.userPhone !== 'N/A' ? order.userPhone : 'Not provided';
  const address = order.address || 'Not provided';
  const payment = order.paymentMethod === 'cod' ? '💵 Cash on Delivery' : (order.paymentMethod || 'N/A');
  const deliveryCharge = order.deliveryCharge || 0;
  const subtotal = order.subtotal || 0;
  const total = order.total || 0;
  const placedAt = order.createdAt
    ? new Date(order.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
    : new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

  return [
    '🔔 *NEW ORDER ALERT*',
    '🍽️ *CRISP AND CLOUD*',
    '━━━━━━━━━━━━━━━━━━',
    `🧾 *Order ID:* ${orderId}`,
    `📅 *Placed:* ${placedAt}`,
    '━━━━━━━━━━━━━━━━━━',
    '👤 *Customer Details*',
    `   Name: ${customer}`,
    `   Phone: ${phone}`,
    '━━━━━━━━━━━━━━━━━━',
    '🛒 *Order Items*',
    itemLines || '   (no items)',
    '━━━━━━━━━━━━━━━━━━',
    `💰 Subtotal: ₹${subtotal}`,
    `🚚 Delivery Charge: ${deliveryCharge > 0 ? '₹' + deliveryCharge : 'FREE'}`,
    `*💎 TOTAL: ₹${total}*`,
    `💳 Payment: ${payment}`,
    '━━━━━━━━━━━━━━━━━━',
    '📍 *Delivery Address*',
    `   ${address}`,
    mapUrl ? `\n🗺️ *Google Map Location:*\n${mapUrl}` : '',
    '━━━━━━━━━━━━━━━━━━',
    '⚡ *Please confirm this order ASAP!*'
  ].filter(Boolean).join('\n');
};

// ─── Order → WhatsApp notification ───
// Shared by the HTTP route (admin panel) and the server-side Firestore watcher.
// Dedup map prevents the same order being sent twice when both fire.
const sentOrders = new Map(); // orderId -> timestamp
const ORDER_DEDUP_MS = 10 * 60 * 1000; // forget after 10 minutes

const notifyOrder = async (order) => {
  const orderId = order.id || null;
  if (orderId && sentOrders.has(orderId)) {
    console.log(`[OrderNotify] Skipping ${orderId} — already sent`);
    return { success: true, skipped: true };
  }
  // Mark BEFORE sending so concurrent callers (watcher + admin panel) dedup properly
  if (orderId) sentOrders.set(orderId, Date.now());
  const message = buildOrderMessage(order);
  const result = await sendMessage(OWNER_NUMBER, message);
  if (!result.success && orderId) {
    sentOrders.delete(orderId); // allow a later retry on failure
  }
  if (result.success && orderId) {
    // prune old entries
    const cutoff = Date.now() - ORDER_DEDUP_MS;
    for (const [k, t] of sentOrders) if (t < cutoff) sentOrders.delete(k);
    // SUCCESS → move order out of the admin panel (status: pending → ordered).
    // On failure we deliberately do nothing: order stays in the admin panel as-is.
    const flipped = await markOrderNotified(orderId);
    console.log(`[OrderNotify] ${orderId} -> SENT${flipped ? ' (moved out of admin panel)' : ''}`);
    return { ...result, statusFlipped: flipped };
  }
  console.log(`[OrderNotify] ${orderId || '(no id)'} -> FAILED: ${result.error} (order stays in admin panel)`);
  return result;
};

app.post('/api/orders/notify', async (req, res) => {
  try {
    const order = req.body || {};
    if (!order.items && !order.total) {
      return res.status(400).json({ success: false, error: 'Invalid order payload' });
    }
    const result = await notifyOrder(order);
    res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    console.error('[OrderNotify] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Static frontend (served LAST so it can't shadow the API) ───
// Block sensitive files from being served.
app.use((req, res, next) => {
  const blocked = [
    /^\/server\.js$/,
    /^\/whatsappClient\.js$/,
    /^\/orderWatcher\.js$/,
    /^\/package\.json$/,
    /^\/package-lock\.json$/,
    /^\/node_modules(\/|$)/,
    /^\/\.wwebjs_auth(\/|$)/,
    /^\/\.wwebjs_cache(\/|$)/,
    /^\/server\.log$/
  ];
  if (blocked.some(re => re.test(req.path))) return res.status(404).end();
  next();
});

app.use(express.static(path.join(__dirname)));

// Only start listening when run directly (`node server.js`), not when required by tests
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`CRISP AND CLOUD server running on port ${PORT}`);

    // Fresh QR on every server start: clear any login left from a previous
    // run (even an unclean shutdown), then bring up WhatsApp for a new scan.
    setTimeout(() => {
      clearSession();
      initializeWhatsApp();
    }, 1000);

    // Server-side order watcher: notify even when the admin panel is closed
    setTimeout(() => {
      try {
        startOrderWatcher(notifyOrder);
      } catch (e) {
        console.error('[OrderWatcher] Failed to start:', e.message);
      }
    }, 2000);

    // Delete orders fully once their placed date is over (date change → purged)
    setTimeout(() => {
      try {
        startOrderCleanup();
      } catch (e) {
        console.error('[Cleanup] Failed to start:', e.message);
      }
    }, 3000);
  });

  // Graceful shutdown — close WhatsApp client before exit
  const gracefulShutdown = async (signal) => {
    console.log(`${signal} received. Shutting down gracefully...`);
    try {
      await logoutWhatsApp();
    } catch (e) {
      console.error('Error during WhatsApp logout:', e.message);
    }
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Forcing shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

// Exported for tests
module.exports = { app, buildOrderMessage, notifyOrder };
