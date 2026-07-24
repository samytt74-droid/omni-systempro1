import { Router } from "express";
import { db } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

router.get("/products", (req, res) => {
  const { categoryId } = req.query;
  const search = (req.query.search || req.query.q) as string | undefined;
  let sql = `
    SELECT p.id, p.number, p.name, p.price, p.cost, p.barcode,
           p.category_id as categoryId, c.name as categoryName, p.active, p.stock
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (categoryId) { sql += " AND p.category_id=?"; params.push(categoryId); }
  if (search) { sql += " AND (p.name LIKE ? OR p.barcode LIKE ? OR CAST(p.number AS TEXT) = ?)"; params.push(`%${search}%`, `%${search}%`, search); }
  sql += " ORDER BY p.number";
  const rows = (db.prepare(sql).all(...params) as any[]).map(r => ({ ...r, active: Boolean(r.active) }));
  res.json(rows);
});

router.get("/products/next-number", (req, res) => {
  const row = db.prepare("SELECT MAX(number) as maxNum FROM products").get() as { maxNum: number | null };
  const nextNumber = (row?.maxNum || 0) + 1;
  res.json({ nextNumber });
});

router.get("/products/:id", (req, res) => {
  const row = db.prepare(`
    SELECT p.id, p.number, p.name, p.price, p.cost, p.barcode,
           p.category_id as categoryId, c.name as categoryName, p.active, p.stock
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.id=?
  `).get(req.params.id) as any;
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json({ ...row, active: Boolean(row.active) });
});

router.post("/products", (req, res) => {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return; }
  const { name, number, price, cost, barcode, categoryId, active, stock } = req.body;
  if (!name || !number || !price) { res.status(400).json({ error: "بيانات ناقصة" }); return; }
  const r = db.prepare(`
    INSERT INTO products (name, number, price, cost, barcode, category_id, active, stock)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(name, number, price, cost ?? null, barcode ?? null, categoryId ?? null, active !== false ? 1 : 0, stock ?? null);
  const prod = db.prepare(`
    SELECT p.id, p.number, p.name, p.price, p.cost, p.barcode,
           p.category_id as categoryId, c.name as categoryName, p.active, p.stock
    FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id=?
  `).get(r.lastInsertRowid) as any;
  res.status(201).json({ ...prod, active: Boolean(prod.active) });
});

router.put("/products/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return; }
  const { name, number, price, cost, barcode, categoryId, active, stock } = req.body;
  db.prepare(`
    UPDATE products SET name=?, number=?, price=?, cost=?, barcode=?, category_id=?, active=?, stock=?
    WHERE id=?
  `).run(name, number, price, cost ?? null, barcode ?? null, categoryId ?? null, active !== false ? 1 : 0, stock ?? null, req.params.id);
  const prod = db.prepare(`
    SELECT p.id, p.number, p.name, p.price, p.cost, p.barcode,
           p.category_id as categoryId, c.name as categoryName, p.active, p.stock
    FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id=?
  `).get(req.params.id) as any;
  res.json({ ...prod, active: Boolean(prod.active) });
});

router.delete("/products/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return; }
  db.prepare("DELETE FROM products WHERE id=?").run(req.params.id);
  res.status(204).send();
});

export default router;
