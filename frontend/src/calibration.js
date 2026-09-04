// Gemessene Maschinenkonstanten - Epilog Fusion ("Edgar", 60 W).
//
// Quelle: 55 Kalibrierdateien / 72 Läufe. Fit-Skript und Rohdaten:
// docs/calib/fit_model.py, Auswertung: docs/CALIBRATION.md.
//
// ZIELGRÖSSE ist die Zeit, die die Maschine TATSÄCHLICH braucht. Wo eine
// gestoppte Zeit vorliegt, ist sie das Ziel; sonst dient die angezeigte
// Schätzung des Job Managers als Stellvertreter. Bisher sind erst vier Läufe
// gestoppt, die Konstanten hängen also praktisch noch an der Anzeige - und die
// beiden weichen voneinander ab, siehe CALIBRATION.md Abschnitt 5, Punkt 1.
//
// Das Modell trifft beide Spalten (optimiert + unoptimiert) gleichzeitig auf
// Ø 0,55 % / Median 0,30 % / max 4,2 % über n = 134 Läufe.
//
// George (120 W) ist baugleich; die Zeitschätzung ist rein kinematisch und
// hängt nicht an der Laserleistung. Bis Stichproben vorliegen: gleiche Werte.

export const CALIBRATION = {
  // ── Vektor (Schnitt + Vektorgravur) ────────────────────────────────────────
  vectorMaxSpeed: 255,     // mm/s bei 100 % - Speed-% skaliert linear
  vectorAccel:    2753,    // mm/s²

  // Zuschlag je Ecke, an der die Maschine wirklich auf 0 abbremst. Rein
  // kinematisch (v/a) wäre die Ecke zu billig; dieser Term ist der zusätzliche
  // konstante Aufwand je Stopp.
  cornerPenalty:  0.0222,  // s

  // Knick, ab dem eine Ecke als "echte" Ecke zählt. Darunter fährt die Maschine
  // durch. Direkt gemessen mit der Serie 45-49 (identische Länge und Eckenzahl,
  // nur der Knickwinkel variiert): 8°/14°/20°/26° kosten optimiert alle 139 s,
  // 32° springt auf 154 s. Zusammen mit 15_polygon_12 (30°-Ecken, wird berechnet)
  // liegt die Schwelle zwischen 26° und 30°; der Fit ist über 27°-31° exakt
  // gleich gut und verschlechtert sich außerhalb deutlich (max. Fehler 3,2 % →
  // 7-10 %). 28° liegt mittig im Plateau.
  cornerAngleDeg: 28,

  // ── Leerfahrten ────────────────────────────────────────────────────────────
  // 250 mm/s ist mit einer Zeitlupenkamera an der Maschine gemessen (Vincent),
  // nicht gefittet. Der Leerweg läuft KONSTANT mit diesem Wert, er skaliert
  // nicht mit der Speed-Einstellung des Jobs.
  travelSpeed: 250,        // mm/s, konstant

  // Startaufwand je separatem Vektor (Pause zwischen zwei Konturen).
  // 44_vecstart_stack (200 getrennte 1-mm-Striche, Leerweg ~0) misst diesen
  // Term praktisch isoliert.
  vectorStartPenalty: 0.0356,  // s

  // Rückweg zum Ursprung. Die Anzeige der Maschine enthält ihn: 42_home_near und
  // 43_home_far sind dasselbe 20-mm-Quadrat, einmal in der Startecke (5 s) und
  // einmal in der Gegenecke (13 s). Die Differenz von 8 s entspricht ZWEIMAL
  // ~1080 mm bei 250 mm/s (8,6 s), nicht einmal (4,3 s). Über alle 134 Läufe:
  // mit Rückweg Ø 0,51 %, ohne Ø 1,18 % (max 4,1 % gegen 6,0 %).
  returnToHome: true,

  // ── Raster (Gravur) ────────────────────────────────────────────────────────
  // Zeit je Scanzeile = rasterLineOverhead(v) + span / v_raster
  // span = Spannweite (linkester..rechtester Punkt) DIESER Zeile.
  //
  // Der Zeilen-Overhead ist NICHT konstant: er hat einen festen Anteil und einen,
  // der linear mit der Rastergeschwindigkeit wächst (die Wendeschleife am
  // Zeilenende). Über 10-40 % fällt das kaum auf - erst die neuen Läufe bei
  // 60/80/100 % trennen die beiden Anteile.
  rasterLineBase: 0.0792,      // s je Scanzeile, geschwindigkeitsunabhängig
  rasterLineRamp: 1.3382e-5,   // s je (mm/s) Rastergeschwindigkeit

  // Zusätzlicher Y-Vorschub, proportional zur tatsächlich gescannten Höhe und
  // unabhängig von der Auflösung. Trennt sich von rasterLineBase nur über den
  // DPI-Sweep; jetzt bei zwei Gravurhöhen bestätigt (80 mm über 300/600/1200 dpi
  // und 40 mm über 300/600/1200 dpi).
  rasterYFeed: 0.2882,     // s je mm gescannter Höhe

  // ── Global ─────────────────────────────────────────────────────────────────
  jobOverhead: 0.650,      // s je Job (Homing/Start)

  // Leistung (Power) hat keinen Einfluss auf die Zeit - messtechnisch bestätigt.
}

// Zeilen-Overhead bei Rastergeschwindigkeit v (mm/s).
export function rasterLineOverhead(v) {
  return CALIBRATION.rasterLineBase + CALIBRATION.rasterLineRamp * v
}

// Raster-Geschwindigkeit über Speed-%.
//
// WICHTIG: Raster und Vektor haben VERSCHIEDENE Geschwindigkeitsskalen - Raster
// ist bei 100 % rund 7× schneller. Raster-% gegen die Vektor-maxSpeed zu rechnen
// ist grob falsch.
//
// Gemessene Stützstellen. 10-80 % stammen aus 33_rast_ref_80x80 (600 dpi),
// 100 % zusätzlich aus dem Paar 54_rast_overscan / 55_rast_speed: zwei Balken
// gleicher Höhe (25,4 mm, 200 dpi, 100 %) mit 1 mm bzw. 1000 mm Spannweite,
// 29 s gegen 139 s. Die Differenz von 110 s auf 200 Zeilen × 999 mm ergibt
// 1816 mm/s DIREKT - unabhängig von jedem Overhead-Term, weil der sich
// heraushebt. Das ist der belastbarste Punkt der ganzen Tabelle.
const RASTER_SPEED_TABLE = [
  [10, 155],
  [20, 357],
  [40, 777],
  [60, 1078],
  [80, 1150],
  [100, 1820],
]

// EINSCHRÄNKUNG bei 60 % und 80 %: dort wurde nur EINE Spannweite (80 mm)
// gemessen, deshalb lassen sich Zeilen-Overhead und Geschwindigkeit an diesen
// beiden Punkten nicht sauber trennen - nur ihre Summe für span = 80 mm ist
// belegt. Die angezeigte Zeit der Referenzdatei trifft das Modell dort exakt,
// für deutlich breitere Gravuren bei 60/80 % ist mit ~10 % Unsicherheit zu
// rechnen. Auflösen ließe sich das mit 55_rast_speed bei 60 % und 80 %
// (2 Läufe) - siehe docs/CALIBRATION.md, Abschnitt 4.
export function rasterSpeedForPct(pct) {
  const t = RASTER_SPEED_TABLE
  if (pct <= t[0][0]) return (pct / t[0][0]) * t[0][1]           // unter 10 %: proportional
  for (let i = 0; i < t.length - 1; i++) {
    const [x0, y0] = t[i], [x1, y1] = t[i + 1]
    if (pct <= x1) return y0 + ((pct - x0) / (x1 - x0)) * (y1 - y0)
  }
  return t[t.length - 1][1]   // 100 % ist das Maximum der Skala
}

// Umkehrung von rasterSpeedForPct: mm/s -> Speed-%. Gebraucht wird sie nur für
// Presets, die ihre Rastergeschwindigkeit in mm/s statt in % angeben - dann
// muss sich der Wert zurück auf die Prozentskala abbilden lassen, damit das
// Custom-Feld denselben Job beschreibt wie das Preset. Die Tabelle ist monoton
// steigend, die stückweise lineare Umkehrung also eindeutig.
export function rasterPctForSpeed(v) {
  const t = RASTER_SPEED_TABLE
  if (!(v > 0)) return 0
  if (v <= t[0][1]) return (v / t[0][1]) * t[0][0]               // unter 10 %: proportional
  for (let i = 0; i < t.length - 1; i++) {
    const [x0, y0] = t[i], [x1, y1] = t[i + 1]
    if (v <= y1) return x0 + ((v - y0) / (y1 - y0)) * (x1 - x0)
  }
  return t[t.length - 1][0]   // oberhalb der Tabelle: bei 100 % deckeln
}
