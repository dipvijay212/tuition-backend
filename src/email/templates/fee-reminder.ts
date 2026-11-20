import { escapeHtml, wrapHtmlTemplate } from "./common.js";

export type FeeReminderItem = { description: string; dueDate: string; balance: number; kind: "before" | "due" | "after" };

export type FeeReminderEmailProps = {
  instituteName?: string;
  institutePhone?: string | null;
  studentName: string;
  admissionNo?: string | null;
  items: FeeReminderItem[];
  /** Link to the parent/student portal sign-in (institute code pre-filled). */
  portalLink?: string;
};

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
};
const LABEL: Record<FeeReminderItem["kind"], { text: string; color: string }> = {
  before: { text: "Upcoming", color: "#fbbf24" },
  due: { text: "Due today", color: "#fbbf24" },
  after: { text: "Overdue", color: "#fb7185" },
};

export function renderFeeReminderEmail(props: FeeReminderEmailProps): { subject: string; html: string; text: string } {
  const overdue = props.items.some((i) => i.kind === "after");
  const dueToday = props.items.some((i) => i.kind === "due");
  const total = props.items.reduce((s, i) => s + i.balance, 0);
  const subject = overdue
    ? `Fee overdue: ${inr(total)} for ${props.studentName}`
    : dueToday
      ? `Fee due today: ${inr(total)} for ${props.studentName}`
      : `Fee reminder: ${inr(total)} due soon for ${props.studentName}`;
  const intro = overdue
    ? "The following fee payment is past its due date. Please pay at the earliest to avoid any late fee."
    : dueToday
      ? "This is a reminder that the following fee is due today."
      : "This is a friendly reminder about an upcoming fee payment.";

  const rows = props.items
    .map(
      (i) => `
      <div class="info-row">
        <span class="info-label">${escapeHtml(i.description)}<br><span style="font-size: 12px; color: ${LABEL[i.kind].color};">${LABEL[i.kind].text} · due ${escapeHtml(fmtDate(i.dueDate))}</span></span>
        <span class="info-value">${inr(i.balance)}</span>
      </div>`,
    )
    .join("");

  const bodyHtml = `
    <div style="margin-bottom: 24px;">
      <span class="badge ${overdue ? "badge-rose" : "badge-amber"}">${overdue ? "Payment Overdue" : "Fee Reminder"}</span>
      <h2 style="color: #ffffff; font-size: 20px; font-weight: 700; margin: 12px 0 6px 0;">${overdue ? "Fee Payment Overdue" : "Fee Payment Reminder"}</h2>
      <p style="margin: 0; color: #94a3b8; font-size: 14px;">${intro}</p>
    </div>

    <div class="highlight-box">
      <div style="font-size: 13px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px;">Amount Due</div>
      <div class="highlight-amount">${inr(total)}</div>
      <div style="font-size: 12px; color: #cbd5e1; margin-top: 4px;">Student: <strong style="color: #ffffff;">${escapeHtml(props.studentName)}</strong>${props.admissionNo ? ` (${escapeHtml(props.admissionNo)})` : ""}</div>
    </div>

    <div class="info-card">${rows}</div>

    <p style="font-size: 14px; color: #cbd5e1; margin-top: 20px; line-height: 1.5;">
      If you have already paid, please ignore this message. The receipt will be sent to you once the payment is recorded.
    </p>
    ${props.portalLink ? `<p style="font-size: 14px; margin-top: 12px;"><a href="${escapeHtml(props.portalLink)}" style="color: #818cf8;">View fees in the portal</a></p>` : ""}
    ${props.institutePhone ? `
    <div style="margin-top: 16px; padding: 12px; background-color: #0b0f19; border-radius: 6px; border: 1px solid #1e293b; font-size: 13px; color: #94a3b8;">
      Questions? Call the institute: <strong style="color: #f1f5f9;">${escapeHtml(props.institutePhone)}</strong>
    </div>` : ""}
  `;

  const html = wrapHtmlTemplate({
    title: subject,
    preheader: `${inr(total)} ${overdue ? "overdue" : "due"} for ${props.studentName}`,
    bodyHtml,
    instituteName: props.instituteName,
  });

  const text = [
    overdue ? "Fee Payment Overdue" : "Fee Payment Reminder",
    `Institute: ${props.instituteName ?? "Tuition Management"}`,
    `Student: ${props.studentName}${props.admissionNo ? ` (${props.admissionNo})` : ""}`,
    "",
    ...props.items.map((i) => `- ${i.description}: ${inr(i.balance)} (${LABEL[i.kind].text}, due ${fmtDate(i.dueDate)})`),
    "",
    `Total due: ${inr(total)}`,
    "If you have already paid, please ignore this message.",
    props.portalLink ? `Portal: ${props.portalLink}` : "",
    props.institutePhone ? `Institute phone: ${props.institutePhone}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return { subject, html, text };
}
