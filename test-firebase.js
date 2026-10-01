const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

const serviceAccount = require("./firebase-service-account.json");

initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://data-com-a94a8-default-rtdb.firebaseio.com"
});

const db = getDatabase();

async function testFirebase() {
  try {
    console.log("🔄 Connexion à Firebase...");

    const ref = db.ref("test_connexion").push();

    await ref.set({
      message: "Connexion Firebase réussie",
      date: new Date().toISOString(),
      statut: "test"
    });

    console.log("✅ Firebase fonctionne !");
    console.log("📁 Chemin : test_connexion");
    console.log("🆔 ID créé :", ref.key);

    process.exit(0);

  } catch (error) {
    console.error("❌ Erreur Firebase :", error.message);
    process.exit(1);
  }
}

testFirebase();