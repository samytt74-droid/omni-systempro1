import { Router } from "express";
import { db } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

function requireAuth(req: any, res: any): any {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return user;
}

router.get("/kds/orders", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  // Get recent orders (last 24 hours or dine-in/takeaway)
  const orders = db.prepare(`
    SELECT o.*, u.name as cashier_name
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    WHERE datetime(o.created_at) >= datetime('now', '-1 day')
    ORDER BY o.created_at DESC
  `).all() as any[];

  const result = orders.map(ord => ({
    ...ord,
    items: db.prepare("SELECT * FROM order_items WHERE order_id=?").all(ord.id)
  }));
  res.json(result);
});

export default router;
