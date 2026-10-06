// Server-side Firestore watcher — detects NEW orders and notifies the owner.
// Works regardless of whether the admin panel is open (unlike the browser listener).
const { initializeApp, getApps, getApp } = require('firebase/app');
const { getFirestore, collection, onSnapshot, doc, getDoc, updateDoc, getDocs, deleteDoc } = require('firebase/firestore');

const firebaseConfig = {
  apiKey: 'AIzaSyBkJLcaQLIcCHJrKkDGh4nAhuGleyUpuNY',
  authDomain: 'food-menu-order-8a735.firebaseapp.com',
  projectId: 'food-menu-order-8a735',
  storageBucket: 'food-menu-order-8a735.firebasestorage.app',
  messagingSenderId: '281446715322',
  appId: '1:281446715322:web:0979efb6b52df07a975783'
};

// Single Firestore instance shared by the watcher and the status updater
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db = getFirestore(app);

/**
 * After a WhatsApp message is sent SUCCESSFULLY, move the order out of the
 * admin panel: status 'pending' -> 'ordered'.
 * The admin panel query is `status in ['pending','served','completed','rejected']`,
 * so 'ordered' orders disappear from it but still show in the user's My Orders.
 * If the message failed, status is left untouched and the order stays in the panel.
 * Only flips 'pending' — never overwrites an admin action (served/completed/rejected).
 * @returns {Promise<boolean>} whether the flip happened
 */
const markOrderNotified = async (orderId) => {
  try {
    const ref = doc(db, 'orders', orderId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      console.log(`[OrderNotify] Order ${orderId} not found — skip status flip`);
      return false;
    }
    const status = snap.data().status;
    if (status && status !== 'pending') {
      console.log(`[OrderNotify] Order ${orderId} status is '${status}' — not flipping`);
      return false;
    }
    await updateDoc(ref, { status: 'ordered' });
    console.log(`[OrderNotify] Order ${orderId} status -> ordered (removed from admin panel)`);
    return true;
  } catch (e) {
    console.error(`[OrderNotify] Status flip failed for ${orderId}:`, e.message);
    return false;
  }
};

// ─── Daily expiry cleanup ───
// An order is fully deleted from the database once the calendar date (IST)
// moves past the date it was placed on — i.e. orderDate < today (Asia/Kolkata).
const istDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);

const cleanupExpiredOrders = async () => {
  try {
    const todayIST = istDate(new Date());
    const snap = await getDocs(collection(db, 'orders'));
    const deletions = [];
    snap.forEach(d => {
      const c = d.data().createdAt;
      if (!c || typeof c.toDate !== 'function') return; // no timestamp → skip (never guess-delete)
      const orderDate = istDate(c.toDate());
      if (orderDate < todayIST) deletions.push({ id: d.id, orderDate });
    });
    if (!deletions.length) return;
    await Promise.all(deletions.map(x => deleteDoc(doc(db, 'orders', x.id))));
    console.log(`[Cleanup] Deleted ${deletions.length} expired order(s) placed before ${todayIST}: ${deletions.map(x => `${x.id}(${x.orderDate})`).join(', ')}`);
  } catch (e) {
    console.error('[Cleanup] Error:', e.message);
  }
};

/** Start the periodic expiry cleanup (runs immediately, then every intervalMs). */
const startOrderCleanup = (intervalMs = 60 * 1000) => {
  cleanupExpiredOrders();
  const timer = setInterval(cleanupExpiredOrders, intervalMs);
  console.log(`[Cleanup] Expiry cleanup active — deletes orders whose placed date < today (IST)`);
  return timer;
};

/**
 * Start watching the Firestore 'orders' collection.
 * @param {(order: object) => Promise<void>} notifyOrder - called once per new order
 *        with { id, ...orderData }. Must handle its own dedup/idempotency is done here too.
 */
const startOrderWatcher = (notifyOrder) => {
  const knownIds = new Set();
  let initialLoaded = false;

  onSnapshot(collection(db, 'orders'), (snap) => {
    // First snapshot = all existing orders. Register them so only genuinely
    // NEW orders (placed after server start) trigger a notification.
    if (!initialLoaded) {
      snap.forEach(doc => knownIds.add(doc.id));
      initialLoaded = true;
      console.log(`[OrderWatcher] Watching orders (tracking ${knownIds.size} existing orders)`);
      return;
    }

    snap.docChanges().forEach((change) => {
      if (change.type !== 'added') return;
      const id = change.doc.id;
      if (knownIds.has(id)) return;
      knownIds.add(id);
      const data = change.doc.data() || {};
      console.log(`[OrderWatcher] New order detected: ${id}`);
      const payload = { id, ...data };
      if (payload.createdAt && typeof payload.createdAt.toDate === 'function') {
        payload.createdAt = payload.createdAt.toDate().toISOString();
      }
      Promise.resolve(notifyOrder(payload)).catch(err => {
        console.error('[OrderWatcher] notify failed:', err && err.message ? err.message : err);
      });
    });
  }, (err) => {
    console.error('[OrderWatcher] Snapshot error:', err.message);
    // Retry with a fresh listener after 10s
    setTimeout(() => {
      console.log('[OrderWatcher] Restarting watcher...');
      startOrderWatcher(notifyOrder);
    }, 10000);
  });

  return { db };
};

module.exports = { startOrderWatcher, markOrderNotified, startOrderCleanup, cleanupExpiredOrders };
