import { Router } from "express";
import { db, logAudit } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

function requireAuth(req: any, res: any): any {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return user;
}

router.get("/tables", (req, res) => {
  const tables = db.prepare("SELECT * FROM restaurant_tables ORDER BY table_number").all();
  res.json(tables);
});

router.post("/tables", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { table_number, capacity, section } = req.body;
  if (!table_number) { res.status(400).json({ error: "رقم الطاولة مطلوب" }); return; }
  try {
    const r = db.prepare("INSERT INTO restaurant_tables (table_number, capacity, section, status) VALUES (?,?,?, 'available')")
      .run(table_number, capacity ?? 4, section ?? "الرئيسية");
    logAudit(user.id, user.name, "إضافة طاولة", `طاولة رقم ${table_number}`);
    res.status(201).json({ id: r.lastInsertRowid, table_number, capacity: capacity ?? 4, section: section ?? "الرئيسية", status: "available" });
  } catch (e: any) {
    res.status(400).json({ error: "رقم الطاولة موجود مسبقاً" });
  }
});

router.post("/tables/transfer", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { from_table, to_table } = req.body;
  const t1 = db.prepare("SELECT * FROM restaurant_tables WHERE table_number=?").get(from_table) as any;
  const t2 = db.prepare("SELECT * FROM restaurant_tables WHERE table_number=?").get(to_table) as any;
  if (!t1 || !t2) { res.status(404).json({ error: "إحدى الطاولات غير موجودة" }); return; }

  db.prepare("UPDATE restaurant_tables SET status=?, current_order_id=? WHERE id=?").run("available", null, t1.id);
  db.prepare("UPDATE restaurant_tables SET status=?, current_order_id=? WHERE id=?").run("occupied", t1.current_order_id, t2.id);
  if (t1.current_order_id) {
    db.prepare("UPDATE orders SET table_number=? WHERE id=?").run(to_table, t1.current_order_id);
  }
  logAudit(user.id, user.name, "نقل طاولة", `من ${from_table} إلى ${to_table}`);
  res.json({ success: true });
});

router.delete("/tables/:id", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  db.prepare("DELETE FROM restaurant_tables WHERE id=?").run(req.params.id);
  res.status(204).send();
});

export default router;
