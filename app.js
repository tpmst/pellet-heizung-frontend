import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
  getFirestore,
  Timestamp,
  collection,
  getDocs,
  orderBy,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

import { firebaseConfig } from "./config.js";

// --- CONFIGURATION VALIDATION CHECK ---
if (!firebaseConfig || !firebaseConfig.apiKey) {
  console.error("❌ Firebase configuration is missing! Please check your config.js file.");
} else {
  console.log("✅ Firebase configuration loaded successfully for project:", firebaseConfig.projectId);
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const loginSection = document.getElementById("login-section");
const dashboardSection = document.getElementById("dashboard-section");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const statusText = document.getElementById("status");
const logoutButton = document.getElementById("logout-button");
const lastUpdateText = document.getElementById("last-update");

// Chart configurations
const chartConfigs = [
  { key: "volume", label: "Restvolumen (m³)", color: "#d97706", elementId: "volume-chart" },
  { key: "temperature", label: "Temperatur (°C)", color: "#ef4444", elementId: "temperature-chart" },
  { key: "humidity", label: "Luftfeuchtigkeit (%)", color: "#2563eb", elementId: "humidity-chart" },
  { key: "distance", label: "Abstand (cm)", color: "#16a34a", elementId: "distance-chart" },
];

// Room calculation constants
const ROOM_LENGTH = 4.10; // meters
const ROOM_WIDTH = 2.15;  // meters
const TOTAL_HEIGHT_CM = 187; // cm
const SENSOR_OFFSET_CM = 28; // cm to remove
const FLOOR_AREA = ROOM_LENGTH * ROOM_WIDTH; // 8.815 m²
const chartInstances = new Map();

function setLoginVisible(isVisible) {
  loginSection.classList.toggle("hidden", !isVisible);
}

function setDashboardVisible(isVisible) {
  dashboardSection.classList.toggle("hidden", !isVisible);
}

function normalizeTimestampToMillis(value) {
  if (value && typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }

  return NaN;
}

function timestampToLabel(value) {
  const timestampMillis = normalizeTimestampToMillis(value);
  return Number.isFinite(timestampMillis) ? new Date(timestampMillis).toLocaleString("de-DE") : "-";
}

function destroyCharts() {
  for (const chart of chartInstances.values()) {
    chart.destroy();
  }
  chartInstances.clear();
}

function renderCharts(measurements) {
  destroyCharts();

  const labels = measurements.map((item) => timestampToLabel(item.timestamp));

  // Default to light mode (white/dark text) if browser preference isn't explicitly dark
  const isDarkMode = window.matchMedia("(prefers-color-scheme: dark)").matches === true;
  
  const chartTextColor = isDarkMode ? "#e6edf3" : "#1f2933";
  const chartGridColor = isDarkMode ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)";

  for (const config of chartConfigs) {
    const canvas = document.getElementById(config.elementId);
    const values = measurements.map((item) => item[config.key]);

    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: config.label,
            data: values,
            borderColor: config.color,
            backgroundColor: config.color,
            tension: 0.2,
            fill: false,
            pointRadius: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: {
              color: chartTextColor
            }
          }
        },
        scales: {
          x: {
            ticks: {
              color: chartTextColor,
              maxRotation: 45,
              minRotation: 45,
            },
            grid: {
              color: chartGridColor
            }
          },
          y: {
            ticks: {
              color: chartTextColor
            },
            grid: {
              color: chartGridColor
            }
          }
        },
      },
    });

    chartInstances.set(config.key, chart);
  }
}

async function loadLast30Days() {
  const now = Date.now();
  const thirtyDaysAgoMillis = now - 30 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgoTimestamp = Timestamp.fromMillis(thirtyDaysAgoMillis);

  // Daten einmalig aus Firestore abrufen
  const timestampMeasurementsQuery = query(
    collection(db, "measurements"),
    where("timestamp", ">=", thirtyDaysAgoTimestamp)
  );
  const numericMeasurementsQuery = query(
    collection(db, "measurements"),
    where("timestamp", ">=", Math.floor(thirtyDaysAgoMillis / 1000))
  );

  let snapshot = await getDocs(timestampMeasurementsQuery);
  if (snapshot.empty) {
    snapshot = await getDocs(numericMeasurementsQuery);
  }

  if (snapshot.empty) {
    statusText.textContent = "Keine Messwerte in den letzten 30 Tagen gefunden.";
    lastUpdateText.textContent = "";
    destroyCharts();
    return;
  }

  // 1. Daten in eine saubere Liste mappen und filtern
  const allMeasurements = snapshot.docs
    .map((doc) => {
      const data = doc.data();
      const rawDistance = Number(data.distance);
      
      const effectiveDistance = rawDistance + SENSOR_OFFSET_CM;
      const pelletHeightCm = Math.max(0, Math.min(TOTAL_HEIGHT_CM, 215 - effectiveDistance));
      const volumeM3 = Number((FLOOR_AREA * (pelletHeightCm / 100)).toFixed(2));

      return {
        timestamp: data.timestamp,
        temperature: Number(data.temperature),
        humidity: Number(data.humidity),
        distance: rawDistance,
        volume: volumeM3,
      };
    })
    .filter(
      (item) =>
        Number.isFinite(normalizeTimestampToMillis(item.timestamp)) &&
        Number.isFinite(item.temperature) &&
        Number.isFinite(item.humidity) &&
        Number.isFinite(item.distance) &&
        Number.isFinite(item.volume)
    );

  if (!allMeasurements.length) {
    statusText.textContent = "Keine gültigen Messwerte gefunden.";
    lastUpdateText.textContent = "";
    destroyCharts();
    return;
  }

  // 2. Liste nach dem größten (neuesten) Zeitstempel absteigend sortieren
  allMeasurements.sort((a, b) => normalizeTimestampToMillis(b.timestamp) - normalizeTimestampToMillis(a.timestamp));

  // 3. Das erste Element ist garantiert die absolut neueste Messung für den Text ganz oben
  const latestMeasurement = allMeasurements[0];
  lastUpdateText.textContent = `Letzte Messung: ${timestampToLabel(latestMeasurement.timestamp)}`;

  // 4. Die neusten max. 30 Messwerte nehmen und für das Chart chronologisch umdrehen (ältester -> neuester)
  const chartMeasurements = allMeasurements.slice(0, 30).reverse();

  statusText.textContent = `${chartMeasurements.length} Messwerte geladen.`;
  renderCharts(chartMeasurements);
}

// Login form submission handler
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";

  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    loginError.textContent = "Anmeldung fehlgeschlagen. Bitte E-Mail und Passwort prüfen.";
    console.error(error);
  }
});

logoutButton.addEventListener("click", async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    setLoginVisible(true);
    setDashboardVisible(false);
    destroyCharts();
    statusText.textContent = "";
    lastUpdateText.textContent = "";
    return;
  }

  setLoginVisible(false);
  setDashboardVisible(true);
  statusText.textContent = "Lade Daten…";

  try {
    await loadLast30Days();
  } catch (error) {
    statusText.textContent = "Fehler beim Laden der Daten aus Firestore.";
    console.error(error);
  }
});