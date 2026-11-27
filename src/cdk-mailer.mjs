import nodemailer from "nodemailer";
import { cdkError } from "./cdk-security.mjs";

export function createCdkMailer(environment = process.env) {
  const user = environment.TOSUB2_SMTP_USER;
  const pass = environment.TOSUB2_SMTP_PASSWORD;
  const configured = Boolean(user && pass);
  const port = Number(environment.TOSUB2_SMTP_PORT || 465);
  const transport = configured ? nodemailer.createTransport({
    host: environment.TOSUB2_SMTP_HOST || "smtp.qq.com", port, secure: port === 465, requireTLS: port !== 465,
    auth: { user, pass }, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
  }) : null;
  return {
    configured,
    async sendCode({ email, code, purpose }) {
      if (!transport) throw cdkError(503, "发信服务尚未配置，请联系管理员", "SMTP_UNAVAILABLE");
      try {
        const result = await transport.sendMail({ from: { name: "账号工作台", address: user }, to: { address: email },
          subject: `账号工作台 · ${purpose}`, text: `你的验证码是：${code}\n\n用途：${purpose}\n验证码 5 分钟内有效，仅可使用一次。请在发起验证的页面输入。\n如非本人操作，请忽略此邮件。` });
        if (!result.accepted?.length || result.rejected?.length) throw new Error("recipient rejected");
      } catch { throw cdkError(503, "验证码邮件发送失败，请稍后重试或联系管理员", "SMTP_SEND_FAILED"); }
    },
  };
}
