// Gemessene Maschinenkonstanten — Epilog Fusion ("Edgar", 60 W).
//
// Quelle: 35 Kalibrierdateien / 47 Läufe, abgelesen als GESCHÄTZTE Zeit im
// Epilog Job Manager (jeweils mit und ohne "Optimieren"). Fit-Skript und
// Rohdaten: docs/calib/fit_model.py, Auswertung: docs/CALIBRATION.md.
//
// Das Modell trifft beide Spalten (optimiert + unoptimiert) gleichzeitig auf
// Ø 0,43 % / Median 0,21 % / max 3,6 % über n = 84 Läufe.
//
// George (120 W) ist baugleich; die Zeitschätzung ist rein kinematisch und
// hängt nicht an der Laserleistung. Bis Stichproben vorliegen: gleiche Werte.

export const CALIBRATION = {
  // ── Vektor (Schnitt + Vektorgravur) ────────────────────────────────────────
  vectorMaxSpeed: 252,     // mm/s bei 100 % — Speed-% skaliert linear
  vectorAccel:    2370,    // mm/s²

  // Zuschlag je Ecke, an der die Maschine wirklich auf 0 abbremst. Rein
  // kinematisch (v/a) wäre die Ecke zu billig; dieser Term ist der zusätzliche
  // konstante Aufwand je Stopp.
  cornerPenalty:  0.0197,  // s

  // Knick, ab dem eine Ecke als "echte" Ecke zählt. Darunter fährt die Maschine
  // durch. Die Daten grenzen das nur auf ~10°–30° ein (dazwischen liegt in den
  // Testdateien kein Winkel); 20° liegt mittig im Plateau.
  cornerAngleDeg: 20,

  // ── Leerfahrten ────────────────────────────────────────────────────────────
  // 250 mm/s ist mit einer Zeitlupenkamera an der Maschine gemessen (Vincent),
  // nicht gefittet — und gilt laut dieser Messung gleichermaßen für Schnitt,
  // Vektorgravur und Leerwege. Der Leerweg läuft KONSTANT mit diesem Wert, er
  // skaliert nicht mit der Speed-Einstellung des Jobs.
  travelSpeed: 250,        // mm/s, konstant

  // Startaufwand je separatem Vektor (Pause zwischen zwei Konturen). Fängt genau
  // die Differenz auf, die ein reiner 250-mm/s-Eilgang zu langsam wäre — mit
  // exakt derselben Fitgüte wie ein (unphysikalischer) 437-mm/s-Eilgang, aber
  // physikalisch plausibel und für Jobs mit vielen Einzelkonturen belastbarer.
  vectorStartPenalty: 0.069,  // s

  // ── Raster (Gravur) ────────────────────────────────────────────────────────
  // Zeit je Scanzeile = rasterLineOverhead + span / v_raster
  // span = Spannweite (linkester..rechtester Punkt) DIESER Zeile.
  // Der Overhead ist eine feste ZEIT (nicht ein fester Weg) — er ist über
  // 10/20/40 % Geschwindigkeit konstant geblieben.
  rasterLineOverhead: 0.0873,  // s je Scanzeile

  // Zusätzlicher Y-Vorschub, proportional zur Objekthöhe und unabhängig von der
  // Auflösung. Trennt sich von rasterLineOverhead nur über den DPI-Sweep und ist
  // deshalb bislang nur bei EINER Höhe (80 mm) bestimmt.
  rasterYFeed: 0.2142,     // s je mm Objekthöhe

  // ── Global ─────────────────────────────────────────────────────────────────
  jobOverhead: 0.56,       // s je Job (Homing/Start)

  // Leistung (Power) hat keinen Einfluss auf die Zeit — messtechnisch bestätigt.
}

// Raster-Geschwindigkeit über Speed-%.
//
// WICHTIG: Raster und Vektor haben VERSCHIEDENE Geschwindigkeitsskalen — Raster
// ist rund 7× schneller. Raster-% gegen die Vektor-maxSpeed zu rechnen ist grob
// falsch.
//
// Gemessene Stützstellen (600 dpi):
const RASTER_SPEED_TABLE = [
  [10, 156],
  [20, 357],
  [40, 727],
]

// ACHTUNG — oberhalb 40 % ist die Kurve NICHT gemessen. 77 der ~100
// Material-Presets fahren Raster aber mit 100 %. Bis echte Messwerte vorliegen
// wird HIER GEDECKELT (letzter gemessener Wert, 727 mm/s bei 40 %), NICHT die
// Steigung linear fortgeschrieben: eine unbegrenzte Extrapolation hatte bei
// 100 % ~941 mm/s ergeben, was Vincent zufolge (Kamera-Messung der Kopf-
// geschwindigkeit fürs Schneiden: ~250 mm/s) unglaubwürdig zu schnell wirkt und
// sich direkt im Overscan niederschlug (der bei 100 % dadurch ~45 mm je Seite
// betrug — sichtbar zu breit). Ein Deckel ist die konservativere Annahme:
// er kann nur zu LANGSAM schätzen, nie zu schnell, und verschwindet automatisch
// sobald echte Stützstellen für 60/80/100 % nachgemessen sind (Vorbereitung
// dafür + Anleitung: docs/CALIBRATION.md und ANLEITUNG_NEUE_TESTS.md).
export const RASTER_SPEED_EXTRAPOLATED_ABOVE = 40

export function rasterSpeedForPct(pct) {
  const t = RASTER_SPEED_TABLE
  if (pct <= t[0][0]) return (pct / t[0][0]) * t[0][1]           // unter 10 %: proportional
  for (let i = 0; i < t.length - 1; i++) {
    const [x0, y0] = t[i], [x1, y1] = t[i + 1]
    if (pct <= x1) return y0 + ((pct - x0) / (x1 - x0)) * (y1 - y0)
  }
  return t[t.length - 1][1]   // oberhalb 40 %: am letzten Messwert deckeln, nicht extrapolieren
}
