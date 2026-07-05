import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import { join } from 'path';
import { sanitizePhone, formatJid, getSessionDir, clearSessionDir } from './utils.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'error' });

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  /**
   * Initializes and restores all previously active sessions from the filesystem.
   */
  async restoreSessions() {
    const sessionsDir = join(process.cwd(), 'sessions');
    if (!fs.existsSync(sessionsDir)) {
      return;
    }

    try {
      const dirs = fs.readdirSync(sessionsDir);
      for (const dirName of dirs) {
        const fullPath = join(sessionsDir, dirName);
        if (fs.statSync(fullPath).isDirectory()) {
          const phone = sanitizePhone(dirName);
          if (phone) {
            console.log(`Restoring session for phone: ${phone}`);
            this.initSession(phone).catch(err => {
              console.error(`Failed to restore session for ${phone}:`, err);
            });
          }
        }
      }
    } catch (err) {
      console.error('Error scanning sessions directory:', err);
    }
  }

  /**
   * Initializes a Baileys session for a given phone number.
   * @param {string} phone 
   * @returns {Promise<object>} The session object
   */
  async initSession(phone) {
    const cleanPhone = sanitizePhone(phone);
    if (!cleanPhone) {
      throw new Error('Invalid phone number provided');
    }

    // Return existing session if it exists and is not disconnected
    if (this.sessions.has(cleanPhone)) {
      const existing = this.sessions.get(cleanPhone);
      if (existing.status !== 'disconnected') {
        return existing;
      }
    }

    const sessionDir = getSessionDir(cleanPhone);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const session = {
      phone: cleanPhone,
      status: 'connecting',
      sock: null,
      qrData: null,
      pendingResolvers: []
    };

    this.sessions.set(cleanPhone, session);

    const startSocket = async () => {
      let version = [2, 3000, 1017531287]; // standard fallback
      try {
        const { version: latestVersion } = await fetchLatestBaileysVersion();
        version = latestVersion;
      } catch (err) {
        console.warn(`Failed to fetch latest Baileys version for ${cleanPhone}, using fallback:`, err.message);
      }

      const sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
      });

      session.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            const qrDataUrl = await QRCode.toDataURL(qr);
            const expiry = Date.now() + 40000; // QR codes last ~40s before refresh
            
            session.status = 'qr';
            session.qrData = {
              qr,
              qrDataUrl,
              expiryTime: new Date(expiry).toISOString()
            };

            // Resolve all pending connect promises
            const resolvers = [...session.pendingResolvers];
            session.pendingResolvers = [];
            for (const { resolve } of resolvers) {
              resolve({
                status: 'qr',
                qr: session.qrData.qr,
                qrDataUrl: session.qrData.qrDataUrl,
                expiryTime: session.qrData.expiryTime
              });
            }
          } catch (err) {
            console.error(`Error generating QR code image for ${cleanPhone}:`, err);
          }
        }

        if (connection === 'open') {
          session.status = 'connected';
          session.qrData = null;

          console.log(`WhatsApp session open and ready for: ${cleanPhone}`);

          // Resolve all pending connect promises
          const resolvers = [...session.pendingResolvers];
          session.pendingResolvers = [];
          for (const { resolve } of resolvers) {
            resolve({
              status: 'connected',
              phone: cleanPhone
            });
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log(`Connection closed for ${cleanPhone}. Reason code: ${statusCode}. Reconnecting: ${shouldReconnect}`);

          session.qrData = null;

          if (shouldReconnect) {
            session.status = 'connecting';
            startSocket();
          } else {
            session.status = 'disconnected';
            session.sock = null;
            this.sessions.delete(cleanPhone);
            await clearSessionDir(cleanPhone);

            // Reject all pending connect promises
            const resolvers = [...session.pendingResolvers];
            session.pendingResolvers = [];
            for (const { reject } of resolvers) {
              reject(new Error('Session logged out or connection closed permanently'));
            }
          }
        }
      });
    };

    startSocket();
    return session;
  }

  /**
   * Gets session details.
   * @param {string} phone 
   * @returns {object} Session details
   */
  getSession(phone) {
    const cleanPhone = sanitizePhone(phone);
    if (!cleanPhone) return { status: 'disconnected', persisted: false };

    const session = this.sessions.get(cleanPhone);
    if (!session) {
      // Check if session directory exists (credentials exist but session is not running)
      const sessionDir = getSessionDir(cleanPhone);
      const credsExists = fs.existsSync(join(sessionDir, 'creds.json'));
      return {
        status: 'disconnected',
        persisted: credsExists
      };
    }

    return {
      status: session.status,
      qrData: session.qrData,
      persisted: true
    };
  }

  /**
   * Logs out and deletes a session.
   * @param {string} phone 
   */
  async disconnectSession(phone) {
    const cleanPhone = sanitizePhone(phone);
    const session = this.sessions.get(cleanPhone);

    if (session) {
      if (session.sock) {
        try {
          await session.sock.logout();
        } catch (err) {
          console.error(`Error logging out session for ${cleanPhone}:`, err);
          try {
            session.sock.end();
          } catch (_) {}
        }
      }
      this.sessions.delete(cleanPhone);
    }

    // Force clear files
    await clearSessionDir(cleanPhone);
  }

  /**
   * Sends a text message to a specific recipient.
   * @param {string} senderPhone 
   * @param {string} recipientPhone 
   * @param {string} message 
   * @returns {Promise<object>}
   */
  async sendMessage(senderPhone, recipientPhone, message) {
    const cleanSender = sanitizePhone(senderPhone);
    const session = this.sessions.get(cleanSender);

    if (!session || session.status !== 'connected') {
      throw new Error(`Sender session is not connected. Status: ${session ? session.status : 'disconnected'}`);
    }

    const recipientJid = formatJid(recipientPhone);
    if (!recipientJid) {
      throw new Error('Invalid recipient phone number');
    }

    const response = await session.sock.sendMessage(recipientJid, { text: message });
    return response;
  }
}

export const sessionManager = new SessionManager();
