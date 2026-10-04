const crypto = require("crypto");

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getDatabase } = require("firebase-admin/database");

// ===============================
// FIREBASE
// ===============================

if (getApps().length === 0) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const firestore = getFirestore();

// ===============================
// CONFIGURATION (variables Vercel)
// ===============================

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const CRON_SECRET = process.env.CRON_SECRET;

// Test uniquement : numéro reçu -> numéro de la liste de test Meta
const ALIAS_TEST = {
  "22572369840": "2250172369840"
};

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const FUSEAU = "Africa/Abidjan";
const HEURE_RAPPEL_TEXTE = "11h59";

// ===============================
// MENU
// ===============================

const PRIX = 1500;

const PLATS = [
  { lettre: "A", nom: "Placali", mots: ["placali", "plakali"] },
  { lettre: "B", nom: "Tchep", mots: ["tchep"] },
  { lettre: "C", nom: "Attiéké", mots: ["attieke", "atieke"] },
  { lettre: "D", nom: "Aloko poisson", mots: ["aloko"] },
  { lettre: "E", nom: "Spaghetti", mots: ["spaghetti", "spaghettis"] }
];

function menuTexte() {
  const lignes = PLATS.map(p => `${p.lettre} - ${p.nom}`).join("\n");

  return (
    `Bienvenue chez Groupe Express 🍽️\n\n` +
    `Nos plats, tous à ${PRIX} F :\n\n` +
    `${lignes}\n\n` +
    `Répondez simplement par la lettre de votre choix 😊`
  );
}

// ===============================
// OUTILS
// ===============================

function normaliser(texte) {
  return texte
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function dateJour() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FUSEAU }).format(
    new Date()
  );
}

function trouverPlat(texte) {
  const t = normaliser(texte);

  const lettre = t.match(/^([a-e])[\s.!)]*$/);
  if (lettre) {
    return PLATS.find(p => p.lettre.toLowerCase() === lettre[1]);
  }

  if (t.length <= 30) {
    const trouves = PLATS.filter(p => p.mots.some(mot => t.includes(mot)));
    if (trouves.length === 1) return trouves[0];
  }

  return null;
}

const MOTS_IGNORES = ["ok", "oui", "non", "merci", "svp", "stp"];

function extraireInfos(texte) {
  let contact = null;
  let reste = texte;

  const tel = texte.match(/\+?\d[\d\s.\-]{6,}\d/);

  if (tel) {
    const chiffres = tel[0].replace(/\D/g, "");

    if (chiffres.length >= 8 && chiffres.length <= 15) {
      contact = tel[0].replace(/[\s.\-]/g, "");
      reste = texte.replace(tel[0], " ");
    }
  }

  reste = reste
    .replace(
      /\b(nom|pr[ée]noms?|contact|t[ée]l[ée]phone|tel|num[ée]ro)\b/gi,
      " "
    )
    .replace(/[,;:\/|\n\r]+/g, " ")
    .replace(/\s[-–]\s/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const mots = reste
    .split(" ")
    .filter(m => m.length >= 2 && !MOTS_IGNORES.includes(normaliser(m)));

  const nom = mots.length >= 1 ? mots.join(" ") : null;

  return { nom, contact };
}

// ===============================
// ÉTAT DE CONVERSATION (Firestore)
// ===============================

const DUREE_ETAT_MS = 6 * 60 * 60 * 1000;

async function lireEtat(from) {
  const doc = await firestore.collection("conversations").doc(from).get();

  if (!doc.exists) return null;

  const d = doc.data();

  if (Date.now() - d.maj > DUREE_ETAT_MS) return null;

  return {
    plat: PLATS.find(p => p.lettre === d.lettre),
    nom: d.nom || null,
    contact: d.contact || null
  };
}

async function ecrireEtat(from, etat) {
  await firestore.collection("conversations").doc(from).set({
    lettre: etat.plat.lettre,
    nom: etat.nom || null,
    contact: etat.contact || null,
    maj: Date.now()
  });
}

async function effacerEtat(from) {
  await firestore.collection("conversations").doc(from).delete();
}

// ===============================
// FIRESTORE : COMMANDES
// ===============================

const ALPHABET_CODE = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function genererCode() {
  let suffixe = "";

  for (let i = 0; i < 4; i++) {
    suffixe += ALPHABET_CODE[crypto.randomInt(ALPHABET_CODE.length)];
  }

  return "GE-" + suffixe;
}

async function enregistrerCommande(chatId, plat, nom, contact) {
  for (let essai = 0; essai < 5; essai++) {
    const code = genererCode();

    try {
      await firestore.collection("commandes").doc(code).create({
        code: code,
        chatId: chatId,
        plat: plat.nom,
        lettre: plat.lettre,
        prix: PRIX,
        nom: nom,
        contact: contact,
        jour: dateJour(),
        date: new Date().toISOString(),
        statut: "en_attente"
      });

      return code;
    } catch (error) {
      if (error.code === 6 || /ALREADY_EXISTS/.test(error.message)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Impossible de générer un code unique");
}

// ===============================
// GEMINI (questions hors commande)
// ===============================

async function getGeminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;

  // Ancienne méthode : clé stockée dans Firebase
  const snapshot = await getDatabase()
    .ref("server_config/gemini_keys/0")
    .once("value");

  return snapshot.val();
}

async function askGemini(message) {
  const apiKey = await getGeminiKey();

  if (!apiKey) {
    throw new Error("Clé Gemini introuvable");
  }

  const prompt = `
Tu es l'assistant officiel de Groupe Express, un service de vente de repas à emporter.

MENU (tous les plats coûtent ${PRIX} F) :
${PLATS.map(p => `${p.lettre} - ${p.nom}`).join("\n")}

RÈGLES :
- Réponds toujours en français, de façon courte, polie et chaleureuse.
- Tu peux utiliser occasionnellement 🍽️ 📦 😊.
- Ne jamais inventer un plat, un prix, un horaire, une adresse ou une information.
- Si une information n'est pas connue, dis qu'elle doit être vérifiée.
- Pour commander, le client répond simplement par la lettre du plat (A, B, C, D ou E).
- Invite toujours le client à choisir une lettre du menu.
- Le client peut faire des fautes d'orthographe : comprends-le sans inventer.

Message du client :
${message}

Réponds directement au client, sans expliquer tes règles.
`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 300 }
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result?.error?.message || `Gemini HTTP ${response.status}`
    );
  }

  const answer = result?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!answer) {
    throw new Error("Gemini n'a retourné aucune réponse.");
  }

  return answer;
}

// ===============================
// ENVOYER UN MESSAGE (API officielle WhatsApp)
// ===============================

async function sendWhatsApp(to, text) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error("META_ACCESS_TOKEN ou META_PHONE_NUMBER_ID manquant");
  }

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: ALIAS_TEST[to] || to,
        type: "text",
        text: { body: text }
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result?.error?.message || `WhatsApp HTTP ${response.status}`
    );
  }

  return result;
}

// ===============================
// LOGIQUE DE CONVERSATION
// ===============================

async function traiterMessage(from, texte) {
  const t = normaliser(texte);
  const etat = await lireEtat(from);

  if (/^(annuler|stop|recommencer)$/.test(t)) {
    await effacerEtat(from);
    return "D'accord, c'est annulé 😊\n\n" + menuTexte();
  }

  const plat = trouverPlat(texte);

  if (plat) {
    await ecrireEtat(from, {
      plat: plat,
      nom: etat ? etat.nom : null,
      contact: etat ? etat.contact : null
    });

    return (
      `Excellent choix : ${plat.nom} à ${PRIX} F 😊\n\n` +
      `Merci de m'envoyer votre nom, prénom et contact (numéro de téléphone).\n\n` +
      `Exemple : Kouassi Jean 0102030405`
    );
  }

  if (etat && etat.plat) {
    const infos = extraireInfos(texte);

    if (infos.nom) etat.nom = infos.nom;
    if (infos.contact) etat.contact = infos.contact;

    if (!etat.nom || !etat.contact) {
      await ecrireEtat(from, etat);

      if (etat.nom) {
        return `Merci ${etat.nom} 😊 Il me manque votre numéro de téléphone.`;
      }

      if (etat.contact) {
        return `Merci 😊 Il me manque votre nom (et prénom).`;
      }

      return (
        `Merci de m'envoyer votre nom et votre numéro de téléphone 😊\n` +
        `Exemple : Kouassi Jean 0102030405`
      );
    }

    const code = await enregistrerCommande(
      from,
      etat.plat,
      etat.nom,
      etat.contact
    );

    await effacerEtat(from);

    return (
      `✅ Commande enregistrée !\n\n` +
      `🔑 Votre code : ${code}\n` +
      `🍽️ ${etat.plat.nom} - ${PRIX} F\n` +
      `👤 ${etat.nom}\n` +
      `📞 ${etat.contact}\n\n` +
      `Conservez bien ce code, il identifie votre commande.\n` +
      `Nous vous écrirons à ${HEURE_RAPPEL_TEXTE} pour venir récupérer votre plat 📦\n` +
      `Merci de votre confiance 😊`
    );
  }

  if (/^(bonjour|bonsoir|salut|slt|cc|coucou|hello|hey|menu|plats?)\b/.test(t)) {
    return menuTexte();
  }

  try {
    return await askGemini(texte);
  } catch (error) {
    console.error("Erreur Gemini :", error.message);
    return menuTexte();
  }
}

// ===============================
// RAPPEL (appelé par un planificateur à 11h59)
// ===============================

async function envoyerRappels() {
  const snapshot = await firestore
    .collection("commandes")
    .where("jour", "==", dateJour())
    .where("statut", "==", "en_attente")
    .get();

  if (snapshot.empty) return { clients: 0, envoyes: 0 };

  const parClient = new Map();

  snapshot.forEach(doc => {
    const commande = doc.data();

    if (!parClient.has(commande.chatId)) {
      parClient.set(commande.chatId, []);
    }

    parClient.get(commande.chatId).push({ id: doc.id, ...commande });
  });

  const resultats = await Promise.allSettled(
    [...parClient.entries()].map(async ([chatId, commandes]) => {
      const plats = commandes.map(c => `${c.plat} (${c.code || c.id})`).join(", ");
      const nom = commandes[0].nom;

      await sendWhatsApp(
        chatId,
        `Bonjour ${nom} 😊\n\n` +
          `Votre commande (${plats}) est prête 🍽️\n` +
          `Merci de venir la récupérer 📦\n\n` +
          `Groupe Express vous souhaite bon appétit !`
      );

      for (const c of commandes) {
        await firestore.collection("commandes").doc(c.id).update({
          statut: "rappel_envoye",
          rappelEnvoyeLe: new Date().toISOString()
        });
      }
    })
  );

  resultats.forEach(r => {
    if (r.status === "rejected") {
      console.error("Rappel non envoyé :", r.reason?.message);
    }
  });

  return {
    clients: parClient.size,
    envoyes: resultats.filter(r => r.status === "fulfilled").length
  };
}

// ===============================
// WEBHOOK
// ===============================

async function lireCorps(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) {
      return { texte: req.body.toString("utf8"), brut: true };
    }
    if (typeof req.body === "string") {
      return { texte: req.body, brut: true };
    }
    // Déjà analysé par la plateforme : la signature ne peut pas être vérifiée exactement
    return { texte: JSON.stringify(req.body), brut: false };
  }

  const morceaux = [];
  for await (const morceau of req) morceaux.push(Buffer.from(morceau));

  return { texte: Buffer.concat(morceaux).toString("utf8"), brut: true };
}

function signatureValide(corps, entete) {
  if (!APP_SECRET) return true; // à utiliser seulement pour les tout premiers tests

  if (!entete) return false;

  const attendu =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(corps).digest("hex");

  const a = Buffer.from(attendu);
  const b = Buffer.from(entete);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function marquerTraite(messageId) {
  try {
    await firestore
      .collection("messages_traites")
      .doc(messageId)
      .create({ date: new Date().toISOString() });
    return true;
  } catch (error) {
    if (error.code === 6 || /ALREADY_EXISTS/.test(error.message)) {
      return false; // message déjà traité (Meta peut renvoyer le même)
    }
    throw error;
  }
}

async function traiterMessageEntrant(msg) {
  const from = msg.from;

  if (!from || !msg.id) return;

  if (!(await marquerTraite(msg.id))) return;

  let reponse;

  if (msg.type === "text" && msg.text && msg.text.body) {
    reponse = await traiterMessage(from, msg.text.body);
  } else {
    reponse =
      "Merci de m'écrire en texte 😊\n\n" + menuTexte();
  }

  await sendWhatsApp(from, reponse);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const params = url.searchParams;

      // Vérification du webhook par Meta
      if (params.get("hub.mode")) {
        if (
          params.get("hub.mode") === "subscribe" &&
          VERIFY_TOKEN &&
          params.get("hub.verify_token") === VERIFY_TOKEN
        ) {
          return res.status(200).send(params.get("hub.challenge"));
        }
        return res.status(403).send("Forbidden");
      }

      // Rappel de 11h59, appelé par un planificateur
      if (params.get("action") === "rappel") {
        const secret = params.get("secret") || req.headers["x-cron-secret"];

        if (!CRON_SECRET || secret !== CRON_SECRET) {
          return res.status(403).json({ status: "error", message: "Interdit" });
        }

        const resultat = await envoyerRappels();
        return res.status(200).json({ status: "ok", ...resultat });
      }

      return res.status(200).json({
        status: "ok",
        message: "API Groupe Express opérationnelle 🚀"
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ status: "error", message: "Méthode non autorisée" });
    }

    const { texte, brut } = await lireCorps(req);

    if (brut && !signatureValide(texte, req.headers["x-hub-signature-256"])) {
      return res.status(403).json({ status: "error", message: "Signature invalide" });
    }

    let payload;

    try {
      payload = JSON.parse(texte);
    } catch (error) {
      return res.status(400).json({ status: "error", message: "JSON invalide" });
    }

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        for (const msg of value.messages || []) {
          try {
            await traiterMessageEntrant(msg);
          } catch (error) {
            console.error("Erreur message :", error.message);
          }
        }
      }
    }

    return res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("Erreur API :", error);
    return res.status(500).json({ status: "error", message: error.message });
  }
};

// On reçoit le corps brut, nécessaire pour vérifier la signature de Meta
module.exports
