// index.js : connexion WhatsApp (Baileys) pour le bot Groupe Express
// Ce fichier remplace le webhook Meta. Votre logique reste dans bot.js.

const http = require("http");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const { getFirestore } = require("firebase-admin/firestore");

const bot = require("./bot"); // initialise Firebase au chargement

const firestore = getFirestore();
const FUSEAU = "Africa/Abidjan";

process.on("unhandledRejection", e => console.error("Erreur non gérée :", e));

// ===============================
// SESSION WHATSAPP STOCKÉE DANS FIRESTORE
// (collection "baileys_auth" : la session survit aux redémarrages de Render)
// ===============================

async function utiliserAuthFirestore(b) {
  const { BufferJSON, initAuthCreds, proto } = b;
  const col = firestore.collection("baileys_auth");

  const cle = id => String(id).replace(/\//g, "__").replace(/:/g, "-");
  const ecrire = (id, data) =>
    col.doc(cle(id)).set({ v: JSON.stringify(data, BufferJSON.replacer) });
  const lire = async id => {
    const d = await col.doc(cle(id)).get();
    return d.exists ? JSON.parse(d.data().v, BufferJSON.reviver) : null;
  };

  const creds = (await lire("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async id => {
              let v = await lire(`${type}-${id}`);
              if (type === "app-state-sync-key" && v) {
                v = proto.Message.AppStateSyncKeyData.fromObject(v);
              }
              data[id] = v;
            })
          );
          return data;
        },
        set: async data => {
          const taches = [];
          for (const type in data) {
            for (const id in data[type]) {
              const v = data[type][id];
              taches.push(
                v ? ecrire(`${type}-${id}`, v) : col.doc(cle(`${type}-${id}`)).delete()
              );
            }
          }
          await Promise.all(taches);
        }
      }
    },
    saveCreds: () => ecrire("creds", creds)
  };
}

// ===============================
// ENVOI : file d'attente avec petits délais (limite le risque de bannissement)
// ===============================

let sock = null;
let pret = false;

function versJid(to) {
  const s = String(to);
  return s.includes("@") ? s : `${s.replace(/\D/g, "")}@s.whatsapp.net`;
}

const pause = ms => new Promise(r => setTimeout(r, ms));

let file = Promise.resolve();
function enFile(tache) {
  const p = file.then(tache);
  file = p.catch(() => {}).then(() => pause(1500 + Math.random() * 2500));
  return p;
}

bot.setTransport({
  sendText: (to, text) =>
    enFile(async () => {
      if (!sock || !pret) throw new Error("WhatsApp non connecté");
      const jid = versJid(to);
      await sock.sendPresenceUpdate("composing", jid).catch(() => {});
      await pause(Math.min(3000, 500 + String(text).length * 15));
      await sock.sendMessage(jid, { text: String(text) });
    }),

  sendImage: (to, url, legende) =>
    enFile(async () => {
      if (!sock || !pret) throw new Error("WhatsApp non connecté");
      await sock.sendMessage(versJid(to), {
        image: { url },
        caption: String(legende || "").slice(0, 1000)
      });
    })
});

// ===============================
// FILE D'ENVOIS DE LA PAGE ADMIN (Firestore -> WhatsApp)
// ===============================

let ecouteFile = false;

function demarrerFile() {
  if (ecouteFile) return;
  ecouteFile = true;

  firestore
    .collection("file_envois")
    .where("statut", "==", "en_attente")
    .onSnapshot(
      snap => {
        if (!snap.empty) {
          bot.traiterFile().catch(e => console.error("File d'envois :", e.message));
        }
      },
      e => console.error("Écoute Firestore :", e.message)
    );
}

// ===============================
// RAPPEL DE 11h59 (heure d'Abidjan)
// ===============================

let dernierRappel = null;

setInterval(async () => {
  if (!pret) return;

  const maintenant = new Intl.DateTimeFormat("en-GB", {
    timeZone: FUSEAU,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());

  const jour = new Intl.DateTimeFormat("en-CA", { timeZone: FUSEAU }).format(new Date());

  if (maintenant === "11:59" && dernierRappel !== jour) {
    dernierRappel = jour;
    try {
      console.log("Rappels :", await bot.envoyerRappels());
    } catch (e) {
      console.error("Rappels :", e.message);
    }
  }
}, 20000);

// ===============================
// CONNEXION BAILEYS
// ===============================

async function demarrer() {
  const baileys = await import("@whiskeysockets/baileys");
  const makeWASocket =
    baileys.makeWASocket || (baileys.default && baileys.default.default) || baileys.default;
  const { DisconnectReason, fetchLatestBaileysVersion } = baileys;

  const { state, saveCreds } = await utiliserAuthFirestore(baileys);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["Groupe Express", "Chrome", "1.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\nScannez ce QR avec WhatsApp > Appareils connectés :\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      pret = true;
      console.log("WhatsApp connecté ✅");
      demarrerFile();
    }

    if (connection === "close") {
      pret = false;
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : null;

      if (code === DisconnectReason.loggedOut) {
        console.error(
          "Session déconnectée depuis le téléphone. Supprimez la collection " +
            "'baileys_auth' dans Firestore puis relancez pour rescanner le QR."
        );
        return;
      }

      console.log("Connexion fermée (code", code, "), reconnexion dans 3 s…");
      setTimeout(() => demarrer().catch(e => console.error(e)), 3000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue;

        const from = m.key.remoteJid || "";
        // On ignore les groupes, les statuts et les diffusions
        if (!/@(s\.whatsapp\.net|lid)$/.test(from)) continue;

        const texte =
          m.message.conversation ||
          (m.message.extendedTextMessage && m.message.extendedTextMessage.text) ||
          null;

        await bot.traiterMessageEntrant({
          id: m.key.id,
          from,
          type: texte ? "text" : "autre",
          text: { body: texte }
        });
      } catch (e) {
        console.error("Erreur message :", e.message);
      }
    }
  });
}

// Petit serveur HTTP : Render en a besoin, et un service de ping peut le réveiller
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(pret ? "Groupe Express : WhatsApp connecté" : "Groupe Express : connexion en cours");
  })
  .listen(process.env.PORT || 3000);

demarrer().catch(e => {
  console.error("Démarrage impossible :", e);
  process.exit(1);
});
