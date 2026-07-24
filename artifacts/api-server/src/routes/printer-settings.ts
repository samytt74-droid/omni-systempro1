import { Router } from "express";
import { db } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

function getRow() {
  return db.prepare("SELECT * FROM printer_settings WHERE id = 1").get() as {
    id: number;
    paper_width: number;
    left_margin: number;
    right_margin: number;
    top_margin: number;
    bottom_margin: number;
    font_size: number;
    line_spacing: number;
    characters_per_line: number;
    main_printer_name: string | null;
  } | undefined;
}

function toApi(row: ReturnType<typeof getRow>) {
  if (!row) return defaultSettings();
  return {
    paperWidth: row.paper_width,
    leftMargin: row.left_margin,
    rightMargin: row.right_margin,
    topMargin: row.top_margin,
    bottomMargin: row.bottom_margin,
    fontSize: row.font_size,
    lineSpacing: row.line_spacing,
    charactersPerLine: row.characters_per_line,
    mainPrinterName: row.main_printer_name ?? null,
  };
}

function defaultSettings() {
  return { paperWidth: 80, leftMargin: 4, rightMargin: 4, topMargin: 2, bottomMargin: 2, fontSize: 10, lineSpacing: 2, charactersPerLine: 48, mainPrinterName: null };
}

router.get("/printer-settings", (_req, res) => {
  const row = getRow();
  res.json(toApi(row));
});

router.put("/printer-settings", (req, res) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) { res.status(403).json({ error: "غير مصرح" }); return; }
  let b = req.body as any;
  if (b && b.data && typeof b.data === "object") {
    b = b.data;
  }
  db.prepare(`
    INSERT INTO printer_settings (id, paper_width, left_margin, right_margin, top_margin, bottom_margin, font_size, line_spacing, characters_per_line, main_printer_name)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      paper_width = excluded.paper_width,
      left_margin = excluded.left_margin,
      right_margin = excluded.right_margin,
      top_margin = excluded.top_margin,
      bottom_margin = excluded.bottom_margin,
      font_size = excluded.font_size,
      line_spacing = excluded.line_spacing,
      characters_per_line = excluded.characters_per_line,
      main_printer_name = excluded.main_printer_name
  `).run(
    b.paperWidth ?? 80, b.leftMargin ?? 4, b.rightMargin ?? 4,
    b.topMargin ?? 2, b.bottomMargin ?? 2,
    b.fontSize ?? 10, b.lineSpacing ?? 2, b.charactersPerLine ?? 48,
    b.mainPrinterName ?? null,
  );
  res.json(toApi(getRow()));
});

export default router;
