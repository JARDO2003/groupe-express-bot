import admin from "firebase-admin";

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = admin.database();

export default async function handler(req, res) {
  try {
    const ref = db.ref("test_vercel");
    await ref.set({
      message: "Connexion Firebase depuis Vercel réussie",
      date: new Date().toISOString()
    });

    res.status(200).json({
      status: "ok",
      firebase: "connected",
      message: "Groupe Express + Firebase fonctionne sur Vercel 🚀"
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      status: "error",
      firebase: "failed",
      message: error.message
    });
  }
}