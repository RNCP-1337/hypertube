import { createTransport, type Transporter } from 'nodemailer';
import { config } from '../config';

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;
  transporter = createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth:
      config.SMTP_USER && config.SMTP_PASSWORD
        ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
        : undefined,
    // MailHog presents a self-signed certificate.
    tls: { rejectUnauthorized: config.NODE_ENV === 'production' },
  });
  return transporter;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface MailContent {
  subject: string;
  intro: string;
  action: string;
  outro: string;
}

const TEMPLATES: Record<string, MailContent> = {
  en: {
    subject: 'Reset your Hypertube password',
    intro: 'We received a request to reset your Hypertube password.',
    action: 'Choose a new password',
    outro: 'This link expires in one hour. If you did not ask for it, ignore this e-mail.',
  },
  fr: {
    subject: 'Réinitialisez votre mot de passe Hypertube',
    intro: 'Nous avons reçu une demande de réinitialisation de votre mot de passe Hypertube.',
    action: 'Choisir un nouveau mot de passe',
    outro: "Ce lien expire dans une heure. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.",
  },
  es: {
    subject: 'Restablece tu contraseña de Hypertube',
    intro: 'Hemos recibido una solicitud para restablecer tu contraseña de Hypertube.',
    action: 'Elegir una nueva contraseña',
    outro: 'Este enlace caduca en una hora. Si no lo solicitaste, ignora este correo.',
  },
};

function layout(username: string, link: string, content: MailContent): string {
  const safeUser = escapeHtml(username);
  const safeLink = escapeHtml(link);
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#0d1117;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e6edf3">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="100%" style="max-width:520px;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px">
          <tr><td>
            <h1 style="margin:0 0 8px;font-size:20px;color:#f0f6fc">Hypertube</h1>
            <p style="margin:0 0 16px;color:#8b949e">${escapeHtml(`Hi ${safeUser},`)}</p>
            <p style="margin:0 0 24px;line-height:1.6">${escapeHtml(content.intro)}</p>
            <p style="margin:0 0 24px">
              <a href="${safeLink}"
                 style="display:inline-block;background:#e63946;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">
                ${escapeHtml(content.action)}
              </a>
            </p>
            <p style="margin:0 0 8px;color:#8b949e;font-size:13px;line-height:1.6">${escapeHtml(content.outro)}</p>
            <p style="margin:0;color:#6e7681;font-size:12px;word-break:break-all">${safeLink}</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export async function sendPasswordResetEmail(options: {
  to: string;
  username: string;
  token: string;
  language: string;
}): Promise<void> {
  const content = TEMPLATES[options.language] ?? TEMPLATES.en;
  const link = `${config.PUBLIC_URL}/reset-password?token=${encodeURIComponent(options.token)}`;

  await getTransporter().sendMail({
    from: config.MAIL_FROM,
    to: options.to,
    subject: content.subject,
    text: `${content.intro}\n\n${link}\n\n${content.outro}`,
    html: layout(options.username, link, content),
  });
}

export async function verifyMailer(): Promise<boolean> {
  try {
    await getTransporter().verify();
    return true;
  } catch {
    return false;
  }
}
