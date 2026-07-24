import { Router } from "express";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { db } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

const ORDER_TYPE_LABELS: Record<string, string> = {
  "dine-in": "محلي",
  "takeaway": "سفري",
  "delivery": "توصيل",
};

function getPrinterSettings() {
  const row = db.prepare("SELECT * FROM printer_settings WHERE id = 1").get() as any;
  if (!row) {
    return {
      paperWidth: 80,
      leftMargin: 1.5,
      rightMargin: 1.5,
      topMargin: 1,
      bottomMargin: 1,
      fontSize: 11,
      lineSpacing: 0,
      charactersPerLine: 48,
      mainPrinterName: null
    };
  }
  return {
    paperWidth: row.paper_width,
    leftMargin: row.left_margin,
    rightMargin: row.right_margin,
    topMargin: row.top_margin,
    bottomMargin: row.bottom_margin,
    fontSize: row.font_size,
    lineSpacing: row.line_spacing,
    charactersPerLine: row.characters_per_line,
    mainPrinterName: row.main_printer_name ?? null
  };
}

function getGeneralSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const map: Record<string, any> = {};
  for (const r of rows) {
    if (r.value === "true") map[r.key] = true;
    else if (r.value === "false") map[r.key] = false;
    else if (r.value === "null" || r.value === "") map[r.key] = null;
    else if (!isNaN(Number(r.value)) && r.value !== "") map[r.key] = Number(r.value);
    else map[r.key] = r.value;
  }
  return {
    businessName: map["businessName"] ?? "مطعمي",
    address: map["address"] ?? null,
    phone: map["phone"] ?? null,
    taxNumber: map["taxNumber"] ?? null,
    taxRate: map["taxRate"] ?? 15,
    currency: map["currency"] ?? "ريال",
    receiptMessage: map["receiptMessage"] ?? null,
    printLogo: map["printLogo"] ?? true,
    printQr: map["printQr"] ?? false,
    showCashier: map["showCashier"] ?? true,
    showCustomer: map["showCustomer"] ?? true,
    receiptPaperSize: map["receiptPaperSize"] ?? "80mm",
    showOrderNumber: map["showOrderNumber"] ?? true,
    showTableNumber: map["showTableNumber"] ?? true,
    showDateTime: map["showDateTime"] ?? true,
    showBarcode: map["showBarcode"] ?? false,
    showOrderType: map["showOrderType"] ?? true,
    showTax: map["showTax"] ?? true,
    showDiscount: map["showDiscount"] ?? true,
    showNotes: map["showNotes"] ?? true,
    autoPrintTrigger: map["autoPrintTrigger"] ?? "print_button",
    maxReprintCount: map["maxReprintCount"] ?? 3,
    masterCopiesCount: map["masterCopiesCount"] ?? 2,
    logoUrl: map["logoUrl"] ?? null,
  };
}

function getDepartmentConfigs() {
  const rows = db.prepare(`
    SELECT d.*, c.name as category_name
    FROM department_print_configs d
    LEFT JOIN categories c ON c.id = d.category_id
    ORDER BY d.print_order
  `).all() as any[];
  return rows.map(r => ({
    id: r.id,
    categoryId: r.category_id,
    printerName: r.printer_name ?? null,
    copies: r.copies ?? 1,
    enabled: r.enabled !== 0,
    printOrder: r.print_order ?? 0,
    categoryName: r.category_name ?? "قسم",
  }));
}

function getBackendDeptGroups(order: any, deptConfigs: any[]) {
  const categoryMap = new Map<number | string, {
    categoryId: number | null;
    categoryName: string | null;
    items: any[];
    printOrder: number;
  }>();

  for (const item of order.items ?? []) {
    const key = item.categoryId ?? "__no_category__";
    if (!categoryMap.has(key)) {
      const config = deptConfigs.find(d => d.categoryId === item.categoryId);
      categoryMap.set(key, {
        categoryId: item.categoryId ?? null,
        categoryName: item.categoryName ?? "قسم",
        items: [],
        printOrder: config?.printOrder ?? 999,
      });
    }
    categoryMap.get(key)!.items.push(item);
  }

  return Array.from(categoryMap.values())
    .filter(g => g.items.length > 0)
    .sort((a, b) => a.printOrder - b.printOrder)
    .map(g => {
      const config = deptConfigs.find(d => d.categoryId === g.categoryId);
      return {
        dept: {
          id: config?.id ?? (g.categoryId ?? 0),
          categoryId: g.categoryId,
          categoryName: g.categoryName ?? "قسم",
          printerName: config?.printerName ?? null,
          copies: config?.copies ?? 1,
          enabled: config ? config.enabled : true,
          printOrder: g.printOrder,
        },
        items: g.items,
      };
    });
}

function parseOrderDate(dateStr: string | undefined | null): Date {
  if (!dateStr) return new Date();
  let s = String(dateStr).trim();
  if (s && !s.endsWith("Z") && !s.includes("+") && !/-\d{2}:\d{2}$/.test(s)) {
    s = s.replace(" ", "T") + "Z";
  }
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

function generateReceiptText(order: any, settings: any, cashierName: string, printerSettings?: any): string {
  const lines: string[] = [];
  const w = Number(printerSettings?.charactersPerLine || settings?.charactersPerLine || 40);
  
  // Left margin in spaces
  const leftMarginSpaces = Math.max(0, Math.floor((printerSettings?.leftMargin ?? 0) / 1.5));
  const padLeft = " ".repeat(leftMarginSpaces);

  const center = (s: string) => {
    if (s.length >= w) return s;
    const padLen = Math.floor((w - s.length) / 2);
    return " ".repeat(padLen) + s;
  };
  const line = (ch = "-") => ch.repeat(w);
  const cleanInvoiceNumber = (order.invoiceNumber || String(order.id)).replace(/^INV-0*/, "") || "0";

  // Top margin in newlines
  const topMarginLines = Math.max(0, Math.floor((printerSettings?.topMargin ?? 0) / 4));
  for (let i = 0; i < topMarginLines; i++) {
    lines.push("");
  }

  lines.push(center(settings?.businessName ?? "المطعم"));
  if (settings?.address) lines.push(center(settings.address));
  lines.push(line("."));
  lines.push(center("فاتورة خاصة بالزبون"));
  lines.push(center(`الرقم المسلسل: [ ${cleanInvoiceNumber} ]`));
  lines.push(line("."));
  
  const d = order.createdAt ? parseOrderDate(order.createdAt) : new Date();
  const dateStr = `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
  const timeStr = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
  lines.push(`التاريخ: ${dateStr}  ${timeStr}`);
  lines.push(`نوع الطلب: ${ORDER_TYPE_LABELS[order.orderType ?? "dine-in"] ?? "محلي"}`);
  lines.push(`الطاولة: ${order.tableNumber || "0"}    ط`);
  lines.push(line("-"));
  
  // Dynamic columns calculation to prevent wrapping
  const priceW = Math.max(8, Math.floor(w * 0.25));
  const qtyW = Math.max(4, Math.floor(w * 0.15));
  const nameW = w - priceW - qtyW;

  lines.push(`${"الصنف".padEnd(nameW)}${"الكمية".padStart(qtyW)}${"السعر".padStart(priceW)}`);
  lines.push(line("-"));
  for (const item of order.items ?? []) {
    const name = (item.productName || item.product?.name || "").substring(0, Math.max(5, nameW - 1)).padEnd(nameW);
    const qty = String(item.quantity).padStart(qtyW);
    const price = String((item.unitPrice || item.price || 0).toLocaleString()).padStart(priceW);
    lines.push(`${name}${qty}${price}`);
  }
  lines.push(line("-"));
  
  const totalStr = `الإجمالي: ${(order.total || 0).toFixed(2)} ${settings?.currency ?? "ريال"}`;
  lines.push(totalStr.padStart(w));
  lines.push(line("="));
  if (cashierName) lines.push(center(`اسم الكاشير: ${cashierName}`));
  if (order.note) lines.push(`ملاحظات: ${order.note}`);
  lines.push(line("-"));
  lines.push(center("الطلب لا يمكن استرجاعه أو إلغاؤه"));
  if (settings?.phone) lines.push(center(`أرقام التواصل: ${settings.phone}`));
  
  // Visual Cut indicator and feed lines to separate receipts
  lines.push(line("-"));
  lines.push(center("✄ - - - - - - - - - - - - - - - - ✄"));
  lines.push(line("-"));

  // Bottom margin in newlines (force at least 6 lines of feed to clear printhead to cutter)
  const bottomMarginLines = Math.max(6, Math.floor((printerSettings?.bottomMargin ?? 8) / 2));
  for (let i = 0; i < bottomMarginLines; i++) {
    lines.push("");
  }

  // Prepend left margin to all lines
  return lines.map(l => l ? padLeft + l : l).join("\n");
}

function generateDeptReceiptText(order: any, dept: any, items: any[], settings: any, printerSettings?: any): string {
  const lines: string[] = [];
  const w = Number(printerSettings?.charactersPerLine || settings?.charactersPerLine || 32);

  // Left margin in spaces
  const leftMarginSpaces = Math.max(0, Math.floor((printerSettings?.leftMargin ?? 0) / 1.5));
  const padLeft = " ".repeat(leftMarginSpaces);

  const center = (s: string) => {
    if (s.length >= w) return s;
    const padLen = Math.floor((w - s.length) / 2);
    return " ".repeat(padLen) + s;
  };
  const line = (ch = "-") => ch.repeat(w);
  const cleanInvoiceNumber = (order.invoiceNumber || String(order.id)).replace(/^INV-0*/, "") || "0";

  // Top margin in newlines
  const topMarginLines = Math.max(0, Math.floor((printerSettings?.topMargin ?? 0) / 4));
  for (let i = 0; i < topMarginLines; i++) {
    lines.push("");
  }

  lines.push(center(settings?.businessName ?? "المطعم"));
  lines.push(center(`قسم: ${dept.categoryName}`));
  lines.push(line("."));
  lines.push(center(`أمر صرف رقم: [ ${cleanInvoiceNumber} ]`));
  lines.push(line("-"));
  
  const d = order.createdAt ? parseOrderDate(order.createdAt) : new Date();
  const dateStr = `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
  lines.push(`التاريخ: ${dateStr}`);
  lines.push(`نوع الطلب: ${ORDER_TYPE_LABELS[order.orderType ?? "dine-in"] ?? "محلي"}`);
  lines.push(`الطاولة: ${order.tableNumber || "0"}    ط`);
  lines.push(line("="));
  
  // Dynamic column layout
  const qtyW = Math.max(4, Math.floor(w * 0.15));
  const nameW = w - qtyW;

  for (const item of items) {
    const name = (item.productName || item.product?.name || "").substring(0, Math.max(5, nameW - 1)).padEnd(nameW);
    const qty = `x${item.quantity}`.padStart(qtyW);
    lines.push(`${name}${qty}`);
  }
  lines.push(line("="));
  if (order.note) lines.push(`ملاحظات: ${order.note}`);
  
  // Visual Cut indicator and feed lines to separate receipts
  lines.push(line("-"));
  lines.push(center("✄ - - - - - - - - - - - - - - - - ✄"));
  lines.push(line("-"));

  // Bottom margin in newlines (force at least 6 lines of feed to clear printhead to cutter)
  const bottomMarginLines = Math.max(6, Math.floor((printerSettings?.bottomMargin ?? 8) / 2));
  for (let i = 0; i < bottomMarginLines; i++) {
    lines.push("");
  }

  // Prepend left margin to all lines
  return lines.map(l => l ? padLeft + l : l).join("\n");
}

async function printDirect(printerName: string, content: string, copies: number): Promise<void> {
  const targetPrinter = printerName ? printerName.trim() : "";
  if (!targetPrinter) {
    printViaSystem("", content, copies);
    return;
  }
  const ipPortMatch = targetPrinter.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/);
  if (ipPortMatch) {
    const host = ipPortMatch[1];
    const port = ipPortMatch[2] ? parseInt(ipPortMatch[2]) : 9100;
    await printViaTcp(host, port, content, copies);
  } else {
    printViaSystem(targetPrinter, content, copies);
  }
}

function listPrinters(): string[] {
  const os = platform();
  try {
    if (os === "win32") {
      const out = execSync(
        `powershell -Command "Get-Printer | Select-Object -ExpandProperty Name"`,
        { timeout: 5000, encoding: "utf8" }
      );
      return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } else {
      const out = execSync("lpstat -a 2>/dev/null || lpstat -p 2>/dev/null || echo ''", {
        timeout: 5000,
        encoding: "utf8",
        shell: "/bin/bash",
      });
      return out
        .split(/\r?\n/)
        .map(line => {
          const match = line.match(/^(\S+)/);
          return match ? match[1] : "";
        })
        .filter(Boolean);
    }
  } catch {
    return [];
  }
}

function printViaSystem(printerName: string, content: string, copies: number): void {
  const os = platform();
  const tmpFile = join(tmpdir(), `pos-receipt-${randomBytes(6).toString("hex")}.txt`);
  try {
    // Write content synchronously with UTF-8 BOM so Windows PowerShell reads Arabic correctly
    writeFileSync(tmpFile, "\ufeff" + content, { encoding: "utf8" });
    
    const targetPrinter = printerName ? printerName.trim() : "";
    
    for (let i = 0; i < copies; i++) {
      if (os === "win32") {
        try {
          const escapedPath = tmpFile.replace(/'/g, "''");
          if (targetPrinter) {
            const escapedPrinter = targetPrinter.replace(/'/g, "''");
            execSync(`powershell -Command "$ErrorActionPreference = 'Stop'; Get-Content -LiteralPath '${escapedPath}' -Raw -Encoding utf8 | Out-Printer -Name '${escapedPrinter}'"`, { timeout: 10000 });
          } else {
            execSync(`powershell -Command "$ErrorActionPreference = 'Stop'; Get-Content -LiteralPath '${escapedPath}' -Raw -Encoding utf8 | Out-Printer"`, { timeout: 10000 });
          }
        } catch (pwErr: any) {
          console.error("PowerShell printing failed, trying legacy fallback:", pwErr);
          if (targetPrinter) {
            try {
              execSync(`print /D:"${targetPrinter}" "${tmpFile}"`, { timeout: 10000 });
            } catch (legacyErr: any) {
              throw new Error(`PowerShell print failed (${pwErr.message}) and legacy fallback failed (${legacyErr.message})`);
            }
          } else {
            throw new Error(`PowerShell print failed: ${pwErr.message}`);
          }
        }
      } else {
        try {
          if (targetPrinter) {
            execSync(`lp -d "${targetPrinter}" "${tmpFile}"`, { timeout: 10000, shell: "/bin/bash" });
          } else {
            execSync(`lp "${tmpFile}"`, { timeout: 10000, shell: "/bin/bash" });
          }
        } catch (linuxErr: any) {
          console.error("Linux printing failed:", linuxErr);
          const errMsg = linuxErr.message || "";
          if (errMsg.includes("not found") || errMsg.includes("command not found") || errMsg.includes("ENOENT")) {
            throw new Error(`نظام الطباعة (lp) غير متوفر على هذا الجهاز. يرجى تشغيل النظام محلياً لتفعيل الطباعة الصامتة عبر USB أو تثبيت خدمة CUPS (خطأ: lp not found)`);
          } else {
            throw new Error(`فشلت الطباعة عبر النظام: ${errMsg}`);
          }
        }
      }
    }
  } finally {
    try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch {}
  }
}

function printViaTcp(host: string, port: number, content: string, copies: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let sent = 0;
    // Standard ESC/POS paper cut sequence: GS V 66 0 (ASCII: \x1D\x56\x42\x00)
    const cutCommand = "\x1D\x56\x42\x00";
    const contentWithCut = content.endsWith(cutCommand) ? content : content + "\n\n" + cutCommand;

    function sendCopy() {
      if (sent >= copies) { resolve(); return; }
      const client = new net.Socket();
      client.connect(port, host, () => {
        client.write(Buffer.from(contentWithCut, "utf8"), () => {
          client.end();
        });
      });
      client.on("close", () => { sent++; sendCopy(); });
      client.on("error", reject);
      client.setTimeout(8000, () => { client.destroy(); reject(new Error("TCP print timeout")); });
    }
    sendCopy();
  });
}

router.get("/printers/list", (_req, res) => {
  const printers = listPrinters();
  res.json(printers);
});

router.post("/printers/print-direct", async (req, res) => {
  const { printerName, content, copies = 1 } = req.body as {
    printerName?: string | null;
    content: string;
    copies?: number;
  };

  if (!content) {
    res.status(400).json({ ok: false, message: "content is required" });
    return;
  }

  try {
    await printDirect(printerName ?? "", content, copies);
    res.json({ ok: true, message: "تمت الطباعة بنجاح" });
  } catch (err: any) {
    res.json({ ok: false, message: err?.message ?? "فشلت الطباعة" });
  }
});

router.post("/printers/print", async (req, res) => {
  const { printerName, content, copies = 1 } = req.body as {
    printerName?: string | null;
    content: string;
    copies?: number;
  };

  if (!content) {
    res.status(400).json({ ok: false, message: "content is required" });
    return;
  }

  try {
    await printDirect(printerName ?? "", content, copies);
    res.json({ ok: true, message: "تمت الطباعة بنجاح" });
  } catch (err: any) {
    res.json({ ok: false, message: err?.message ?? "فشلت الطباعة" });
  }
});

router.post("/printers/electron-print", async (req, res) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ error: "غير مصرح" });
    return;
  }

  const { order } = req.body as { order: any };
  if (!order) {
    res.status(400).json({ ok: false, message: "بيانات الطلب مطلوبة" });
    return;
  }

  try {
    const printerSettings = getPrinterSettings();
    const generalSettings = getGeneralSettings();
    const deptConfigs = getDepartmentConfigs();

    const deptGroups = getBackendDeptGroups(order, deptConfigs);

    const printJobs: {
      printerName: string;
      content: string;
      copies: number;
      log: {
        orderId: number;
        invoiceNumber: string;
        receiptType: "master" | "department";
        departmentName: string;
        printerName: string;
      };
    }[] = [];

    const mainPrinter = printerSettings.mainPrinterName || "";
    const copiesCount = generalSettings.masterCopiesCount ?? 2;

    // Master receipts
    const masterText = generateReceiptText(order, generalSettings, authUser.name, printerSettings);
    for (let i = 0; i < copiesCount; i++) {
      const copyLabel = `نسخة ${i + 1}`;
      printJobs.push({
        printerName: mainPrinter,
        content: masterText,
        copies: 1,
        log: {
          orderId: order.id,
          invoiceNumber: order.invoiceNumber,
          receiptType: "master",
          departmentName: copyLabel,
          printerName: mainPrinter || "الطابعة الافتراضية",
        },
      });
    }

    // Department receipts
    for (const { dept, items } of deptGroups) {
      if (!items.length) continue;
      if (!dept.printerName || !dept.printerName.trim()) {
        continue;
      }
      const deptText = generateDeptReceiptText(order, dept, items, generalSettings, printerSettings);
      printJobs.push({
        printerName: dept.printerName,
        content: deptText,
        copies: dept.copies || 1,
        log: {
          orderId: order.id,
          invoiceNumber: order.invoiceNumber,
          receiptType: "department",
          departmentName: dept.categoryName ?? "قسم",
          printerName: dept.printerName,
        },
      });
    }

    const results: any[] = [];
    let overallSuccess = true;

    for (const job of printJobs) {
      let printSuccess = false;
      let attempts = 0;
      const maxAttempts = 3;
      let lastError = "";

      while (attempts < maxAttempts && !printSuccess) {
        attempts++;
        try {
          await printDirect(job.printerName, job.content, job.copies);
          printSuccess = true;
        } catch (err: any) {
          lastError = err?.message ?? "خطأ غير معروف";
          console.error(`Attempt ${attempts} failed for printer ${job.printerName}:`, err);
          if (attempts < maxAttempts) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }

      const status = printSuccess ? "success" : "failed";
      if (!printSuccess) {
        overallSuccess = false;
      }

      results.push({
        printerName: job.printerName,
        departmentName: job.log.departmentName,
        receiptType: job.log.receiptType,
        status,
        error: printSuccess ? null : lastError,
      });

      try {
        db.prepare(`
          INSERT INTO print_log (order_id, invoice_number, receipt_type, department_name, printer_name, user_id, copies, status, reprint_reason, reprint_count)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).run(
          job.log.orderId,
          job.log.invoiceNumber,
          job.log.receiptType,
          job.log.departmentName,
          job.log.printerName,
          authUser.id,
          job.copies,
          status,
          null,
          0,
        );
      } catch (logErr) {
        console.error("Failed to insert print log into DB:", logErr);
      }

      await new Promise((r) => setTimeout(r, 100));
    }

    res.json({
      ok: overallSuccess,
      results,
    });
  } catch (err: any) {
    console.error("Error during background silent printing:", err);
    res.status(500).json({
      ok: false,
      message: err?.message ?? "حدث خطأ غير متوقع أثناء الطباعة الخلفية",
    });
  }
});

export default router;
