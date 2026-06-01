require('dotenv').config();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
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
const AUTH_DIR = './auth_info';

// ── State ──────────────────────────────────────────────────────────────────
let currentQR = null;
let botConnected = false;

// ── HTTP Server (QR Page) ──────────────────────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (botConnected) {
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Online Gulio Bot v2</title></head>
    <body style="font-family:Arial;text-align:center;padding:50px;background:#f5f5f5;">
    <h1 style="color:#E85D04">🏪 Online Gulio Bot v2</h1>
    <div style="background:#22C55E;color:white;padding:20px;border-radius:12px;font-size:22px;max-width:400px;margin:20px auto;">
      ✅ Bot Imeunganishwa!<br><small style="font-size:14px;opacity:.8;">Sellers wanaweza kutuma bidhaa sasa</small>
    </div>
    </body></html>`);
  } else if (currentQR) {
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Scan QR</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <meta http-equiv="refresh" content="25">
    </head><body style="font-family:Arial;text-align:center;padding:30px;background:#fff;">
    <h1 style="color:#E85D04">🏪 Online Gulio Bot v2</h1>
    <h2>Scan QR Code</h2>
    <p style="color:#666">WhatsApp → Linked Devices → Link a Device</p>
    <div id="qr" style="margin:20px auto;display:inline-block;padding:20px;border:3px solid #E85D04;border-radius:12px;"></div>
    <p style="color:#999;font-size:12px">Ukurasa unabadilika kila sekunde 25. QR inaisha baada ya dakika 1.</p>
    <script>new QRCode(document.getElementById("qr"),{text:${JSON.stringify(currentQR)},width:256,height:256});</script>
    </body></html>`);
  } else {
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Online Gulio Bot v2</title></head>
    <body style="font-family:Arial;text-align:center;padding:50px;">
    <h1 style="color:#E85D04">🏪 Online Gulio Bot v2</h1>
    <p>⏳ Inaanza... subiri sekunde chache.</p>
    </body></html>`);
  }
}).listen(PORT, () => {
  console.log(`✅ Server on port ${PORT}`);
  console.log(`🔗 QR: https://online-gulio-bot.onrender.com`);
});

// ── Find Seller by WhatsApp Number ─────────────────────────────────────────
async function findSellerByWA(phone) {
  try {
    // Clean phone number — remove @s.whatsapp.net and +
    const clean = phone.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');

    // Search users collection for matching waNumber
    const snap = await db.collection('users')
      .where('waNumber', '==', clean)
      .limit(1)
      .get();

    if (!snap.empty) {
      const user = snap.docs[0].data();
      console.log(`✅ Seller found: ${user.name} (bizId: ${user.bizId})`);
      return { uid: snap.docs[0].id, ...user };
    }

    // Try with different format (0712... vs 255712...)
    const altClean = clean.startsWith('255') ? '0' + clean.slice(3) : '255' + clean.slice(1);
    const snap2 = await db.collection('users')
      .where('waNumber', '==', altClean)
      .limit(1)
      .get();

    if (!snap2.empty) {
      const user = snap2.docs[0].data();
      console.log(`✅ Seller found (alt): ${user.name}`);
      return { uid: snap2.docs[0].id, ...user };
    }

    console.log(`❌ No seller found for: ${clean}`);
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

// ── Upload Image to Firebase Storage (base64 as data URL) ──────────────────
async function saveImageBuffer(buffer, mimeType) {
  // Save as base64 data URL — stored directly in Firestore
  // For production, use Firebase Storage
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
async function processMessage(sock, msg) {
  const senderJID = msg.key.remoteJid;
  const messageType = Object.keys(msg.message || {})[0];

  // Extract content
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
    // Unsupported type — ignore silently
    return;
  }

  // Must have content
  if (!imageBuffer && !caption.trim()) return;

  // Find seller
  const seller = await findSellerByWA(senderJID);

  if (!seller) {
    // Unknown number — send info
    await sendMsg(sock, senderJID,
      `👋 Habari!\n\nSimu yako haijasajiliwa kwenye Online Gulio.\n\nSajili kwanza kwenye:\n🔗 online-gulio.netlify.app\n\nNa uweke namba hii ya WhatsApp wakati wa usajili.`
    );
    return;
  }

  // Save image
  let imageUrl = '';
  if (imageBuffer) {
    try {
      imageUrl = await saveImageBuffer(imageBuffer, mimeType);
    } catch (e) {
      console.error('Image save error:', e.message);
    }
  }

  // Extract price from caption if present
  const priceMatch = caption.match(/(\d{3,7})/);
  const supplierPrice = priceMatch ? parseInt(priceMatch[1]) : 0;

  // Save to pending queue
  const pendingId = await saveToPending(seller.bizId, {
    imageUrl,
    caption: caption.trim(),
    name: caption.split('\n')[0].slice(0, 60) || 'Bidhaa',
    description: caption.trim(),
    supplierPrice,
    sellingPrice: 0, // Seller will set this
    category: '', // Seller will set this
    fromNumber: senderJID.replace('@s.whatsapp.net', ''),
    sellerName: seller.name,
  });

  // Confirm to seller
  await sendMsg(sock, senderJID,
    `✅ *Bidhaa imepokewa!*\n\n📦 "${caption.split('\n')[0].slice(0,40) || 'Bidhaa mpya'}"\n\nFungua app yako na uende kwenye tab ya *"Pending"* ili uihariri na kuipost.\n\n🔗 online-gulio.netlify.app`
  );
}

// ── Start Bot ──────────────────────────────────────────────────────────────
async function startBot() {
  console.log('🚀 Starting Online Gulio Bot v2...');

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Online Gulio', 'Chrome', '2.0'],
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
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnect:', shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 5000);
    }
    if (connection === 'open') {
      botConnected = true;
      currentQR = null;
      console.log('✅ WhatsApp connected!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Skip own messages
      if (msg.key.fromMe) continue;

      const senderJID = msg.key.remoteJid;
      if (!senderJID) continue;

      // Skip group messages
      if (senderJID.includes('@g.us')) continue;

      console.log(`📨 Message from: ${senderJID}`);

      try {
        await processMessage(sock, msg);
      } catch (e) {
        console.error('Process error:', e.message);
      }
    }
  });
}

startBot().catch(console.error);
process.on('uncaughtException', err => console.error('Error:', err.message));
process.on('unhandledRejection', reason => console.error('Rejection:', reason));
