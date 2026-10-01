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
                  "Tu es l'assistant officiel de Groupe Express, une entreprise de vente et livraison de repas. " +
                  "Réponds toujours en français, de manière polie, naturelle, simple, chaleureuse et concise. " +
                  "N'invente jamais un plat, un prix ou une disponibilité.\n\n" +
                  "Message du client : " +
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
    if (req.method !== "POST") {
      return res.status(200).json({
        status: "ok",
        message: "API Groupe Express + Gemini opérationnelle 🚀"
      });
    }

    const message = req.body?.message;

    if (!message) {
      return res.status(400).json({
        status: "error",
        message: "Le champ 'message' est obligatoire."
      });
    }

    const reply = await askGemini(message);

    res.status(200).json({
      status: "ok",
      reply
    });

  } catch (error) {
    console.error("Erreur :", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
};