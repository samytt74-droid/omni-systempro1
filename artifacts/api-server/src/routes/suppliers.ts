import { Router } from "express";
import { db, logAudit } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

function requireAdmin(req: any, res: any): boolean {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) {
    res.status(403).json({ error: "غير مصرح" });
    return false;
  }
  return true;
}

router.get("/suppliers", (req, res) => {
  const suppliers = db.prepare("SELECT * FROM suppliers ORDER BY name").all();
  res.json(suppliers);
});

router.post("/suppliers", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);
  const { name, phone, email, address, rating } = req.body;
  if (!name) { res.status(400).json({ error: "اسم المورد مطلوب" }); return; }
  const r = db.prepare("INSERT INTO suppliers (name, phone, email, address, rating) VALUES (?,?,?,?,?)")
    .run(name, phone ?? null, email ?? null, address ?? null, rating ?? 5);
  logAudit(user.id, user.name, "إضافة مورد", `مورد: ${name}`);
  res.status(201).json({ id: r.lastInsertRowid, name, phone, email, address, rating: rating ?? 5, balance: 0 });
});

router.put("/suppliers/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);
  const { name, phone, email, address, rating } = req.body;
  db.prepare("UPDATE suppliers SET name=?, phone=?, email=?, address=?, rating=? WHERE id=?")
    .run(name, phone, email, address, rating, req.params.id);
  logAudit(user.id, user.name, "تعديل مورد", `رقم المورد: ${req.params.id}`);
  res.json({ success: true });
});

router.delete("/suppliers/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);
  db.prepare("DELETE FROM suppliers WHERE id=?").run(req.params.id);
  logAudit(user.id, user.name, "حذف مورد", `رقم المورد: ${req.params.id}`);
  res.status(204).send();
});

export default router;
