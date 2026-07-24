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

router.get("/branches", (req, res) => {
  const branches = db.prepare("SELECT * FROM branches ORDER BY name").all();
  res.json(branches);
});

router.post("/branches", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);
  const { name, address, phone } = req.body;
  if (!name) { res.status(400).json({ error: "اسم الفرع مطلوب" }); return; }
  const r = db.prepare("INSERT INTO branches (name, address, phone) VALUES (?,?,?)").run(name, address ?? null, phone ?? null);
  logAudit(user.id, user.name, "إضافة فرع", `تم إضافة الفرع: ${name}`);
  res.status(201).json({ id: r.lastInsertRowid, name, address, phone, active: 1 });
});

router.delete("/branches/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);
  db.prepare("DELETE FROM branches WHERE id=?").run(req.params.id);
  logAudit(user.id, user.name, "حذف فرع", `رقم الفرع: ${req.params.id}`);
  res.status(204).send();
});

router.get("/warehouses", (req, res) => {
  const warehouses = db.prepare(`
    SELECT w.*, b.name as branch_name 
    FROM warehouses w 
    LEFT JOIN branches b ON b.id = w.branch_id 
    ORDER BY w.name
  `).all();
  res.json(warehouses);
});

router.post("/warehouses", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);
  const { branch_id, name, location } = req.body;
  if (!name) { res.status(400).json({ error: "اسم المستودع مطلوب" }); return; }
  const r = db.prepare("INSERT INTO warehouses (branch_id, name, location) VALUES (?,?,?)").run(branch_id ?? null, name, location ?? null);
  logAudit(user.id, user.name, "إضافة مستودع", `مستودع: ${name}`);
  res.status(201).json({ id: r.lastInsertRowid, branch_id, name, location, active: 1 });
});

router.delete("/warehouses/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);
  db.prepare("DELETE FROM warehouses WHERE id=?").run(req.params.id);
  logAudit(user.id, user.name, "حذف مستودع", `رقم المستودع: ${req.params.id}`);
  res.status(204).send();
});

export default router;
