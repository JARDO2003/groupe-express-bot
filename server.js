const http = require("http");

const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

// ===============================
// FIREBASE
// ===============================

const serviceAccount = require("./firebase-service-account.json");

initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://data-com-a94a8-default-rtdb.firebaseio.com"
});

const { getDatabase: getFirebaseDatabase } = require("firebase-admin/database");
const db = getFirebaseDatabase();

// ===============================
// OPENWA
// ===============================

const OPENWA_URL = "http://localhost:2785";

const SESSION_ID =
  "d90d92e7-5364-468f-ade9-66f81e75cd3d";

const OPENWA_API_KEY =
  process.env.OPENWA_API_KEY || "owa_k1_5c96cb86ae3997a3119bf456bd1322f928715a01a25b9a9c93001b7542ec2115";

// ===============================
// GEMINI
// ===============================

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "AQ.Ab8RN6L6pNVz1rCyHghhPlDLde4AzTgXbi_s7oDZDAjHQvOKIQ";

const GEMINI_MODEL = "gemini-3.5-flash-lite";

// ===============================
// MÉMOIRE TEMPORAIRE
// ===============================

const conversations = new Map();

// ===============================
// FIREBASE : ENREGISTRER MESSAGE
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
// GEMINI
// ===============================

async function askGemini(chatId, message) {
  let history = conversations.get(chatId) || [];

  history.push({
    role: "user",
    text: message
  });

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
Tu es l'assistant officiel de Groupe Express, un service de vente et livraison de repas.

RÈGLES :
- Réponds toujours en français.
- Sois poli, naturel, chaleureux, simple et professionnel.
- Réponds de manière concise.
- Tu peux utiliser occasionnellement 🍽️ 📦 😊.
- Ne jamais inventer un plat, un prix, une disponibilité ou une information.
- Si une information sur le menu n'est pas connue, dis clairement qu'elle doit être vérifiée.
- Aide le client à passer sa commande étape par étape.
- Pour une commande, recueille progressivement :
  1. nom du client
  2. plat
  3. quantité
  4. numéro de téléphone
  5. lieu de livraison
- Ne demande pas toutes les informations en une seule fois.
- Termine par un récapitulatif avant confirmation.
- Si le client demande quelque chose que tu ne connais pas, ne l'invente pas.
- Le client peut faire des fautes d'orthographe : comprends le message autant que possible sans inventer.

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
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.4,
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

  const answer =
    result?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!answer) {
    throw new Error("Gemini n'a retourné aucune réponse.");
  }

  history.push({
    role: "assistant",
    text: answer
  });

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
      body: JSON.stringify({
        chatId: chatId,
        text: text
      })
    }
  );

  const result = await response.text();

  if (!response.ok) {
    throw new Error(result);
  }

  return result;
}

// ===============================
// SERVEUR HTTP
// ===============================

const server = http.createServer((req, res) => {

  // Test du serveur
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("Groupe Express Bot fonctionne !");
    return;
  }

  // Webhook
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();
    });

    req.on("end", async () => {

      console.log("\n📩 MESSAGE WHATSAPP REÇU");

      let payload;

      try {
        payload = JSON.parse(body);

        console.log(
          JSON.stringify(payload, null, 2)
        );

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

        if (!data || data.fromMe || !data.chatId) {
          return;
        }

        if (data.type !== "text" || !data.body) {
          return;
        }

        const chatId = data.chatId;
        const clientMessage = data.body;

        console.log("👤 Client :", clientMessage);
        console.log("🤖 Envoi à Gemini...");

        const reply = await askGemini(
          chatId,
          clientMessage
        );

        console.log("🤖 Gemini :", reply);

        // Enregistrer dans Firebase
        await saveMessageToFirebase(
          chatId,
          clientMessage,
          reply
        );

        // Envoyer la réponse WhatsApp
        const sendResult = await sendWhatsApp(
          chatId,
          reply
        );

        console.log(
          "📤 Réponse WhatsApp envoyée :",
          sendResult
        );

      } catch (error) {
        console.error(
          "❌ Erreur :",
          error.message
        );
      }
    });

    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// ===============================
// ERREURS SERVEUR
// ===============================

server.on("error", error => {
  console.error(
    "❌ Erreur serveur :",
    error.message
  );
});

// ===============================
// DÉMARRAGE
// ===============================

server.listen(3000, "0.0.0.0", () => {
  console.log(
    "🚀 Serveur Groupe Express démarré sur le port 3000"
  );

  console.log("🔥 Firebase connecté");
  console.log("🤖 Gemini :", GEMINI_MODEL);
  console.log("📱 OpenWA :", OPENWA_URL);
});
