'use strict'

const path = require('path')
const fs = require('fs')
const http = require('http')
const express = require('express')
const { Server } = require('socket.io')
const pino = require('pino')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000
// WhatsApp session files yahan save hote hain (Render pe redeploy karne par
// wipe ho jata hai -> dobara QR scan karna padta hai)
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, '.wa-auth')
// Food menu project (ek folder upar) + WhatsApp connect page
const FOOD_DIR = path.join(__dirname, '..')
const FOOD_PAGE = path.join(FOOD_DIR, 'index.html')
const WA_PAGE = path.join(__dirname, 'index.html')
// Optional security PIN: agar set ho to API/socket ko PIN chahiye hoga
const ACCESS_PIN = process.env.ACCESS_PIN || ''

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: true } })

app.use(express.json({ limit: '20kb' }))

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const wa = { status: 'disconnected', qr: null, user: null }
// status: 'connecting' | 'qr' | 'connected' | 'disconnected'
let sock = null
let intentionalClose = false
let restartTimer = null

const snapshot = () => ({
  status: wa.status,
  qr: wa.qr,
  user: wa.user,
  pinRequired: Boolean(ACCESS_PIN),
})

const push = () => io.emit('state', snapshot())

function pinOk(pin) {
  if (!ACCESS_PIN) return true
  return String(pin || '') === ACCESS_PIN
}

function apiGuard(req, res, next) {
  const pin = req.headers['x-pin'] || req.query.pin
  if (pinOk(pin)) return next()
  res.status(401).json({ ok: false, error: 'PIN galat hai. Sahi PIN daaliye.' })
}

// ---------------------------------------------------------------------------
// Baileys socket
// ---------------------------------------------------------------------------
async function startWa() {
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (sock) {
    const old = sock
    sock = null
    intentionalClose = true
    try { old.end(undefined) } catch (_) {}
    intentionalClose = false
  }

  wa.status = 'connecting'
  wa.qr = null
  wa.user = null
  push()

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  let version
  try { ({ version } = await fetchLatestBaileysVersion()) } catch (_) {}

  const opts = {
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['WhatsApp Link System', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  }
  if (version) opts.version = version

  const s = makeWASocket(opts)
  sock = s

  // Purane socket ke events ignore ho jaate hain (session replace ho chuka hai)
  s.ev.on('creds.update', (c) => {
    if (sock !== s) return
    saveCreds(c).catch((e) => console.error('[wa] saveCreds', e && e.message))
  })

  s.ev.on('connection.update', (u) => {
    if (sock !== s) return
    handleUpdate(u)
  })
}

function handleUpdate(u) {
  const { connection, lastDisconnect, qr } = u

  if (qr) {
    wa.status = 'qr'
    wa.qr = qr
    push()
    console.log('[wa] QR mila - browser me scan karne ke liye ready')
  }

  if (connection === 'open') {
    wa.status = 'connected'
    wa.qr = null
    wa.user = {
      id: (sock.user && sock.user.id) || null,
      name: (sock.user && sock.user.name) || null,
    }
    push()
    console.log('[wa] connected ->', wa.user.id)
  }

  if (connection === 'close') {
    const err = lastDisconnect && lastDisconnect.error
    const code = err && err.output && err.output.statusCode
    const loggedOut = code === DisconnectReason.loggedOut
    console.log('[wa] connection closed, code=' + code + ' loggedOut=' + loggedOut)

    sock = null
    wa.status = 'disconnected'
    wa.qr = null
    wa.user = null
    push()

    if (intentionalClose) return

    // Logged out = session dead -> auth wipe karke fresh QR generate karo
    if (loggedOut) {
      try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }) } catch (_) {}
    }

    if (!restartTimer) {
      restartTimer = setTimeout(() => {
        restartTimer = null
        startWa().catch((e) => console.error('[wa] restart failed:', e && e.message))
      }, loggedOut ? 1500 : 4000)
    }
  }
}

// ---------------------------------------------------------------------------
// Pages: Food menu (root) + WhatsApp system (/whatsapp)
// ---------------------------------------------------------------------------
// Server ke internal files static serving se block karo
app.use((req, res, next) => {
  if (/^\/whatsapp\/(server\.js|package[^/]*\.json|node_modules)/.test(req.path)) {
    return res.status(404).end()
  }
  next()
})

// WhatsApp connect page (QR system)
app.get(['/whatsapp', '/whatsapp/'], (req, res) => res.sendFile(WA_PAGE))

// Food menu app (admin panel isi ke andar hai)
app.get(['/', '/index.html'], (req, res) => res.sendFile(FOOD_PAGE))

// Food menu ke assets (firebase-config.js, images, manifest, order.mp3...)
app.use(express.static(FOOD_DIR, { index: false }))

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

app.get('/api/status', apiGuard, (req, res) => {
  res.json(snapshot())
})

app.post('/api/connect', apiGuard, async (req, res) => {
  try {
    if (wa.status === 'connected' || wa.status === 'connecting' || wa.status === 'qr') {
      return res.json(snapshot())
    }
    await startWa()
    res.json(snapshot())
  } catch (e) {
    console.error('[api] connect error', e)
    res.status(500).json({ ok: false, error: String((e && e.message) || e) })
  }
})

app.post('/api/logout', apiGuard, async (req, res) => {
  const old = sock
  sock = null
  intentionalClose = true
  try { if (old) await old.logout() } catch (e) { console.error('[wa] logout', e && e.message) }
  try { if (old) old.end(undefined) } catch (_) {}
  intentionalClose = false

  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }) } catch (_) {}

  wa.status = 'disconnected'
  wa.qr = null
  wa.user = null
  push()

  try { await startWa() } catch (e) { console.error('[wa] restart after logout', e && e.message) }
  res.json(snapshot())
})

app.post('/api/send', apiGuard, async (req, res) => {
  try {
    const body = req.body || {}
    const text = String(body.message || '').trim()
    const raw = String(body.phone || '').trim()
    const cc = String(body.countryCode || '+91').replace(/\D/g, '')

    if (!text) return res.status(400).json({ ok: false, error: 'Message khaali hai.' })
    if (text.length > 4096) {
      return res.status(400).json({ ok: false, error: 'Message 4096 characters se chhota rakhiye.' })
    }

    const inputDigits = raw.replace(/\D/g, '')
    if (!inputDigits) return res.status(400).json({ ok: false, error: 'Phone number daaliye.' })

    // Agar "+" se shuru hua to wahi final number, warna country code prefix hoga
    const full = raw.startsWith('+') ? inputDigits : cc + inputDigits
    if (!/^\d{7,15}$/.test(full)) {
      return res.status(400).json({ ok: false, error: 'Number galat lag raha hai (7-15 digits hone chahiye).' })
    }

    if (!sock || wa.status !== 'connected') {
      return res.status(400).json({ ok: false, error: 'Pehle WhatsApp connect kariye (QR scan kariye).' })
    }

    const jid = full + '@s.whatsapp.net'

    // Number WhatsApp par hai ya nahi - check karo (best effort)
    try {
      const check = await sock.onWhatsApp(jid)
      if (Array.isArray(check) && check.length && check[0] && check[0].exists === false) {
        return res.status(404).json({ ok: false, error: '+' + full + ' WhatsApp par nahi hai.' })
      }
    } catch (_) { /* check fail ho to bhi send try karenge */ }

    const sent = await sock.sendMessage(jid, { text })
    const id = sent && sent.key && sent.key.id
    console.log('[wa] message sent -> +' + full + ' id=' + id)
    res.json({ ok: true, id: id || null, to: '+' + full })
  } catch (e) {
    console.error('[api] send error', e)
    res.status(500).json({ ok: false, error: 'Message nahi bheja: ' + String((e && e.message) || e) })
  }
})

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  const pin = socket.handshake.auth && socket.handshake.auth.pin
  if (!pinOk(pin)) {
    socket.emit('state', { denied: true, pinRequired: true })
    socket.disconnect(true)
    return
  }
  socket.emit('state', snapshot())
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e))
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e))

server.listen(PORT, () => {
  console.log('Server chal raha hai -> http://localhost:' + PORT)
  startWa().catch((e) => console.error('[wa] start failed:', e && e.message))
})
