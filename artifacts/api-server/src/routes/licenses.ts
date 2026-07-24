import { Router } from "express";
import { db, logAudit } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

function requireDeveloper(req: any, res: any): boolean {
  const user = getAuthUser(req);
  if (!user || user.role !== "developer") {
    res.status(403).json({ error: "هذه الصفحة والعمليات مخصصة لحساب المطور فقط" });
    return false;
  }
  return true;
}

router.get("/licenses/active", (req, res) => {
  const lic = db.prepare("SELECT * FROM licenses WHERE active=1 ORDER BY id DESC LIMIT 1").get() as any;
  if (!lic) {
    res.json({ active: false, client_name: "غير مرخص", expires_at: "", devices_limit: 0 });
    return;
  }
  const devices = db.prepare("SELECT * FROM license_devices WHERE license_id=?").all(lic.id);
  res.json({ ...lic, devices });
});

router.get("/licenses", (req, res) => {
  if (!requireDeveloper(req, res)) return;
  const licenses = db.prepare("SELECT * FROM licenses ORDER BY id DESC").all() as any[];
  const result = licenses.map(lic => {
    const devices = db.prepare("SELECT * FROM license_devices WHERE license_id=?").all(lic.id);
    return { ...lic, devices, active_devices_count: devices.length };
  });
  res.json(result);
});

router.post("/licenses", (req, res) => {
  if (!requireDeveloper(req, res)) return;
  const user = getAuthUser(req);
  const { client_name, devices_limit, expires_at } = req.body;
  const licenseKey = `OMNI-PRO-${Math.random().toString(36).substring(2, 8).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const r = db.prepare("INSERT INTO licenses (license_key, client_name, devices_limit, expires_at, active) VALUES (?,?,?,?,1)")
    .run(licenseKey, client_name ?? "عميل جديد", devices_limit ?? 1, expires_at ?? "2027-12-31");
  logAudit(user.id, user.name, "إصدار ترخيص", `ترخيص لـ ${client_name ?? "عميل جديد"} برقم ${licenseKey} (عدد الأجهزة: ${devices_limit ?? 1})`);
  res.status(201).json({ id: r.lastInsertRowid, license_key: licenseKey, client_name, devices_limit: devices_limit ?? 1, expires_at, active: 1 });
});

router.post("/licenses/verify", (req, res) => {
  const { license_key, device_id, device_name } = req.body;
  const devId = device_id || "web-browser-device-" + Math.random().toString(36).substring(2, 9);
  const devName = device_name || "متصفح ويب / جهاز رئيسي";

  const lic = db.prepare("SELECT * FROM licenses WHERE license_key=? AND active=1").get(license_key) as any;
  if (!lic) {
    res.status(400).json({ valid: false, error: "مفتاح الترخيص غير صالح أو معطل" });
    return;
  }
  if (new Date(lic.expires_at) < new Date()) {
    res.status(400).json({ valid: false, error: "انتهت صلاحية الترخيص" });
    return;
  }

  // Check if device is already registered for this license
  const existingDevice = db.prepare("SELECT * FROM license_devices WHERE license_id=? AND device_id=?").get(lic.id, devId) as any;
  
  if (!existingDevice) {
    // Count current registered devices
    const devicesCount = (db.prepare("SELECT COUNT(*) as cnt FROM license_devices WHERE license_id=?").get(lic.id) as any).cnt;
    if (devicesCount >= lic.devices_limit) {
      res.status(400).json({ 
        valid: false, 
        error: `تم الوصول للحد الأقصى من الأجهزة المرخصة لهذا المفتاح (${devicesCount}/${lic.devices_limit} أجهزة). يرجى إلغاء تفعيل جهاز قديم أو زيادة عدد الأجهزة.` 
      });
      return;
    }
    // Register new device
    db.prepare("INSERT INTO license_devices (license_id, device_id, device_name, last_active) VALUES (?,?,?,datetime('now'))")
      .run(lic.id, devId, devName);
  } else {
    // Update last_active
    db.prepare("UPDATE license_devices SET last_active=datetime('now'), device_name=? WHERE id=?").run(devName, existingDevice.id);
  }

  const allDevices = db.prepare("SELECT * FROM license_devices WHERE license_id=?").all(lic.id);
  res.json({ 
    valid: true, 
    clientName: lic.client_name, 
    expiresAt: lic.expires_at, 
    devicesLimit: lic.devices_limit,
    deviceId: devId,
    registeredDevices: allDevices
  });
});

router.delete("/licenses/devices/:id", (req, res) => {
  if (!requireDeveloper(req, res)) return;
  const user = getAuthUser(req);
  db.prepare("DELETE FROM license_devices WHERE id=?").run(req.params.id);
  logAudit(user.id, user.name, "إلغاء ربط جهاز", `تم إزالة الجهاز المرتبط برقم تعريف ${req.params.id}`);
  res.status(204).send();
});

router.delete("/licenses/:id", (req, res) => {
  if (!requireDeveloper(req, res)) return;
  const user = getAuthUser(req);
  db.prepare("DELETE FROM license_devices WHERE license_id=?").run(req.params.id);
  db.prepare("DELETE FROM licenses WHERE id=?").run(req.params.id);
  logAudit(user.id, user.name, "حذف ترخيص", `تم حذف الترخيص رقم ${req.params.id}`);
  res.status(204).send();
});

export default router;
