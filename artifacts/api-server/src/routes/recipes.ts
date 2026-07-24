import { Router } from "express";
import { db, logAudit } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

function requireAuth(req: any, res: any): any {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return user;
}

router.get("/recipes/:productId", (req, res) => {
  const recipes = db.prepare("SELECT * FROM product_recipes WHERE product_id=?").all(req.params.productId);
  const modifiers = db.prepare("SELECT * FROM product_modifiers WHERE product_id=?").all(req.params.productId);
  res.json({ recipes, modifiers });
});

router.post("/recipes", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { product_id, ingredient_name, quantity, unit } = req.body;
  const r = db.prepare("INSERT INTO product_recipes (product_id, ingredient_name, quantity, unit) VALUES (?,?,?,?)")
    .run(product_id, ingredient_name, quantity ?? 1, unit ?? "جم");
  res.status(201).json({ id: r.lastInsertRowid, product_id, ingredient_name, quantity, unit });
});

router.delete("/recipes/:id", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  db.prepare("DELETE FROM product_recipes WHERE id=?").run(req.params.id);
  res.status(204).send();
});

router.post("/modifiers", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { product_id, name, price } = req.body;
  const r = db.prepare("INSERT INTO product_modifiers (product_id, name, price) VALUES (?,?,?)")
    .run(product_id, name, price ?? 0);
  res.status(201).json({ id: r.lastInsertRowid, product_id, name, price: price ?? 0 });
});

router.delete("/modifiers/:id", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  db.prepare("DELETE FROM product_modifiers WHERE id=?").run(req.params.id);
  res.status(204).send();
});

export default router;
