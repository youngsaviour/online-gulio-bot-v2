require('dotenv').config();
const { default: makeWASocket, DisconnectReason, downloadMediaMessage, BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const http = require('http');
const admin = require('firebase-admin');

// ── Firebase Setup ─────────────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();
console.log('✅ Firebase initialized');

// ── Config ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const BOT_DOC = 'bot_session'; // Firestore document ID for session

// ── State ──────────────────────────────────────────────────────────────────
let currentQR = null;
let botConnected = false;

// ── Firestore Auth State (replaces useMultiFileAuthState) ──────────────────
async function useFirestoreAuthState() {
  const collection = db.collection('bot_auth');

  // Read a key from Firestore
  async function readData(key) {
    try {
      const doc = await collection.doc(key).get();
      if (!doc.exists) return null;
      const raw = doc.data()?.value;
      if (!raw) return null;
      return JSON.parse(raw, BufferJSON.reviver);
    } catch (e) {
      console.error(`Read error [${key}]:`, e.message);
      return null;
    }
  }

  // Write a key to Firestore
  async function writeData(key, value) {
    try {
      await collection.doc(key).set({
        value: JSON.stringify(value, BufferJSON.replacer),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error(`Write error [${key}]:`, e.message);
    }
  }

  // Delete a key from Firestore
  async function removeData(key) {
    try {
      await collection.doc(key).delete();
    } catch (e) {
      console.error(`Delete error [${key}]:`, e.message);
    }
  }

  // Load existing creds or create fresh ones
  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let val = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && val) {
              val = proto.Message.AppStateSyncKeyData.fromObject(val);
            }
            data[id] = val;
          }
          return data;
        },
        set: async (data) => {
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const val = data[category][id];
              if (val) {
                await writeData(`${category}-${id}`, val);
              } else {
                await removeData(`${category}-${id}`);
              }
            }
          }
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
  };
}

// ── HTTP Server (QR Page) ──────────────────────────────────────────────────
http.createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: botConnected ? 'connected' : 'waiting', qr: !!currentQR }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (botConnected) {
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Online Gulio Bot v3</title></head>
    <body style="font-family:Arial;text-align:center;padding:50px;background:#f5f5f5;">
    <h1 style="color:#E85D04">🏪 Online Gulio Bot v3</h1>
    <div style="background:#22C55E;color:white;padding:20px;border-radius:12px;font-size:22px;max-width:400px;margin:20px auto;">
      ✅ Bot Imeunganishwa!<br><small style="font-size:14px;opacity:.8;">Sellers wanaweza kutuma bidhaa sasa</small>
    </div>
    <p style="color:#666;font-size:13px;">Session imehifadhiwa kwenye Firestore — haitahitaji QR tena baada ya restart.</p>
    </body></html>`);
  } else if (currentQR) {
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Scan QR — Online Gulio Bot</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <meta http-equiv="refresh" content="25">
    </head><body style="font-family:Arial;text-align:center;padding:30px;background:#fff;">
    <h1 style="color:#E85D04">🏪 Online Gulio Bot v3</h1>
    <h2>Scan QR Code — Mara Moja Tu!</h2>
    <p style="color:#666">WhatsApp → Linked Devices → Link a Device</p>
    <div id="qr" style="margin:20px auto;display:inline-block;padding:20px;border:3px solid #E85D04;border-radius:12px;"></div>
    <p style="color:#999;font-size:12px;">Baada ya scan moja, session itahifadhiwa. Haitahitajika tena! ✅</p>
    <p style="color:#999;font-size:12px;">Ukurasa unabadilika kila sekunde 25.</p>
    <script>new QRCode(document.getElementById("qr"),{text:${JSON.stringify(currentQR)},width:256,height:256});</script>
    </body></html>`);
  } else {
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Online Gulio Bot v3</title></head>
    <body style="font-family:Arial;text-align:center;padding:50px;">
    <h1 style="color:#E85D04">🏪 Online Gulio Bot v3</h1>
    <p>⏳ Inaanza... subiri sekunde chache.</p>
    </body></html>`);
  }
}).listen(PORT, () => {
  console.log(`✅ Server on port ${PORT}`);
});

// ── Find Seller by WhatsApp Number ─────────────────────────────────────────
async function findSellerByWA(phone) {
  try {
    const clean = phone.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
    // Try exact match first
    const snap = await db.collection('users').where('waNumber', '==', clean).limit(1).get();
    if (!snap.empty) {
      const user = snap.docs[0].data();
      console.log(`✅ Seller found (exact): ${user.name}`);
      return { uid: snap.docs[0].id, ...user };
    }
    // Try last 9 digits match — handles Baileys JID format variations
    const last9 = clean.slice(-9);
    const allUsers = await db.collection('users').get();
    for (const doc of allUsers.docs) {
      const wa = (doc.data().waNumber || '').replace(/[^0-9]/g, '');
      if (wa.slice(-9) === last9) {
        const user = doc.data();
        console.log(`✅ Seller found (last9 match): ${user.name} | stored: ${wa} | received: ${clean}`);
        return { uid: doc.id, ...user };
      }
    }
    console.log(`❌ No seller found for: ${clean} (last9: ${last9})`);
    return null;
  } catch (e) {
    console.error('findSeller error:', e.message);
    return null;
  }
}

// ── Save to Pending Queue ──────────────────────────────────────────────────
async function saveToPending(bizId, data) {
  const ref = await db.collection('pending_products').add({
    ...data,
    bizId,
    status: 'pending',
    receivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`✅ Saved to pending: ${ref.id}`);
  return ref.id;
}

// ── Save Image as Base64 ───────────────────────────────────────────────────
async function saveImageBuffer(buffer, mimeType) {
  const base64 = buffer.toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

// ── Send WhatsApp Message ──────────────────────────────────────────────────
async function sendMsg(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
  } catch (e) {
    console.error('Send error:', e.message);
  }
}

// ── Process Incoming Message ───────────────────────────────────────────────
async function processMessage(sock, msg, senderOverride) {
  const senderJID = senderOverride || msg.key.remoteJid;
  const messageType = Object.keys(msg.message || {})[0];

  let caption = '';
  let imageBuffer = null;
  let mimeType = 'image/jpeg';

  if (messageType === 'imageMessage') {
    caption = msg.message.imageMessage.caption || '';
    try {
      imageBuffer = await downloadMediaMessage(msg, 'buffer', {});
      mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
    } catch (e) {
      console.error('Image download error:', e.message);
    }
  } else if (messageType === 'conversation') {
    caption = msg.message.conversation || '';
  } else if (messageType === 'extendedTextMessage') {
    caption = msg.message.extendedTextMessage?.text || '';
  } else {
    return;
  }

  if (!imageBuffer && !caption.trim()) return;

  const seller = await findSellerByWA(senderJID);
  if (!seller) {
    await sendMsg(sock, senderJID,
      `👋 Habari!\n\nSimu yako haijasajiliwa kwenye Online Gulio.\n\nSajili kwanza kwenye:\n🔗 online-gulio.netlify.app\n\nNa uweke namba hii ya WhatsApp wakati wa usajili.`
    );
    return;
  }

  let imageUrl = '';
  if (imageBuffer) {
    try {
      imageUrl = await saveImageBuffer(imageBuffer, mimeType);
    } catch (e) {
      console.error('Image save error:', e.message);
    }
  }

  const priceMatch = caption.match(/(\d{3,7})/);
  const supplierPrice = priceMatch ? parseInt(priceMatch[1]) : 0;

  const pendingId = await saveToPending(seller.bizId, {
    imageUrl,
    caption: caption.trim(),
    name: caption.split('\n')[0].slice(0, 60) || 'Bidhaa',
    description: caption.trim(),
    supplierPrice,
    sellingPrice: 0,
    category: '',
    fromNumber: senderJID.replace('@s.whatsapp.net', ''),
    sellerName: seller.name,
  });

  await sendMsg(sock, senderJID,
    `✅ *Bidhaa imepokewa!*\n\n📦 "${caption.split('\n')[0].slice(0,40) || 'Bidhaa mpya'}"\n\nFungua app yako na uende kwenye tab ya *"Pending"* ili uihariri na kuipost.\n\n🔗 online-gulio.netlify.app`
  );
}

// ── Start Bot ──────────────────────────────────────────────────────────────
async function startBot() {
  console.log('🚀 Starting Online Gulio Bot v3...');
  console.log('📦 Using Firestore auth state — no disk needed');

  const { state, saveCreds } = await useFirestoreAuthState();

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Online Gulio', 'Chrome', '3.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      botConnected = false;
      console.log('📱 QR ready — open URL to scan');
    }
    if (connection === 'close') {
      botConnected = false;
      currentQR = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed (code: ${code}).`);
      
      // 401 = logged out (bad session) — clear auth and restart fresh
      if (code === 401 || code === 405) {
        console.log('⚠️  Session invalid — clearing auth and restarting...');
        try {
          const snap = await db.collection('bot_auth').get();
          for (const doc of snap.docs) await doc.ref.delete();
          console.log('🗑️  bot_auth cleared');
        } catch(e) { console.error('Clear error:', e.message); }
        setTimeout(startBot, 10000);
      }
      // 440 = logged out by WhatsApp (too many reconnects) — wait longer
      else if (code === 440) {
        console.log('⏳ WhatsApp kicked bot — waiting 60s before reconnect...');
        setTimeout(startBot, 60000);
      }
      // Other errors — reconnect after delay
      else if (code !== DisconnectReason.loggedOut) {
        const delay = code === 515 ? 3000 : 10000;
        console.log(`🔄 Reconnecting in ${delay/1000}s...`);
        setTimeout(startBot, delay);
      } else {
        console.log('⚠️  Logged out — clear bot_auth collection in Firestore and restart');
      }
    }
    if (connection === 'open') {
      botConnected = true;
      currentQR = null;
      console.log('✅ WhatsApp connected! Session saved to Firestore.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const senderJID = msg.key.remoteJid;
      if (!senderJID) continue;
      // Allow both DM (@s.whatsapp.net) and group (@g.us) messages
      const isGroup = senderJID.includes('@g.us');
      // For group messages, get the actual sender (not the group JID)
      const actualSender = isGroup 
        ? (msg.key.participant || msg.message?.participant || senderJID)
        : senderJID;
      console.log(`📨 Message from: ${senderJID}`);
      try {
        await processMessage(sock, msg);
      } catch (e) {
        console.error('Process error:', e.message);
      }
    }
  });
}


// ── Self-Ping (prevent Render spin down) ──────────────────────────────────
const https = require('https');
function selfPing() {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  try {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url + '/health', (res) => {
      console.log(`🏓 Self-ping: ${res.statusCode}`);
    }).on('error', () => {});
  } catch(e) {}
}
// Ping every 4 minutes
setInterval(selfPing, 4 * 60 * 1000);

startBot().catch(console.error);
process.on('uncaughtException', err => console.error('Error:', err.message));
process.on('unhandledRejection', reason => console.error('Rejection:', reason));
