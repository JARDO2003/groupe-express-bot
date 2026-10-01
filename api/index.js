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
  const snapshot = await db
    .ref("server_config/gemini_keys/0")
    .once("value");

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

async function sendWhatsAppMessage(chatId, text) {
  const baseUrl = process.env.OPENWA_PUBLIC_URL;
  const sessionId = process.env.OPENWA_SESSION_ID;
  const apiKey = process.env.OPENWA_API_KEY;

  if (!baseUrl || !sessionId || !apiKey) {
    throw new Error("Configuration OpenWA manquante dans Vercel");
  }

  const response = await fetch(
    `${baseUrl}/api/sessions/${sessionId}/messages/send-text`,
    {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chatId,
        text
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.message || data.error || "Impossible d'envoyer le message WhatsApp"
    );
  }

  return data;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({
        status: "ok",
        message: "API Groupe Express opérationnelle 🚀"
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({
        status: "error",
        message: "Méthode non autorisée"
      });
    }

    console.log("=== WEBHOOK OPENWA ===");
    console.log(JSON.stringify(req.body, null, 2));

    const body = req.body || {};

    const incoming =
      body.message ||
      body.data?.message ||
      body.data ||
      body;

    console.log(
      "Message reçu :",
      JSON.stringify(incoming, null, 2)
    );

    // Test direct depuis l'API
    if (typeof body.message === "string") {
      const reply = await askGemini(body.message);

      return res.status(200).json({
        status: "ok",
        reply
      });
    }

    // Ignore les messages envoyés par le propre compte du bot
    if (incoming.fromMe === true) {
      return res.status(200).json({
        status: "ok",
        ignored: "fromMe"
      });
    }

    const chatId = incoming.chatId;
    const messageText = incoming.body;

    // On ne traite que les messages texte
    if (
      !chatId ||
      !messageText ||
      incoming.type !== "text"
    ) {
      return res.status(200).json({
        status: "ok",
        ignored: true
      });
    }

    console.log("Chat ID :", chatId);
    console.log("Texte :", messageText);

    // Demande une réponse à Gemini
    const reply = await askGemini(messageText);

    console.log("Réponse Gemini :", reply);

    // Envoie la réponse sur WhatsApp
    const sent = await sendWhatsAppMessage(
      chatId,
      reply
    );

    console.log(
      "Message WhatsApp envoyé :",
      JSON.stringify(sent)
    );

    return res.status(200).json({
      status: "ok",
      reply,
      sent: true
    });

  } catch (error) {
    console.error("Erreur API :", error);

    return res.status(500).json({
      status: "error",
      message: error.message
    });
  }
};
