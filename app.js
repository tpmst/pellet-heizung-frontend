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
const latestInfoText = document.getElementById("latest-info");

// Chart configurations
const chartConfigs = [
  { key: "volume", label: "Restvolumen (m³)", color: "#d97706", elementId: "volume-chart" },
  { key: "distance", label: "Restfüllhöhe (cm)", color: "#16a34a", elementId: "distance-chart" },
  { key: "temperature", label: "Temperatur (°C)", color: "#ef4444", elementId: "temperature-chart" },
  { key: "humidity", label: "Luftfeuchtigkeit (%)", color: "#2563eb", elementId: "humidity-chart" },
];

// Room calculation constants
const ROOM_LENGTH = 4.13; // meters
const ROOM_WIDTH = 2.15;  // meters
const TOTAL_HEIGHT_CM = 187; // cm
const SENSOR_OFFSET_CM = 28; // cm to remove
const FLOOR_AREA = ROOM_LENGTH * ROOM_WIDTH; // 8.8795 m²
const chartInstances = new Map();

// DOM-Referenzen für Heizung
const heatingStatusSection = document.getElementById("heating-status-section");
const heatingTimestampText = document.getElementById("heating-timestamp");
const valIstAn = document.getElementById("val-ist-an");
const valAsche = document.getElementById("val-asche");
const valMenge = document.getElementById("val-menge");
const heatingErrorsList = document.getElementById("heating-errors-list");

// Hilfsfunktion: Parst einen ETA-XML-String und gibt den 'strValue' oder Text aus
function parseEtaXml(xmlString) {
  if (!xmlString) return "-";
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "text/xml");
    
    const valueEl = xmlDoc.querySelector("value");
    if (valueEl) {
      const strVal = valueEl.getAttribute("strValue");
      const unit = valueEl.getAttribute("unit") || "";
      const innerText = valueEl.textContent || "";
      
      if (strVal) {
        return unit ? `${strVal} ${unit}` : strVal;
      }
      return innerText;
    }
    
    const fubEls = xmlDoc.querySelectorAll("fub");
    if (fubEls.length > 0) {
      const names = Array.from(fubEls).map(el => el.getAttribute("name")).filter(Boolean);
      return `Systeme: ${names.join(", ")}`;
    }
  } catch (e) {
    console.error("Fehler beim Parsen des XML:", e);
  }
  return "-";
}

// Hilfsfunktion: Sucht nach Attributen mit msg="..." im XML (für Fehler)
function parseEtaErrors(xmlString) {
  if (!xmlString) return [];
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "text/xml");
    const errors = [];

    const elementsWithMsg = xmlDoc.querySelectorAll("[msg]");
    elementsWithMsg.forEach(el => {
      const msgText = el.getAttribute("msg");
      if (msgText && msgText.trim() !== "") {
        errors.push(msgText);
      }
    });

    return errors;
  } catch (e) {
    console.error("Fehler beim Parsen der XML-Fehler:", e);
    return [];
  }
}

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
          legend: { labels: { color: chartTextColor } }
        },
        scales: {
          x: {
            ticks: { color: chartTextColor, maxRotation: 45, minRotation: 45 },
            grid: { color: chartGridColor }
          },
          y: {
            ticks: { color: chartTextColor },
            grid: { color: chartGridColor }
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
    latestInfoText.textContent = "";
    destroyCharts();
    return;
  }

  const allMeasurements = snapshot.docs
    .map((doc) => {
      const data = doc.data();
      const rawDistance = Number(data.distance);
      
      const effectiveDistance = rawDistance + SENSOR_OFFSET_CM;
      const pelletHeightCm = Math.max(0, Math.min(TOTAL_HEIGHT_CM, TOTAL_HEIGHT_CM - effectiveDistance));
      const volumeM3 = Number((FLOOR_AREA * (pelletHeightCm / 100)).toFixed(2));

      return {
        timestamp: data.timestamp,
        temperature: Number(data.temperature),
        humidity: Number(data.humidity),
        distance: pelletHeightCm,
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
    latestInfoText.textContent = "";
    destroyCharts();
    return;
  }

  allMeasurements.sort((a, b) => normalizeTimestampToMillis(b.timestamp) - normalizeTimestampToMillis(a.timestamp));

  const latestMeasurement = allMeasurements[0];
  lastUpdateText.textContent = `Letzte Messung: ${timestampToLabel(latestMeasurement.timestamp)}`;
  latestInfoText.textContent = `Aktuelles Restvolumen: ${latestMeasurement.volume} m³ | Temperatur: ${latestMeasurement.temperature} °C | Luftfeuchtigkeit: ${latestMeasurement.humidity} %`;

  const chartMeasurements = allMeasurements.slice(0, 30).reverse();

  statusText.textContent = `${chartMeasurements.length} Messwerte geladen.`;
  renderCharts(chartMeasurements);
}

// Funktion zum Laden des aktuellen Heizungsstatus aus der "heizung"-Collection
async function loadHeatingStatus() {
  try {
    const q = query(collection(db, "heizung"), orderBy("timestamp", "desc"));
    const snapshot = await getDocs(q);

    if (!snapshot.empty && heatingStatusSection) {
      const latestHeatingDoc = snapshot.docs[0].data();
      
      heatingStatusSection.classList.remove("hidden");
      
      if (heatingTimestampText) {
        heatingTimestampText.textContent = `Letztes Update der Anlage: ${timestampToLabel(latestHeatingDoc.timestamp)}`;
      }
      
      // ist_an Status
      const isAn = latestHeatingDoc.ist_an;
      if (valIstAn) {
        valIstAn.textContent = isAn === true ? "🟢 An" : "🔴 Aus";
        valIstAn.style.color = isAn === true ? "green" : "red";
      }
      
      // Gesamtmenge auslesen (z.B. "5 kg")
      const mengeText = parseEtaXml(latestHeatingDoc.xml_menge);
      if (valMenge) valMenge.textContent = mengeText;

      // Asche berechnen basierend auf der Menge (ca. 0.5% bis 0.7% Ascheanteil bei Pellets)
      if (valAsche) {
        const rawMengeNum = parseFloat(mengeText); // Extrahiert die Zahl aus "5 kg" -> 5
        if (!isNaN(rawMengeNum) && rawMengeNum > 0) {
          const estimatedAshKg = (rawMengeNum * 0.006).toFixed(2); // ca. 0.6% Aschefaktor
          valAsche.textContent = `ca. ${estimatedAshKg} kg (geschätzt)`; // Fallback falls parsen fehlschlägt: normaler XML-Parser
        } else {
          // Fallback falls parsen fehlschlägt: normaler XML-Parser
          valAsche.textContent = parseEtaXml(latestHeatingDoc.xml_asche);
        }
      }

      // Fehler auslesen (msg="...")
      if (heatingErrorsList) {
        let allErrors = [];
        ["xml_asche", "xml_menge"].forEach(field => {
          if (latestHeatingDoc[field]) {
            const foundErrors = parseEtaErrors(latestHeatingDoc[field]);
            allErrors = allErrors.concat(foundErrors);
          }
        });

        allErrors = [...new Set(allErrors)];
        heatingErrorsList.innerHTML = "";
        if (allErrors.length > 0) {
          allErrors.forEach(err => {
            const li = document.createElement("li");
            li.textContent = err;
            heatingErrorsList.appendChild(li);
          });
        } else {
          const li = document.createElement("li");
          li.textContent = "Keine aktiven Fehler gemeldet.";
          li.style.color = "white";
          heatingErrorsList.appendChild(li);
        }
      }
      
    } else if (heatingStatusSection) {
      heatingStatusSection.classList.add("hidden");
    }
  } catch (error) {
    console.error("Fehler beim Laden des Heizungsstatus:", error);
  }
}

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
    latestInfoText.textContent = "";
    if (heatingStatusSection) heatingStatusSection.classList.add("hidden");
    return;
  }

  setLoginVisible(false);
  setDashboardVisible(true);
  statusText.textContent = "Lade Daten…";

  try {
    await Promise.all([
      loadLast30Days(),
      loadHeatingStatus()
    ]);
  } catch (error) {
    statusText.textContent = "Fehler beim Laden der Daten aus Firestore.";
    console.error(error);
  }
});