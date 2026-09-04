"""
DAT -> printer XML / CSV converter.

Reads Epilog Fusion material preset files (*.DAT) and turns a whole presets
folder into ONE self-contained printer XML in the schema the laser app consumes
(backend/printers/<id>.xml, loaded via GET /api/printers + frontend profiles.js).

Colour channels map to operations the way the rest of the project does:
    blue  -> cut          red -> engrave (vector)        green -> raster
speed/power are stored as % (of the printer's maxSpeed / power); the raster
operation also carries the dpi read from the file.

Run with no arguments for the GUI, or `python program.py --build` to regenerate
every "Presets <Name>" folder next to this script headlessly.
"""

import os
import re
import sys
import csv
import glob
import struct
import xml.etree.ElementTree as ET
from xml.dom import minidom

# ── DAT layout (Epilog Fusion preset, 3156 bytes) ─────────────────────────────
# Verified against the exported CSVs. Each colour has a (power, speed, freq) byte
# triple; values are 0-100 (%). DPI is a uint16 LE at 0x5A (the old 0x5C4 byte is
# always 1 - that was a bug). The file also embeds its own name as UTF-16 near
# 0x114, but we just use the OS filename.
DPI_OFFSET = 0x5A
COLOR_OFFSETS = {          # (power, speed, freq)
    "cut":     (0x5B3, 0x5B4, 0x5B8),   # blue
    "engrave": (0x563, 0x564, 0x568),   # red  (vector engrave)
    "raster":  (0x58B, 0x58C, 0x590),   # green
}


def read_dat(path):
    """Read one .DAT preset -> {dpi, cut:{...}, engrave:{...}, raster:{...}}."""
    with open(path, "rb") as f:
        data = f.read()

    def op(power_off, speed_off, freq_off):
        return {"speed": data[speed_off], "power": data[power_off], "freq": data[freq_off]}

    ops = {name: op(*offs) for name, offs in COLOR_OFFSETS.items()}
    ops["dpi"] = struct.unpack_from("<H", data, DPI_OFFSET)[0]
    return ops


# ── Filename -> (material family, thickness label) ────────────────────────────
# "Acryl_3_0mm" -> ("Acryl", "3.0 mm"); "Finnpappe_2mm" -> ("Finnpappe", "2 mm");
# "Bristol_0_25mm" -> ("Bristol", "0.25 mm"). Names without a trailing mm token
# (e.g. "Glas", "Papier 160g") become their own single-thickness family.
_THICK_RE = re.compile(r"^(.*?)[_ ](\d+)(?:[_,](\d+))?\s*mm$", re.IGNORECASE)


def split_name(stem):
    m = _THICK_RE.match(stem)
    if not m:
        return stem.replace("_", " ").strip(), None
    family = m.group(1).replace("_", " ").strip()
    whole, frac = m.group(2), m.group(3)
    thickness = f"{whole}.{frac} mm" if frac else f"{whole} mm"
    return (family or stem), thickness


def list_dats(folder):
    """*.DAT paths, de-duplicated (Windows glob is case-insensitive, so matching
    both *.DAT and *.dat would otherwise list every file twice)."""
    seen = {}
    for pat in ("*.DAT", "*.dat"):
        for p in glob.glob(os.path.join(folder, pat)):
            seen[os.path.normcase(os.path.abspath(p))] = p
    return sorted(seen.values(), key=str.lower)


def _thickness_sort_key(label):
    """Sort thicknesses numerically (the ones without a number go last)."""
    if not label:
        return (1, 0.0)
    m = re.match(r"\s*(\d+(?:\.\d+)?)", label)
    return (0, float(m.group(1))) if m else (1, 0.0)


# ── Printer metadata (not in the .DAT - reused from an existing XML) ───────────
META_KEYS = ("id", "name", "powerW", "bedWidth", "bedHeight", "maxSpeed", "accel")


def load_meta(existing_xml, default_name):
    """Defaults for a new printer, overridden by an existing <printer> XML so the
    hand-tuned bed size / accel / power survive a regenerate."""
    meta = {
        "id": default_name.lower(), "name": default_name, "powerW": "60",
        "bedWidth": "1000", "bedHeight": "700", "maxSpeed": "255", "accel": "2753",
    }
    if existing_xml and os.path.exists(existing_xml):
        try:
            root = ET.parse(existing_xml).getroot()
            for k in META_KEYS:
                if root.get(k) is not None:
                    meta[k] = root.get(k)
        except Exception as e:
            print(f"[meta] could not read {existing_xml}: {e}")
    return meta


# ── Build the printer XML ─────────────────────────────────────────────────────
def _add_op(thickness_el, tag, vals, dpi=None):
    attrib = {"speed": str(vals["speed"]), "unit": "%", "power": str(vals["power"])}
    if vals.get("freq") is not None:
        attrib["freq"] = str(vals["freq"])        # informational (unused by the app)
    if dpi:
        attrib["dpi"] = str(dpi)                    # raster only
    ET.SubElement(thickness_el, tag, attrib)


def build_printer(folder, meta):
    """Return (xml_root, preset_count) for every *.DAT in `folder`."""
    paths = list_dats(folder)

    families = {}   # family name -> list of (thickness_label, stem, data)
    for path in paths:
        stem = os.path.splitext(os.path.basename(path))[0]
        family, thickness = split_name(stem)
        families.setdefault(family, []).append((thickness, stem, read_dat(path)))

    root = ET.Element("printer", {k: meta[k] for k in META_KEYS})
    materials = ET.SubElement(root, "materials")
    for family in sorted(families, key=str.lower):
        mat = ET.SubElement(materials, "material", {"name": family})
        for thickness, stem, data in sorted(families[family],
                                            key=lambda it: _thickness_sort_key(it[0])):
            th = ET.SubElement(mat, "thickness", {"value": thickness or family, "id": stem})
            _add_op(th, "cut", data["cut"])
            _add_op(th, "engrave", data["engrave"])
            _add_op(th, "raster", data["raster"], dpi=data["dpi"])
    return root, len(paths)


def serialize(root, source_folder):
    pretty = minidom.parseString(ET.tostring(root, "utf-8")).toprettyxml(indent="  ")
    lines = [ln for ln in pretty.split("\n") if ln.strip()]
    comment = (
        "<!--\n"
        f"  AUTO-GENERATED by Converter.py from the Epilog .DAT presets in\n"
        f'  "{os.path.basename(source_folder.rstrip(os.sep))}". Re-running overwrites this file\n'
        "  (the <printer> attributes are preserved from the previous version).\n"
        "  Colours -> operations: blue=cut, red=engrave (vector), green=raster.\n"
        "  speed/power are % of the printer maxSpeed/power; raster carries dpi.\n"
        "-->"
    )
    return lines[0] + "\n" + comment + "\n" + "\n".join(lines[1:]) + "\n"


def printer_name_from_folder(folder):
    """'Presets Edgar' -> 'Edgar' (fall back to the folder name itself)."""
    base = os.path.basename(folder.rstrip("/\\"))
    name = re.sub(r"^presets\s*", "", base, flags=re.IGNORECASE).strip()
    return name or base


def convert_folder_to_xml(folder):
    """Build <id>.xml in the folder's PARENT dir; reuse existing metadata. Returns
    (output_path, preset_count)."""
    parent = os.path.dirname(folder.rstrip("/\\")) or "."
    name = printer_name_from_folder(folder)
    existing = os.path.join(parent, name.lower() + ".xml")
    meta = load_meta(existing, name)
    root, count = build_printer(folder, meta)
    out_path = os.path.join(parent, meta["id"] + ".xml")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(serialize(root, folder))
    return out_path, count


def convert_folder_to_csv(folder, out_file):
    paths = list_dats(folder)
    with open(out_file, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["Profil", "DPI",
                    "Cut Speed", "Cut Power", "Cut Freq", "",
                    "Engrave Speed", "Engrave Power", "Engrave Freq", "",
                    "Raster Speed", "Raster Power", "Raster Freq"])
        for path in paths:
            d = read_dat(path)
            c, e, r = d["cut"], d["engrave"], d["raster"]
            w.writerow([os.path.splitext(os.path.basename(path))[0], d["dpi"],
                        c["speed"], c["power"], c["freq"], "",
                        e["speed"], e["power"], e["freq"], "",
                        r["speed"], r["power"], r["freq"]])
    return len(paths)


def find_preset_folders(base):
    return sorted(p for p in glob.glob(os.path.join(base, "Presets *")) if os.path.isdir(p))


# ── CLI ───────────────────────────────────────────────────────────────────────
def build_all(base):
    folders = find_preset_folders(base)
    if not folders:
        print(f"No 'Presets *' folders found in {base}")
        return
    for folder in folders:
        out, n = convert_folder_to_xml(folder)
        print(f"  {os.path.basename(folder)} -> {os.path.basename(out)}  ({n} presets)")


# ── GUI ───────────────────────────────────────────────────────────────────────
def run_gui():
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
    from tkinter import font as tkfont

    # Make the window DPI-aware so Tk renders crisply on scaled displays instead
    # of being bitmap-stretched (the "blurry" look).
    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        try:
            from ctypes import windll
            windll.user32.SetProcessDPIAware()
        except Exception:
            pass

    here = os.path.dirname(os.path.abspath(__file__))

    # ── tiny hover tooltip ────────────────────────────────────────────────────
    class Tooltip:
        def __init__(self, widget, text):
            self.widget, self.text, self.tip = widget, text, None
            widget.bind("<Enter>", self._show, add="+")
            widget.bind("<Leave>", self._hide, add="+")

        def _show(self, _=None):
            if self.tip or not self.text:
                return
            x = self.widget.winfo_rootx() + 16
            y = self.widget.winfo_rooty() + self.widget.winfo_height() + 6
            self.tip = tk.Toplevel(self.widget)
            self.tip.wm_overrideredirect(True)
            self.tip.wm_geometry(f"+{x}+{y}")
            tk.Label(self.tip, text=self.text, justify="left", bg="#2b2f36",
                     fg="#f0f1f3", relief="solid", bd=0, padx=9, pady=6,
                     font=("Segoe UI", 9), wraplength=360).pack()

        def _hide(self, _=None):
            if self.tip:
                self.tip.destroy()
                self.tip = None

    # ── light palette (one coherent theme) ────────────────────────────────────
    BG, TEXT, MUTED, BORDER = "#ffffff", "#1f2933", "#6b7280", "#dfe3e8"
    ACCENT, ACCENT_D, BTN, BTN_H = "#00adc6", "#0093a8", "#eef1f4", "#e2e6ea"

    # ── rounded button (Canvas - ttk can't round corners) ─────────────────────
    class RoundButton(tk.Canvas):
        def __init__(self, parent, text, command, *, base, hover, fg,
                     font=("Segoe UI", 10), radius=11, padx=18, pady=9, height=None):
            self._base, self._hover, self._cur = base, hover, base
            self._fg, self._font, self._radius = fg, font, radius
            self._text, self._command = text, command
            f = tkfont.Font(font=font)
            super().__init__(parent, bg=BG, highlightthickness=0, bd=0, takefocus=0,
                             width=f.measure(text) + 2 * padx,
                             height=height if height is not None else f.metrics("linespace") + 2 * pady,
                             cursor="hand2")
            self.bind("<Configure>", self._draw)
            self.bind("<Enter>", lambda e: self._recolor(self._hover))
            self.bind("<Leave>", lambda e: self._recolor(self._base))
            self.bind("<ButtonRelease-1>", lambda e: self._command and self._command())

        def _draw(self, _=None):
            self.delete("all")
            w, h = self.winfo_width(), self.winfo_height()
            r = max(0, min(self._radius, w / 2, h / 2))
            pts = [r, 0, w - r, 0, w, 0, w, r, w, h - r, w, h,
                   w - r, h, r, h, 0, h, 0, h - r, 0, r, 0, 0]
            self.create_polygon(pts, smooth=True, fill=self._cur, outline="")
            self.create_text(w / 2, h / 2, text=self._text, fill=self._fg, font=self._font)

        def _recolor(self, color):
            self._cur = color
            self._draw()

    root = tk.Tk()
    root.title("Preset Converter")
    root.configure(bg=BG)
    try:   # size points to the real screen DPI so fonts aren't tiny/huge
        root.tk.call("tk", "scaling", root.winfo_fpixels("1i") / 72.0)
    except Exception:
        pass

    style = ttk.Style()
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass
    style.configure(".", background=BG, foreground=TEXT, font=("Segoe UI", 10))
    style.configure("TFrame", background=BG)
    style.configure("Title.TLabel", background=BG, foreground=TEXT, font=("Segoe UI", 12, "bold"))
    style.configure("Desc.TLabel", background=BG, foreground=MUTED, font=("Segoe UI", 9))
    style.configure("Status.TLabel", background="#f0f2f4", foreground=MUTED,
                    font=("Segoe UI", 9), padding=(12, 6))
    style.configure("TSeparator", background=BORDER)

    status = tk.StringVar(value="Bereit.")
    def set_status(msg):
        status.set(msg)

    ttk.Label(root, textvariable=status, style="Status.TLabel", anchor="w").pack(fill="x", side="bottom")

    body = ttk.Frame(root, padding=24)
    body.pack(fill="both", expand=True)

    def section(title):
        ttk.Label(body, text=title, style="Title.TLabel").pack(anchor="w")

    def desc(text):
        ttk.Label(body, text=text, style="Desc.TLabel", wraplength=690,
                  justify="left").pack(anchor="w", pady=(2, 10))

    # 1 · rebuild all (the normal case)
    section("Alle Drucker neu erstellen")
    desc("Liest jeden „Presets …“-Ordner neben dieser Datei und schreibt die fertige "
         "Drucker-XML (z. B. edgar.xml, george.xml). Der Normalfall.")
    b_all = RoundButton(body, "Alle neu erstellen", lambda: rebuild_all(),
                        base=ACCENT, hover=ACCENT_D, fg="#ffffff",
                        font=("Segoe UI", 10, "bold"), radius=13, padx=22, pady=11)
    b_all.pack(anchor="w")
    Tooltip(b_all, "Sucht alle 'Presets *'-Ordner und erzeugt pro Ordner eine <name>.xml.\n"
                   "Vorhandene Drucker-Einstellungen (Bettgröße, Geschwindigkeit, "
                   "Beschleunigung) bleiben erhalten.")

    ttk.Separator(body).pack(fill="x", pady=18)

    # 2 · single folder
    section("Einzelnen Ordner exportieren")
    desc("Einen bestimmten Presets-Ordner gezielt umwandeln - als Drucker-XML oder als "
         "Tabelle (CSV) zum Nachschauen.")
    row2 = ttk.Frame(body)
    row2.pack(anchor="w")
    b_xml = RoundButton(row2, "Ordner → Drucker-XML", lambda: to_xml(),
                        base=BTN, hover=BTN_H, fg=TEXT)
    b_xml.pack(side="left", padx=(0, 8))
    Tooltip(b_xml, "Ordner wählen → schreibt <name>.xml in den übergeordneten Ordner.\n"
                   "Metadaten aus einer vorhandenen XML werden übernommen.")
    b_csv = RoundButton(row2, "Ordner → CSV", lambda: to_csv(), base=BTN, hover=BTN_H, fg=TEXT)
    b_csv.pack(side="left")
    Tooltip(b_csv, "Ordner wählen → speichert alle Werte (DPI, Speed/Power/Freq je "
                   "Cut/Engrave/Raster) als CSV-Tabelle.")

    ttk.Separator(body).pack(fill="x", pady=18)

    # 3 · inspect a single DAT
    section("Einzelne DAT prüfen")
    desc("Eine .DAT-Datei wählen und die ausgelesenen Werte kontrollieren.")
    rowp = ttk.Frame(body)
    rowp.pack(fill="x")
    rowp.columnconfigure(0, weight=1)
    # Shared height so the path field and the browse button line up exactly.
    field_font = tkfont.Font(font=("Segoe UI", 10))
    FIELD_H = field_font.metrics("linespace") + 18
    input_entry = tk.Entry(rowp, font=("Segoe UI", 10), relief="flat", bg="#f5f7f9", fg=TEXT,
                           bd=0, highlightthickness=1, highlightbackground=BORDER, highlightcolor=ACCENT)
    input_entry.grid(row=0, column=0, sticky="ew", ipady=8, padx=(0, 8))
    Tooltip(input_entry, "Pfad zu einer .DAT-Datei - die Vorschau erscheint darunter.")
    b_browse = RoundButton(rowp, "Durchsuchen…", lambda: select_input(),
                           base=BTN, hover=BTN_H, fg=TEXT, height=FIELD_H)
    b_browse.grid(row=0, column=1)
    Tooltip(b_browse, "Eine .DAT-Datei wählen, um die ausgelesenen Werte zu prüfen.")

    preview = tk.Text(body, width=10, height=7, relief="flat", bg="#f5f7f9", fg=TEXT,
                      font=("Consolas", 11), padx=12, pady=10, state="disabled",
                      highlightthickness=1, highlightbackground=BORDER, highlightcolor=BORDER)
    preview.pack(fill="both", expand=True, pady=(10, 0))

    def set_preview(text):
        preview.config(state="normal")
        preview.delete("1.0", tk.END)
        preview.insert("1.0", text)
        preview.config(state="disabled")

    set_preview("Noch keine Datei geladen.")

    # ── actions ───────────────────────────────────────────────────────────────
    def select_input():
        p = filedialog.askopenfilename(title="DAT-Datei wählen",
                                       filetypes=[("DAT files", "*.dat *.DAT"), ("Alle Dateien", "*.*")])
        if not p:
            return
        input_entry.delete(0, tk.END)
        input_entry.insert(0, p)
        do_preview()

    def do_preview():
        try:
            d = read_dat(input_entry.get())
            c, e, r = d["cut"], d["engrave"], d["raster"]
            set_preview(
                f"DPI (Raster): {d['dpi']}\n\n"
                f"CUT     (blau)   Speed {c['speed']:>3}%   Power {c['power']:>3}%   Freq {c['freq']}\n"
                f"ENGRAVE (rot)    Speed {e['speed']:>3}%   Power {e['power']:>3}%   Freq {e['freq']}\n"
                f"RASTER  (grün)   Speed {r['speed']:>3}%   Power {r['power']:>3}%   Freq {r['freq']}"
            )
            set_status(f"Vorschau: {os.path.basename(input_entry.get())}")
        except Exception as ex:
            set_preview("Konnte die Datei nicht lesen.")
            set_status(f"Fehler: {ex}")
            messagebox.showerror("Fehler", str(ex))

    def to_xml():
        folder = filedialog.askdirectory(title="Presets-Ordner wählen (z. B. 'Presets Edgar')")
        if not folder:
            return
        try:
            out, n = convert_folder_to_xml(folder)
            set_status(f"{n} Presets → {os.path.basename(out)}")
            messagebox.showinfo("Fertig", f"{n} Presets exportiert nach:\n{out}")
        except Exception as ex:
            set_status(f"Fehler: {ex}")
            messagebox.showerror("Fehler", str(ex))

    def to_csv():
        folder = filedialog.askdirectory(title="Presets-Ordner wählen")
        if not folder:
            return
        out = filedialog.asksaveasfilename(defaultextension=".csv",
                                           filetypes=[("CSV files", "*.csv")],
                                           initialfile=printer_name_from_folder(folder) + ".csv")
        if not out:
            return
        try:
            n = convert_folder_to_csv(folder, out)
            set_status(f"{n} Presets → {os.path.basename(out)}")
            messagebox.showinfo("Fertig", f"{n} Presets als CSV gespeichert:\n{out}")
        except Exception as ex:
            set_status(f"Fehler: {ex}")
            messagebox.showerror("Fehler", str(ex))

    def rebuild_all():
        folders = find_preset_folders(here)
        if not folders:
            set_status("Keine 'Presets *'-Ordner gefunden.")
            messagebox.showwarning("Keine Ordner",
                                   "Keine 'Presets *'-Ordner neben Converter.py gefunden.")
            return
        try:
            lines = []
            for folder in folders:
                out, n = convert_folder_to_xml(folder)
                lines.append(f"• {os.path.basename(folder)}  →  {os.path.basename(out)}  ({n})")
            set_status(f"{len(folders)} Drucker-XML neu erstellt.")
            messagebox.showinfo("Fertig", "Neu erstellt:\n\n" + "\n".join(lines))
        except Exception as ex:
            set_status(f"Fehler: {ex}")
            messagebox.showerror("Fehler", str(ex))

    # Size the window so everything (incl. all preview lines) is visible by
    # default, at any DPI.
    root.update_idletasks()
    root.geometry(f"{max(720, root.winfo_reqwidth())}x{root.winfo_reqheight()}")
    root.minsize(620, 520)

    root.mainloop()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ("--build", "-b"):
        target = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__))
        build_all(target)
    else:
        run_gui()
