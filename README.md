# 🔗 WhatsApp Link System

QR scan karke WhatsApp connect karo aur kisi bhi number pe message bhejo — **browser page (React CDN) + Node.js server (Baileys)** se bana hua full system. GitHub pe push karo aur Render pe deploy karo — link khulte hi pura system chalega.

## ✨ Features

- 📱 **QR Connect** — page pe QR generate hota hai, WhatsApp → Linked Devices → Link a Device se scan karo, connect ho jata hai (realtime, Socket.IO se refresh)
- ✅ **Connected hone ke baad 2 inputs** — Phone Number (country code default **+91 India**, 40+ countries dropdown) aur Message
- 📤 **Send button** — click karte hi tumhare WhatsApp session se entered number pe message chala jata hai (Baileys se)
- 🕐 **Activity Log** — har send ka result (SENT/FAIL + time) niche milta hai
- 🔒 **Optional ACCESS PIN** — env variable se page/API ko PIN se lock kar sakte ho
- 🔄 **Auto-reconnect** — connection drop hone par khud session restart hota hai

## 🛠️ Project structure

```
index.html      → React CDN wala pura frontend (QR + inputs + log)
server.js       → Express + Socket.IO + Baileys (WhatsApp Web) server
package.json    → dependencies + npm start script
render.yaml     → Render one-click blueprint config
.gitignore      → node_modules aur .wa-auth (session) ko git se ignore karta hai
```

## 💻 Local setup (testing ke liye)

```bash
npm install
npm start
```

Phir browser me kholo → **http://localhost:3000**

1. Page pe QR aayega (10-15 second lag sakte hain)
2. Phone me WhatsApp → Settings → Linked Devices → Link a Device → QR scan
3. Status 🟢 **Connected** dikhega → niche 2 inputs mil jayenge
4. Number (+91 default) aur message daalo → **Send on WhatsApp** dabao

## 🚀 GitHub + Render deploy

### Step 1: GitHub pe push karo

```bash
git init
git add .
git commit -m "WhatsApp Link System (React + Baileys)"
git branch -M main
git remote add origin https://github.com/<tumhara-username>/<repo-name>.git
git push -u origin main
```

> `.gitignore` me `node_modules/` aur `.wa-auth/` already included hain — session files kabhi git pe nahi jayengi.

### Step 2: Render pe deploy karo

1. [render.com](https://render.com) pe login → **New +** → **Web Service**
2. Apna GitHub repo **connect/select** karo
3. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. **Create Web Service** → deploy shuru (2-4 minute)
5. Deploy hone ke baad diya hua link (`https://<name>.onrender.com`) kholo → QR scan karo → **pura system working!**

> 💡 `render.yaml` repo me hai, isliye Render "Blueprint" se bhi auto-setup kar lega (New + → Blueprint → repo select).

### Step 3 (recommended): ACCESS PIN lagao

Bina PIN ke koi bhi tumhare link pe aakar tumhare WhatsApp session se message bhej sakta hai. Isliye Render pe:

**Environment → Add Environment Variable**

| Key | Value |
| --- | --- |
| `ACCESS_PIN` | koi bhi 4-6 digit pin (example: `9834`) |

Set karte hi page pe PIN lock aayega — sahi PIN dalte hi system waisa hi chalega.

## ⚠️ Important notes

- **Render free tier:** service 15 min idle ke baad sleep karti hai aur **redeploy/restart pe WhatsApp session wipe** hota hai — har baar naya QR scan karna padega. Session ko permanently rakhna hai to paid plan me **Disk** add karo (Mount path jaise `/data`) aur env variable lagao: `AUTH_DIR=/data/wa-auth`
- **First QR:** Render pe pehli baar QR aane me 10-20 second lag sakte hain (server cold start)
- **WhatsApp ToS:** ye system apne hi personal number ke liye hai. Spam/ bulk marketing ke liye use karna WhatsApp ban ka risk le sakta hai — apne hi known contacts ko message bhejiye
- **QR kisi ko mat dikhao:** jo is page ka QR scan karega, uska WhatsApp *tumhare* server se link ho jayega (aur ACCESS PIN na ho to koi tumhara session bhi use kar sakta hai)

## 🔌 API reference (developer ke liye)

| Method | Endpoint | Kaam |
| --- | --- | --- |
| GET | `/api/status` | current status + QR (`x-pin` header agar ACCESS_PIN set hai) |
| POST | `/api/connect` | session (re)start karo |
| POST | `/api/send` | body: `{ countryCode: "+91", phone: "9876543210", message: "hi" }` |
| POST | `/api/logout` | WhatsApp unlink + naya QR |
| WS | Socket.IO `state` event | realtime `{ status, qr, user }` |

Status values: `connecting` → `qr` → `connected` (ya `disconnected`).
