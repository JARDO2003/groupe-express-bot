const http = require("http");

const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getFirestore } = require("firebase-admin/firestore");

// ===============================
// FIREBASE
// ===============================

const serviceAccount = require("./firebase-service-account.json");

initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://data-com-a94a8-default-rtdb.firebaseio.com"
});

const db = getDatabase();        // conversations (Realtime Database)
const firestore = getFirestore(); // commandes (Firestore)

// ===============================
// CONFIGURATION
// ===============================

const OPENWA_URL = "http://localhost:2785";
const SESSION_ID = "5967a046-6d1c-4506-a11b-0c28d8f71ba0";

// Les clés ne sont plus écrites dans le fichier
const OPENWA_API_KEY = process.env.OPENWA_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-3.5-flash-lite";

const FUSEAU = "Africa/Abidjan";
const HEURE_RAPPEL = process.env.HEURE_RAPPEL || "11:59";

if (!OPENWA_API_KEY || !GEMINI_API_KEY) {
  console.error(
    "❌ Clé manquante : définis OPENWA_API_KEY et GEMINI_API_KEY avant de lancer le serveur."
  );
  process.exit(1);
}

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
  // Format AAAA-MM-JJ dans le fuseau d'Abidjan
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSEAU
  }).format(new Date());
}

function heureMinute() {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: FUSEAU,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date());
}

function trouverPlat(texte) {
  const t = normaliser(texte);

  // Une seule lettre : "A", "a", "B." ...
  const lettre = t.match(/^([a-e])[\s.!)]*$/);
  if (lettre) {
    return PLATS.find(p => p.lettre.toLowerCase() === lettre[1]);
  }

  // Nom du plat dans un message court
  if (t.length <= 30) {
    const trouves = PLATS.filter(p =>
      p.mots.some(mot => t.includes(mot))
    );
    if (trouves.length === 1) return trouves[0];
  }

  return null;
}

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

  const mots = reste.split(" ").filter(m => m.length >= 2);
  const nom = mots.length >= 2 ? mots.join(" ") : null;

  return { nom, contact };
}

// ===============================
// ÉTAT DES CONVERSATIONS (mémoire)
// ===============================

const etats = new Map();        // chatId -> { plat }
const conversations = new Map(); // chatId -> historique Gemini

// ===============================
// FIREBASE : CONVERSATIONS
// ===============================

async function saveMessageToFirebase(chatId, clientMessage, reply) {
  const ref = db.ref("messages").push();

  await ref.set({
    chatId: chatId,
    messageClient: clientMessage,
    reponseBot: reply,
    date: new Date().toISOString(),
    statut: "conversation"
  });

  console.log("🔥 Message enregistré dans Firebase :", ref.key);
}

// ===============================
// FIRESTORE : COMMANDES
// ===============================

async function enregistrerCommande(chatId, plat, nomComplet, contact) {
  const ref = await firestore.collection("commandes").add({
    chatId: chatId,
    plat: plat.nom,
    lettre: plat.lettre,
    prix: PRIX,
    nomComplet: nomComplet,
    contact: contact,
    jour: dateJour(),
    date: new Date().toISOString(),
    statut: "en_attente"
  });

  console.log("🧾 Commande enregistrée dans Firestore :", ref.id);
  return ref.id;
}

// ===============================
// GEMINI (questions hors commande)
// ===============================

async function askGemini(chatId, message) {
  let history = conversations.get(chatId) || [];

  history.push({ role: "user", text: message });

  if (history.length > 10) {
    history = history.slice(-10);
  }

  conversations.set(chatId, history);

  const historyText = history
    .map(
      item =>
        `${item.role === "user" ? "Client" : "Assistant"} : ${item.text}`
    )
    .join("\n");

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

Historique récent :
${historyText}

Dernier message du client :
${message}

Réponds directement au client, sans expliquer tes règles.
`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": GEMINI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 300
        }
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

  history.push({ role: "assistant", text: answer });
  conversations.set(chatId, history);

  return answer;
}

// ===============================
// ENVOYER MESSAGE WHATSAPP
// ===============================

async function sendWhatsApp(chatId, text) {
  const response = await fetch(
    `${OPENWA_URL}/api/sessions/${SESSION_ID}/messages/send-text`,
    {
      method: "POST",
      headers: {
        "X-API-Key": OPENWA_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ chatId: chatId, text: text })
    }
  );

  const result = await response.text();

  if (!response.ok) {
    throw new Error(result);
  }

  return result;
}

// ===============================
// LOGIQUE DE CONVERSATION
// ===============================

async function traiterMessage(chatId, texte) {
  const t = normaliser(texte);
  const etat = etats.get(chatId);

  // Annulation
  if (/^(annuler|stop|recommencer)$/.test(t)) {
    etats.delete(chatId);
    return "D'accord, c'est annulé 😊\n\n" + menuTexte();
  }

  // Le client choisit un plat (lettre ou nom)
  const plat = trouverPlat(texte);

  if (plat) {
    etats.set(chatId, { plat: plat });

    return (
      `Excellent choix : ${plat.nom} à ${PRIX} F 😊\n\n` +
      `Merci de m'envoyer votre nom, prénom et contact (numéro de téléphone).\n\n` +
      `Exemple : Kouassi Jean 0102030405`
    );
  }

  // Le client donne ses informations
  if (etat) {
    const { nom, contact } = extraireInfos(texte);

    if (!nom || !contact) {
      const manque = [];
      if (!nom) manque.push("votre nom et prénom");
      if (!contact) manque.push("votre numéro de téléphone");

      return (
        `Il me manque encore ${manque.join(" et ")} 😊\n` +
        `Exemple : Kouassi Jean 0102030405`
      );
    }

    await enregistrerCommande(chatId, etat.plat, nom, contact);
    etats.delete(chatId);

    return (
      `✅ Commande enregistrée !\n\n` +
      `🍽️ ${etat.plat.nom} - ${PRIX} F\n` +
      `👤 ${nom}\n` +
      `📞 ${contact}\n\n` +
      `Nous vous écrirons à ${HEURE_RAPPEL.replace(":", "h")} pour venir récupérer votre plat 📦\n` +
      `Merci de votre confiance 😊`
    );
  }

  // Salutations ou demande du menu
  if (/^(bonjour|bonsoir|salut|slt|cc|coucou|hello|hey|menu|plats?)\b/.test(t)) {
    return menuTexte();
  }

  // Autre question : Gemini
  try {
    return await askGemini(chatId, texte);
  } catch (error) {
    console.error("❌ Erreur Gemini :", error.message);
    return menuTexte();
  }
}

// ===============================
// RAPPEL AUTOMATIQUE
// ===============================

async function envoyerRappels() {
  const jour = dateJour();

  const snapshot = await firestore
    .collection("commandes")
    .where("jour", "==", jour)
    .where("statut", "==", "en_attente")
    .get();

  if (snapshot.empty) {
    console.log("⏰ Aucun rappel à envoyer.");
    return;
  }

  // Regroupe les commandes par client
  const parClient = new Map();

  snapshot.forEach(doc => {
    const commande = doc.data();

    if (!parClient.has(commande.chatId)) {
      parClient.set(commande.chatId, []);
    }

    parClient.get(commande.chatId).push({ id: doc.id, ...commande });
  });

  for (const [chatId, commandes] of parClient) {
    const plats = commandes.map(c => c.plat).join(", ");
    const nom = commandes[0].nomComplet;

    const message =
      `Bonjour ${nom} 😊\n\n` +
      `Votre commande (${plats}) est prête 🍽️\n` +
      `Merci de venir la récupérer 📦\n\n` +
      `Groupe Express vous souhaite bon appétit !`;

    try {
      await sendWhatsApp(chatId, message);

      for (const c of commandes) {
        await firestore.collection("commandes").doc(c.id).update({
          statut: "rappel_envoye",
          rappelEnvoyeLe: new Date().toISOString()
        });
      }

      console.log("⏰ Rappel envoyé à :", nom);
    } catch (error) {
      console.error("❌ Rappel non envoyé à", nom, ":", error.message);
    }

    // Petite pause entre deux messages
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

let dernierJourRappel = null;

setInterval(async () => {
  if (
    heureMinute() === HEURE_RAPPEL &&
    dernierJourRappel !== dateJour()
  ) {
    dernierJourRappel = dateJour();
    console.log("⏰ Envoi des rappels de", HEURE_RAPPEL);

    try {
      await envoyerRappels();
    } catch (error) {
      console.error("❌ Erreur rappels :", error.message);
    }
  }
}, 20000);

// ===============================
// SERVEUR HTTP
// ===============================

const server = http.createServer((req, res) => {
  // Test serveur
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Groupe Express Bot fonctionne !");
    return;
  }

  // Webhook OpenWA
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();
    });

    req.on("end", async () => {
      let payload;

      try {
        payload = JSON.parse(body);
      } catch (error) {
        console.error("❌ JSON invalide");
        res.writeHead(400);
        res.end("Bad Request");
        return;
      }

      res.writeHead(200);
      res.end("OK");

      try {
        const data = payload.data;

        if (!data || data.fromMe || data.isGroup || !data.chatId) {
          return;
        }

        if (data.type !== "text" || !data.body) {
          return;
        }

        const chatId = data.chatId;
        const clientMessage = data.body;

        console.log("\n📩 MESSAGE WHATSAPP REÇU");
        console.log("👤 Client :", clientMessage);

        const reply = await traiterMessage(chatId, clientMessage);

        console.log("🤖 Réponse :", reply);

        await saveMessageToFirebase(chatId, clientMessage, reply);

        const sendResult = await sendWhatsApp(chatId, reply);

        console.log("📤 Réponse WhatsApp envoyée :", sendResult);
      } catch (error) {
        console.error("❌ Erreur :", error.message);
      }
    });

    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.on("error", error => {
  console.error("❌ Erreur serveur :", error.message);
});

// ===============================
// DÉMARRAGE
// ===============================

server.listen(3000, "0.0.0.0", () => {
  console.log("🚀 Serveur Groupe Express démarré sur le port 3000");
  console.log("🔥 Firebase connecté");
  console.log("🤖 Gemini :", GEMINI_MODEL);
  console.log("📱 OpenWA :", OPENWA_URL);
  console.log("⏰ Rappel quotidien à :", HEURE_RAPPEL, "(" + FUSEAU + ")");
});
