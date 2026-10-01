const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

if (getApps().length === 0) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = getDatabase();

async function getGeminiKey() {
  const snapshot = await db.ref("server_config/gemini_keys/0").once("value");
  return snapshot.val();
}

async function askGemini(message) {
  const apiKey = await getGeminiKey();

  if (!apiKey) {
    throw new Error("Clé Gemini introuvable dans Firebase");
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=" +
      encodeURIComponent(apiKey),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text:
                  "Tu es l'assistant officiel de Groupe Express, une entreprise de vente et livraison de repas.\n\n" +
                  "Réponds toujours en français, de manière polie, naturelle, simple, chaleureuse et concise.\n" +
                  "Tu peux utiliser occasionnellement les emojis 🍽️📦😊.\n" +
                  "N'invente jamais un plat, un prix, une disponibilité ou une information.\n" +
                  "Si une information n'est pas connue, indique simplement qu'elle doit être vérifiée.\n\n" +
                  "Message du client :\n" +
                  message
              }
            ]
          }
        ]
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message || "Erreur lors de la communication avec Gemini"
    );
  }

  return (
    data.candidates?.[0]?.content?.parts?.[0]?.text ||
    "Désolé, je n'ai pas pu générer une réponse."
  );
}

module.exports = async function handler(req, res) {
  try {
    // Vérification de l'API
    if (req.method === "GET") {
      return res.status(200).json({
        status: "ok",
        message: "API Groupe Express opérationnelle 🚀"
      });
    }

    // OpenWA envoie les événements avec POST
    if (req.method === "POST") {
      console.log("=== WEBHOOK OPENWA ===");
      console.log(JSON.stringify(req.body, null, 2));

      const body = req.body || {};

      // Recherche du message reçu dans différentes structures possibles
      const message =
        body.message ||
        body.data?.message ||
        body.data ||
        body;

      console.log("Message reçu :", JSON.stringify(message, null, 2));

      // Si c'est simplement un test avec {message:"..."}
      if (typeof body.message === "string") {
        const reply = await askGemini(body.message);

        return res.status(200).json({
          status: "ok",
          reply
        });
      }

      // Pour OpenWA : on accuse réception du webhook
      return res.status(200).json({
        status: "ok",
        received: true
      });
    }

    return res.status(405).json({
      status: "error",
      message: "Méthode non autorisée"
    });

  } catch (error) {
    console.error("Erreur API :", error);

    return res.status(500).json({
      status: "error",
      message: error.message
    });
  }
};