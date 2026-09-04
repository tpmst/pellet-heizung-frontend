const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {logger} = require("firebase-functions");
const {getAuth} = require("firebase-admin/auth");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const nodemailer = require("nodemailer");

const {onSchedule} = require("firebase-functions/v2/scheduler"); // Neu für den täglichen Timer

initializeApp();
const db = getFirestore();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

exports.sendWarningEmail = onDocumentCreated({
  document: "warnings/{warningId}",
  secrets: ["GMAIL_USER", "GMAIL_PASS"],
}, async (event) => {
  const snapshot = event.data;
  if (!snapshot) return null;

  const MAX_PER_DAY = 3;
  const MIN_GAP_HOURS = 6;
  const MIN_GAP_MS = MIN_GAP_HOURS * 60 * 60 * 1000;

  const now = Date.now();
  const todayStr = new Date().toISOString().split("T")[0];

  const limitRef = db.collection("metadata").doc("notification_limit");
  const limitDoc = await limitRef.get();

  let sentCountToday = 0;
  let lastSentTimestamp = 0;
  let lastResetDate = "";

  if (limitDoc.exists) {
    const data = limitDoc.data();
    lastResetDate = data.lastResetDate || "";
    if (lastResetDate === todayStr) {
      sentCountToday = data.sentCountToday || 0;
    }
    lastSentTimestamp = data.lastSentTimestamp || 0;
  }

  if (sentCountToday >= MAX_PER_DAY || (lastSentTimestamp > 0 && (now - lastSentTimestamp) < MIN_GAP_MS)) {
    logger.info("Rate-limit active. Email skipped.");
    return null;
  }

  const warningData = snapshot.data();
  const warningTitle = warningData.title || "Pellet-Heizung Warnung";
  const warningMessage = warningData.message || "Eine neue Warnung wurde erfasst.";

  try {
    const listUsersResult = await getAuth().listUsers();
    const emails = listUsersResult.users.map((user) => user.email).filter(Boolean);

    if (emails.length === 0) return null;

    await transporter.sendMail({
      from: `"Pellet System" <${process.env.GMAIL_USER}>`,
      bcc: emails, // BCC ensures users don't see each other's addresses
      subject: `🚨 Warnung: ${warningTitle}`,
      text: `Hallo,\n\nNeue Warnung im System:\n\n"${warningMessage}"\n\nViele Grüße\nDein Pellet-System`,
    });

    await limitRef.set({
      sentCountToday: sentCountToday + 1,
      lastSentTimestamp: now,
      lastResetDate: todayStr,
    }, {merge: true});

    logger.info(`Warning email sent via Gmail to ${emails.length} users.`);
  } catch (error) {
    logger.error("Error sending email with Gmail:", error);
  }

  return null;
});

// ==========================================
// Tägliche Füllstandsprüfung mit On/Off-Schalter & Ausfall-Erkennung
// ==========================================
exports.checkDailyPelletLevel = onSchedule({
  schedule: "0 8 */2 * *", // Läuft jeden 2. Tag um 08:00 Uhr
  secrets: ["GMAIL_USER", "GMAIL_PASS"],
}, async (event) => {
  try {
    // 1. Prüfen, ob die Überwachung in Firestore aktiviert ist
    const settingsRef = db.collection("metadata").doc("settings");
    const settingsDoc = await settingsRef.get();

    const isEnabled = settingsDoc.exists ? settingsDoc.data().levelCheckEnabled !== false : true;

    if (!isEnabled) {
      logger.info("Tägliche Füllstandsprüfung ist in den Einstellungen deaktiviert (OFF).");
      return null;
    }

    // 2. Die allerletzte (neueste) Messung aus Firestore abrufen
    const measurementsSnapshot = await db.collection("measurements")
        .orderBy("timestamp", "desc")
        .limit(1)
        .get();

    if (measurementsSnapshot.empty) {
      logger.info("Keine Messungen gefunden für die Füllstandsprüfung.");
      return null;
    }

    const latestMeasurement = measurementsSnapshot.docs[0].data();
    const distance = latestMeasurement.distance;
    const measurementTimestamp = Number(latestMeasurement.timestamp); // Unix-Timestamp (Sekunden oder Millisekunden)

    // E-Mail Empfänger für den Notfall vorbereiten
    const listUsersResult = await getAuth().listUsers();
    const emails = listUsersResult.users.map((user) => user.email).filter(Boolean);

    // ==========================================
    // NEU: Ausfall-Erkennung (Keine Daten seit > 50 Stunden)
    // ==========================================
    const now = Date.now();
    // Prüfen ob timestamp in Sekunden (Unix) oder Millisekunden gespeichert ist
    const timestampMs = measurementTimestamp < 10000000000 ? measurementTimestamp * 1000 : measurementTimestamp;
    const hoursSinceLastMeasurement = (now - timestampMs) / (1000 * 60 * 60);

    // Wenn seit mehr als 50 Stunden (ca. 2 Tage + 2 Std. Puffer) keine Messung kam:
    if (hoursSinceLastMeasurement > 50) {
      const errorTitle = "🚨 Gerät ausgefallen (Keine Daten)!";
      const errorMessage = `Achtung! Das Gerät hat seit über ${Math.round(hoursSinceLastMeasurement)} Stunden keine neuen Messdaten mehr gesendet. Möglicherweise ist das ESP32 offline oder defekt.`;

      if (emails.length > 0) {
        await transporter.sendMail({
          from: `"Pellet System" <${process.env.GMAIL_USER}>`,
          bcc: emails,
          subject: errorTitle,
          text: `Hallo,\n\n${errorMessage}\n\nViele Grüße\nDein Pellet-System`,
        });
        logger.error(`Ausfall-Warnung per E-Mail gesendet. Letzte Messung vor ${Math.round(hoursSinceLastMeasurement)} Stunden.`);
      }

      // Optional in warnings-Collection eintragen
      await db.collection("warnings").add({
        title: errorTitle,
        message: errorMessage,
        hoursSinceLastMeasurement: hoursSinceLastMeasurement,
        timestamp: Date.now(),
      });

      // Wir stoppen hier, da keine gültigen Füllstandsdaten geprüft werden können
      return null;
    }

    // ==========================================
    // Normale Füllstandsprüfung (Distanz > 160 cm)
    // ==========================================
    logger.info(`Gemessene Distanz: ${distance} cm (Schwelle: 160 cm)`);

    if (distance > 160.0) {
      const warningTitle = "⚠️ Pellets-Füllstand niedrig!";
      const warningMessage = `Der Füllstand ist kritisch niedrig. Die gemessene Distanz beträgt ${distance} cm (Grenzwert: 160 cm). Bitte Pellets nachfüllen.`;

      if (emails.length > 0) {
        await transporter.sendMail({
          from: `"Pellet System" <${process.env.GMAIL_USER}>`,
          bcc: emails,
          subject: warningTitle,
          text: `Hallo,\n\n${warningMessage}\n\nViele Grüße\nDein Pellet-System`,
        });
        logger.info(`Füllstand-Warnung per E-Mail an ${emails.length} Benutzer gesendet.`);
      }

      await db.collection("warnings").add({
        title: warningTitle,
        message: warningMessage,
        distance: distance,
        timestamp: Date.now(),
      });
    } else {
      logger.info("Füllstand ist im grünen Bereich. Keine Warnung nötig.");
    }
  } catch (error) {
    logger.error("Fehler bei der täglichen Füllstandsprüfung:", error);
  }

  return null;
});