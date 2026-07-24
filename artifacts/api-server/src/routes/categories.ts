import { Router } from "express";
import { db } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

router.get("/categories", (_req, res) => {
  const rows = db.prepare("SELECT id, name, color, cost, revenue FROM categories ORDER BY name").all();
  res.json(rows);
});

router.post("/categories", (req, res) => {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return; }
  const { name, color, cost, revenue } = req.body;
  if (!name) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
  const r = db.prepare("INSERT INTO categories (name, color, cost, revenue) VALUES (?,?,?,?)").run(
    name,
    color ?? null,
    Number(cost || 0),
    Number(revenue || 0)
  );
  const cat = db.prepare("SELECT * FROM categories WHERE id=?").get(r.lastInsertRowid);
  res.status(201).json(cat);
});

router.put("/categories/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return; }
  const { name, color, cost, revenue } = req.body;
  db.prepare("UPDATE categories SET name=?, color=?, cost=?, revenue=? WHERE id=?").run(
    name,
    color ?? null,
    Number(cost || 0),
    Number(revenue || 0),
    req.params.id
  );
  const cat = db.prepare("SELECT * FROM categories WHERE id=?").get(req.params.id);
  res.json(cat);
});

router.delete("/categories/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return; }
  db.prepare("DELETE FROM categories WHERE id=?").run(req.params.id);
  res.status(204).send();
});

export default router;
