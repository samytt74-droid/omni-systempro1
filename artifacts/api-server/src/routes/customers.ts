import { Router } from "express";
import { db } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

router.get("/customers", (_req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.phone, c.email, c.address, c.created_at as createdAt,
           COALESCE(SUM(o.total), 0) as totalPurchases
    FROM customers c
    LEFT JOIN orders o ON o.customer_id = c.id
    GROUP BY c.id ORDER BY c.name
  `).all();
  res.json(rows);
});

router.post("/customers", (req, res) => {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return; }
  const { name, phone, email, address } = req.body;
  if (!name) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
  const r = db.prepare("INSERT INTO customers (name, phone, email, address) VALUES (?,?,?,?)").run(name, phone ?? null, email ?? null, address ?? null);
  const cust = db.prepare("SELECT *, 0 as totalPurchases, created_at as createdAt FROM customers WHERE id=?").get(r.lastInsertRowid);
  res.status(201).json(cust);
});

router.put("/customers/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return; }
  const { name, phone, email, address } = req.body;
  db.prepare("UPDATE customers SET name=?, phone=?, email=?, address=? WHERE id=?").run(name, phone ?? null, email ?? null, address ?? null, req.params.id);
  const cust = db.prepare(`
    SELECT c.id, c.name, c.phone, c.email, c.address, c.created_at as createdAt,
           COALESCE(SUM(o.total), 0) as totalPurchases
    FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE c.id=?
  `).get(req.params.id);
  res.json(cust);
});

router.delete("/customers/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return; }
  db.prepare("DELETE FROM customers WHERE id=?").run(req.params.id);
  res.status(204).send();
});

export default router;
