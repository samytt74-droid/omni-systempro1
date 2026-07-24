import { Router } from "express";
import { db } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

router.get("/document-print-settings", (_req, res) => {
  let row = db.prepare("SELECT * FROM document_print_settings WHERE id = 1").get() as any;
  if (!row) {
    db.prepare(`
      INSERT OR IGNORE INTO document_print_settings (
        id, company_name, company_subtitle, logo_url,
        customer_header_text, customer_footer_text,
        employee_header_text, employee_footer_text,
        voucher_receipt_title, voucher_payment_title, voucher_footer_text,
        report_header_text, report_footer_text, accent_color
      ) VALUES (1, 'OmniSystem Pro', 'نظام نقاط البيع وإدارة الموارد', '/omnisystem-logo.png', 'كشف حساب عميل معتمد', 'شكراً لتعاملكم معنا - يُرجى مراجعة الحسابات خلال 15 يوماً', 'كشف حساب ومسير رواتب موظف', 'إدارة الموارد البشرية - التوقيع والاعتماد', 'سند قبض', 'سند صرف', 'المحاسب _______ المدير _______ المستلم _______', 'تقرير عام شامل', 'طبع بواسطة نظام OmniSystem Pro', '#2563eb')
    `).run();
    row = db.prepare("SELECT * FROM document_print_settings WHERE id = 1").get();
  }
  res.json({
    companyName: row.company_name,
    companySubtitle: row.company_subtitle,
    logoUrl: row.logo_url,
    customerHeaderText: row.customer_header_text,
    customerFooterText: row.customer_footer_text,
    employeeHeaderText: row.employee_header_text,
    employeeFooterText: row.employee_footer_text,
    voucherReceiptTitle: row.voucher_receipt_title,
    voucherPaymentTitle: row.voucher_payment_title,
    voucherFooterText: row.voucher_footer_text,
    reportHeaderText: row.report_header_text,
    reportFooterText: row.report_footer_text,
    accentColor: row.accent_color,
  });
});

router.put("/document-print-settings", (req, res) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) {
    res.status(403).json({ error: "غير مصرح" });
    return;
  }

  const {
    companyName,
    companySubtitle,
    logoUrl,
    customerHeaderText,
    customerFooterText,
    employeeHeaderText,
    employeeFooterText,
    voucherReceiptTitle,
    voucherPaymentTitle,
    voucherFooterText,
    reportHeaderText,
    reportFooterText,
    accentColor,
  } = req.body;

  db.prepare(`
    UPDATE document_print_settings SET
      company_name = ?,
      company_subtitle = ?,
      logo_url = ?,
      customer_header_text = ?,
      customer_footer_text = ?,
      employee_header_text = ?,
      employee_footer_text = ?,
      voucher_receipt_title = ?,
      voucher_payment_title = ?,
      voucher_footer_text = ?,
      report_header_text = ?,
      report_footer_text = ?,
      accent_color = ?
    WHERE id = 1
  `).run(
    companyName,
    companySubtitle,
    logoUrl,
    customerHeaderText,
    customerFooterText,
    employeeHeaderText,
    employeeFooterText,
    voucherReceiptTitle,
    voucherPaymentTitle,
    voucherFooterText,
    reportHeaderText,
    reportFooterText,
    accentColor
  );

  const row = db.prepare("SELECT * FROM document_print_settings WHERE id = 1").get() as any;
  res.json({
    companyName: row.company_name,
    companySubtitle: row.company_subtitle,
    logoUrl: row.logo_url,
    customerHeaderText: row.customer_header_text,
    customerFooterText: row.customer_footer_text,
    employeeHeaderText: row.employee_header_text,
    employeeFooterText: row.employee_footer_text,
    voucherReceiptTitle: row.voucher_receipt_title,
    voucherPaymentTitle: row.voucher_payment_title,
    voucherFooterText: row.voucher_footer_text,
    reportHeaderText: row.report_header_text,
    reportFooterText: row.report_footer_text,
    accentColor: row.accent_color,
  });
});

export default router;
