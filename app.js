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

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_AUTH_DOMAIN",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_STORAGE_BUCKET",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const loginSection = document.getElementById("login-section");
const dashboardSection = document.getElementById("dashboard-section");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const statusText = document.getElementById("status");
const logoutButton = document.getElementById("logout-button");

const chartConfigs = [
  { key: "temperature", label: "Temperatur (°C)", color: "#ef4444", elementId: "temperature-chart" },
  { key: "humidity", label: "Luftfeuchtigkeit (%)", color: "#2563eb", elementId: "humidity-chart" },
  { key: "distance", label: "Abstand (cm)", color: "#16a34a", elementId: "distance-chart" },
];

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
        scales: {
          x: {
            ticks: {
              maxRotation: 45,
              minRotation: 45,
            },
          },
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

  const timestampMeasurementsQuery = query(
    collection(db, "measurements"),
    where("timestamp", ">=", thirtyDaysAgoTimestamp),
    orderBy("timestamp", "asc")
  );
  const numericMeasurementsQuery = query(
    collection(db, "measurements"),
    where("timestamp", ">=", Math.floor(thirtyDaysAgoMillis / 1000)),
    orderBy("timestamp", "asc")
  );
  let snapshot = await getDocs(timestampMeasurementsQuery);
  if (snapshot.empty) {
    snapshot = await getDocs(numericMeasurementsQuery);
  }

  const measurements = snapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        timestamp: data.timestamp,
        temperature: Number(data.temperature),
        humidity: Number(data.humidity),
        distance: Number(data.distance),
      };
    })
    .filter(
      (item) =>
        Number.isFinite(normalizeTimestampToMillis(item.timestamp)) &&
        Number.isFinite(item.temperature) &&
        Number.isFinite(item.humidity) &&
        Number.isFinite(item.distance)
    );

  if (!measurements.length) {
    statusText.textContent = "Keine Messwerte in den letzten 30 Tagen gefunden.";
    destroyCharts();
    return;
  }

  statusText.textContent = `${measurements.length} Messwerte geladen.`;
  renderCharts(measurements);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    loginError.textContent = "Login fehlgeschlagen. Bitte Zugangsdaten prüfen.";
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
