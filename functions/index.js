const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {logger} = require("firebase-functions");
const {getAuth} = require("firebase-admin/auth");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const nodemailer = require("nodemailer");

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