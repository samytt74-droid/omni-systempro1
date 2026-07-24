import { Router } from "express";
import { db, hashPassword } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

const toUser = (u: any) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  role: u.role,
  active: Boolean(u.active),
  email: u.email,
  phone: u.phone,
  avatar_url: u.avatar_url,
  default_branch_id: u.default_branch_id,
  language: u.language,
  timezone: u.timezone,
  status: u.status,
  full_name: u.full_name
});

router.get("/users", (req, res) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) { res.status(403).json({ error: "غير مصرح" }); return; }
  let rows = db.prepare("SELECT id, username, name, role, active, email, phone, avatar_url, default_branch_id, language, timezone, status, full_name FROM users ORDER BY name").all() as any[];
  if (user.role !== "developer") {
    rows = rows.filter((r: any) => r.role !== "developer");
  }
  res.json(rows.map(toUser));
});

router.post("/users", (req, res) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) { res.status(403).json({ error: "غير مصرح" }); return; }
  const { username, name, role, password, active, email, phone, avatar_url, default_branch_id, language, timezone, status, full_name } = req.body;
  if (!username || !name || !role || !password) { res.status(400).json({ error: "بيانات ناقصة" }); return; }
  
  if (role === "developer" && user.role !== "developer") {
    res.status(403).json({ error: "غير مصرح لغير المطور بتعيين دور المطور" });
    return;
  }
  
  const hash = hashPassword(password);
  const r = db.prepare(`
    INSERT INTO users (
      username, password_hash, name, role, active,
      email, phone, avatar_url, default_branch_id, language, timezone, status, full_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    username, hash, name, role, active !== false ? 1 : 0,
    email ?? null, phone ?? null, avatar_url ?? null, default_branch_id ?? 1, language ?? "عربي", timezone ?? "GMT+3", status ?? "نشط", full_name ?? name
  );
  const u = db.prepare("SELECT id, username, name, role, active, email, phone, avatar_url, default_branch_id, language, timezone, status, full_name FROM users WHERE id=?").get(r.lastInsertRowid) as any;
  res.status(201).json(toUser(u));
});

router.put("/users/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) { res.status(403).json({ error: "غير مصرح" }); return; }
  
  const targetUser = db.prepare("SELECT id, username, name, role, active FROM users WHERE id=?").get(req.params.id) as any;
  if (!targetUser) { res.status(404).json({ error: "المستخدم غير موجود" }); return; }
  
  if (targetUser.role === "developer" && user.role !== "developer") {
    res.status(403).json({ error: "غير مصرح بالتعديل على حساب المطور" });
    return;
  }
  
  const { username, name, role, password, active, email, phone, avatar_url, default_branch_id, language, timezone, status, full_name } = req.body;
  
  if (role === "developer" && user.role !== "developer") {
    res.status(403).json({ error: "غير مصرح لغير المطور بتعيين دور المطور" });
    return;
  }
  
  const targetRole = role ?? targetUser.role;
  
  if (password) {
    const hash = hashPassword(password);
    db.prepare(`
      UPDATE users SET
        username=?, name=?, role=?, password_hash=?, active=?,
        email=?, phone=?, avatar_url=?, default_branch_id=?, language=?, timezone=?, status=?, full_name=?
      WHERE id=?
    `).run(
      username, name, targetRole, hash, active !== false ? 1 : 0,
      email ?? null, phone ?? null, avatar_url ?? null, default_branch_id ?? 1, language ?? "عربي", timezone ?? "GMT+3", status ?? "نشط", full_name ?? name,
      req.params.id
    );
  } else {
    db.prepare(`
      UPDATE users SET
        username=?, name=?, role=?, active=?,
        email=?, phone=?, avatar_url=?, default_branch_id=?, language=?, timezone=?, status=?, full_name=?
      WHERE id=?
    `).run(
      username, name, targetRole, active !== false ? 1 : 0,
      email ?? null, phone ?? null, avatar_url ?? null, default_branch_id ?? 1, language ?? "عربي", timezone ?? "GMT+3", status ?? "نشط", full_name ?? name,
      req.params.id
    );
  }
  const u = db.prepare("SELECT id, username, name, role, active, email, phone, avatar_url, default_branch_id, language, timezone, status, full_name FROM users WHERE id=?").get(req.params.id) as any;
  res.json(toUser(u));
});

router.delete("/users/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) { res.status(403).json({ error: "غير مصرح" }); return; }
  
  const targetUser = db.prepare("SELECT id, username, name, role, active FROM users WHERE id=?").get(req.params.id) as any;
  if (targetUser && targetUser.role === "developer" && user.role !== "developer") {
    res.status(403).json({ error: "غير مصرح بحذف حساب المطور" });
    return;
  }
  
  db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);
  res.status(204).send();
});

export default router;
