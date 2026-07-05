import 'dotenv/config';
import express from 'express';
import { sessionManager } from './sessionManager.js';
import { sanitizePhone } from './utils.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper to extract phone from request query or body
function getPhoneParam(req) {
  return req.query.phone || req.body.phone;
}

// RESTORE EXISTING SESSIONS ON STARTUP
console.log('Initializing existing WhatsApp sessions...');
await sessionManager.restoreSessions();

/**
 * GET /connect
 * Starts or retrieves connection for a phone session.
 * Returns QR code + expiry or connected status.
 */
app.get('/connect', async (req, res) => {
  const phone = getPhoneParam(req);
  const cleanPhone = sanitizePhone(phone);

  if (!cleanPhone) {
    return res.status(400).json({ error: 'Phone number is required via ?phone= or request body' });
  }

  try {
    const state = sessionManager.getSession(cleanPhone);

    // If already connected, return success
    if (state.status === 'connected') {
      return res.json({ status: 'connected', phone: cleanPhone });
    }

    // If currently waiting for a QR and QR is not expired, return it immediately
    if (state.status === 'qr' && state.qrData && Date.now() < Date.parse(state.qrData.expiryTime)) {
      return res.json({
        status: 'qr',
        phone: cleanPhone,
        ...state.qrData
      });
    }

    // Otherwise, ensure the session is initialized/started
    await sessionManager.initSession(cleanPhone);
    const session = sessionManager.sessions.get(cleanPhone);

    if (!session) {
      return res.status(500).json({ error: 'Failed to initialize session' });
    }

    // If connection setup is in progress (connecting or qr but expired), wait for the next update
    const timeoutMs = 25000;
    const responsePromise = new Promise((resolve, reject) => {
      const resolver = { resolve, reject };
      session.pendingResolvers.push(resolver);

      // Timeout handler
      setTimeout(() => {
        const idx = session.pendingResolvers.indexOf(resolver);
        if (idx !== -1) {
          session.pendingResolvers.splice(idx, 1);
        }
        reject(new Error('Timeout waiting for connection QR code'));
      }, timeoutMs);
    });

    const result = await responsePromise;
    res.json({ phone: cleanPhone, ...result });

  } catch (err) {
    res.status(504).json({ error: err.message });
  }
});

/**
 * POST/GET /disconnect
 * Logs out of a WhatsApp session and deletes its persistent authentication state directory.
 */
const handleDisconnect = async (req, res) => {
  const phone = getPhoneParam(req);
  const cleanPhone = sanitizePhone(phone);

  if (!cleanPhone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  try {
    await sessionManager.disconnectSession(cleanPhone);
    res.json({ status: 'disconnected', phone: cleanPhone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.post('/disconnect', handleDisconnect);
app.get('/disconnect', handleDisconnect); // Also allow GET for convenience

/**
 * GET /status
 * Checks status of a phone session.
 */
app.get('/status', (req, res) => {
  const phone = getPhoneParam(req);
  const cleanPhone = sanitizePhone(phone);

  if (!cleanPhone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  const state = sessionManager.getSession(cleanPhone);
  res.json({
    phone: cleanPhone,
    status: state.status,
    persisted: state.persisted
  });
});

/**
 * POST /send-message
 * Sends a text message to a specific recipient.
 * Payload: { sender, recipient, message } (also supports 'to' and 'text')
 */
app.post('/send-message', async (req, res) => {
  const sender = req.body.sender || req.body.phone;
  const recipient = req.body.recipient || req.body.to;
  const message = req.body.message || req.body.text;

  const cleanSender = sanitizePhone(sender);
  const cleanRecipient = sanitizePhone(recipient);

  if (!cleanSender || !cleanRecipient || !message) {
    return res.status(400).json({
      error: 'Missing required parameters: sender, recipient, and message must be provided.'
    });
  }

  try {
    const result = await sessionManager.sendMessage(cleanSender, cleanRecipient, message);
    res.json({
      success: true,
      messageId: result.key.id,
      timestamp: result.messageTimestamp
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// START EXPRESS SERVER
app.listen(PORT, () => {
  console.log(`WhatsApp API HTTP Server running on http://localhost:${PORT}`);
});
