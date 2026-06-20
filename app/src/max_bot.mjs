import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPayment, getDashboard } from "./repository.mjs";
import { normalizeInt, query, run, sqlDate, sqlInt, sqlRequiredText, sqlText } from "./sql.mjs";

const API_BASE = "https://platform-api.max.ru";
const POLL_TIMEOUT_SECONDS = 25;
const RETRY_DELAY_MS = 5000;
const MAX_COMMENT_LENGTH = 500;
const LINK_FLOW_CODE = "awaiting_link_code";
const PAYMENT_FLOW_DETAILS = "awaiting_payment_details";
const PAYMENT_FLOW_SCREENSHOT = "awaiting_payment_screenshot";
const MAIN_MENU_BUTTONS = {
  me: "Мой дом",
  summary: "Сводка",
  map: "Карта улицы",
  pay: "Отправить платеж",
  pending: "Ожидают проверки"
};
const CANCEL_BUTTON_TEXT = "Отменить";
const UPDATE_TYPES = ["message_created", "bot_started"];
const MAX_BOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_CARD_SCRIPT = path.resolve(MAX_BOT_DIR, "../scripts/render_dashboard_card.py");
const PYTHON_CANDIDATES = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];

export function startMaxBot({ logger = console } = {}) {
  const token = String(process.env.MAX_BOT_TOKEN || "").trim();
  if (!token || process.env.MAX_BOT_ENABLED === "false") return null;

  const bot = new MaxWaterBot({
    token,
    apiBase: String(process.env.MAX_BOT_API_BASE || API_BASE).replace(/\/+$/, ""),
    adminIds: parseAdminIds(),
    webhookUrl: normalizeWebhookUrl(process.env.MAX_BOT_WEBHOOK_URL || ""),
    webhookSecret: String(process.env.MAX_BOT_WEBHOOK_SECRET || "").trim(),
    pollingEnabled: process.env.MAX_BOT_POLLING_ENABLED === "true",
    logger
  });
  bot.start();
  return bot;
}

export function getMaxBotStatus(bot) {
  if (bot) return bot.getStatus();

  const configured = Boolean(String(process.env.MAX_BOT_TOKEN || "").trim());
  const explicitlyDisabled = process.env.MAX_BOT_ENABLED === "false";
  const webhookUrl = normalizeWebhookUrl(process.env.MAX_BOT_WEBHOOK_URL || "");
  return {
    configured,
    enabled: configured && !explicitlyDisabled,
    running: false,
    mode: webhookUrl ? "webhook" : process.env.MAX_BOT_POLLING_ENABLED === "true" ? "polling" : "idle",
    username: "",
    adminCount: parseAdminIds().size,
    webhookUrl,
    webhookSubscribed: false,
    startedAt: null,
    lastPollAt: null,
    lastUpdateAt: null,
    lastError: configured ? (explicitlyDisabled ? "MAX bot is disabled by MAX_BOT_ENABLED=false" : "Bot is not running") : "MAX_BOT_TOKEN is not set",
    lastErrorAt: null,
    processedUpdates: 0
  };
}

class MaxWaterBot {
  constructor({ token, apiBase, adminIds, webhookUrl, webhookSecret, pollingEnabled, logger }) {
    this.token = token;
    this.apiBase = apiBase;
    this.adminIds = adminIds;
    this.webhookUrl = webhookUrl;
    this.webhookSecret = webhookSecret;
    this.pollingEnabled = pollingEnabled;
    this.logger = logger;
    this.marker = null;
    this.stopped = false;
    this.username = "";
    this.status = {
      configured: true,
      enabled: true,
      running: false,
      mode: webhookUrl ? "webhook" : pollingEnabled ? "polling" : "idle",
      username: "",
      adminCount: adminIds.size,
      webhookUrl,
      webhookSubscribed: false,
      startedAt: null,
      lastPollAt: null,
      lastUpdateAt: null,
      lastError: "",
      lastErrorAt: null,
      processedUpdates: 0
    };
  }

  start() {
    this.status.startedAt = new Date().toISOString();
    this.loopPromise = this.run();
  }

  stop() {
    this.stopped = true;
    this.status.running = false;
  }

  getStatus() {
    return { ...this.status };
  }

  async run() {
    await this.initializeBot();
    if (this.webhookUrl) {
      await this.subscribeWebhook();
      return;
    }
    if (this.pollingEnabled) {
      await this.pollLoop();
      return;
    }

    this.status.running = true;
    this.logger.log("MAX bot is configured. Set MAX_BOT_WEBHOOK_URL for production webhook delivery or MAX_BOT_POLLING_ENABLED=true for local polling.");
  }

  async initializeBot() {
    try {
      const me = await this.api("GET", "/me");
      this.username = me.username || "";
      this.status.username = this.username;
      this.status.running = true;
      this.status.lastError = "";
      this.logger.log(`MAX bot ${this.username ? `@${this.username}` : me.first_name || "unknown"} initialized.`);
      if (!this.adminIds.size) {
        this.logger.warn("MAX_ADMIN_IDS is empty; MAX payment approval is disabled.");
      }
    } catch (error) {
      this.status.running = false;
      this.status.lastError = error.message;
      this.status.lastErrorAt = new Date().toISOString();
      this.logger.warn(`MAX bot initialization failed: ${error.message}`);
    }
  }

  async subscribeWebhook() {
    try {
      const body = {
        url: this.webhookUrl,
        update_types: UPDATE_TYPES
      };
      if (this.webhookSecret) body.secret = this.webhookSecret;

      const result = await this.api("POST", "/subscriptions", { body });
      if (result && result.success === false) {
        throw new Error(result.message || "MAX webhook subscription failed");
      }

      this.status.running = true;
      this.status.webhookSubscribed = true;
      this.status.lastError = "";
      this.logger.log(`MAX webhook subscribed: ${this.webhookUrl}`);
      if (!this.webhookSecret) this.logger.warn("MAX_BOT_WEBHOOK_SECRET is not set; webhook origin header will not be checked.");
    } catch (error) {
      this.status.running = false;
      this.status.webhookSubscribed = false;
      this.status.lastError = error.message;
      this.status.lastErrorAt = new Date().toISOString();
      this.logger.warn(`MAX webhook subscription failed: ${error.message}`);
    }
  }

  async pollLoop() {
    while (!this.stopped) {
      try {
        const params = {
          limit: "100",
          timeout: String(POLL_TIMEOUT_SECONDS),
          types: UPDATE_TYPES.join(",")
        };
        if (this.marker !== null && this.marker !== undefined) params.marker = String(this.marker);
        const data = await this.api("GET", "/updates", { params });
        this.status.running = true;
        this.status.lastPollAt = new Date().toISOString();
        this.status.lastError = "";

        const updates = Array.isArray(data?.updates) ? data.updates : [];
        if (data?.marker !== undefined) this.marker = data.marker;
        for (const update of updates) await this.handleUpdate(update);
      } catch (error) {
        this.status.running = false;
        this.status.lastError = error.message;
        this.status.lastErrorAt = new Date().toISOString();
        this.logger.warn(`MAX bot polling failed: ${error.message}`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  async handleWebhook(body, headers = {}) {
    if (this.webhookSecret) {
      const received = String(headers["x-max-bot-api-secret"] || headers["X-Max-Bot-Api-Secret"] || "").trim();
      if (received !== this.webhookSecret) {
        this.status.lastError = "MAX webhook secret mismatch";
        this.status.lastErrorAt = new Date().toISOString();
        return { ok: false, status: 401, error: "Unauthorized" };
      }
    }

    const updates = Array.isArray(body?.updates) ? body.updates : Array.isArray(body) ? body : [body];
    for (const update of updates.filter(Boolean)) await this.handleUpdate(update);
    this.status.running = true;
    this.status.lastError = "";
    return { ok: true, status: 200 };
  }

  async api(method, path, { params = {}, body = null } = {}) {
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method,
      headers: {
        authorization: this.token,
        ...(body ? { "content-type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || data.error || `${method} ${path} failed with HTTP ${response.status}`);
      error.code = data.code || "";
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async uploadMedia({ type, buffer, filename, contentType }) {
    const upload = await this.api("POST", "/uploads", { params: { type } });
    if (!upload?.url) throw new Error("MAX upload URL was not returned");

    const form = new FormData();
    form.append("data", new Blob([buffer], { type: contentType || "application/octet-stream" }), filename || "file");
    const response = await fetch(upload.url, { method: "POST", body: form });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.message || result.error || `MAX media upload failed with HTTP ${response.status}`);
    }
    return { ...upload, ...result };
  }

  async sendMessage(target, text, extra = {}) {
    const body = {
      text: limitMaxText(text),
      notify: true,
      ...extra
    };
    const params = targetParams(target);
    let message;
    try {
      message = await this.api("POST", "/messages", { params, body });
    } catch (error) {
      const fallback = fallbackTargetParams(target);
      if (!fallback) throw error;
      message = await this.api("POST", "/messages", { params: fallback, body });
    }

    await logMaxMessage({
      target,
      direction: "out",
      kind: "text",
      maxMessageId: extractMessageId(message?.message || message),
      text
    }).catch((error) => this.logger.warn(`Failed to log MAX outgoing message: ${error.message}`));
    return message;
  }

  async sendImage(target, imageBuffer, caption, extra = {}) {
    const upload = await this.uploadMedia({
      type: "image",
      buffer: imageBuffer,
      filename: "street-map.png",
      contentType: "image/png"
    });
    const attachments = [{ type: "image", payload: upload }, ...attachmentsFromExtra(extra)];
    const body = {
      text: limitMaxText(caption),
      notify: true,
      ...extra,
      attachments
    };
    const message = await this.sendMessageWithAttachmentRetry(target, body);

    await logMaxMessage({
      target,
      direction: "out",
      kind: "image",
      maxMessageId: extractMessageId(message?.message || message),
      text: caption,
      attachmentJson: JSON.stringify({ type: "image", payload: upload })
    }).catch((error) => this.logger.warn(`Failed to log MAX outgoing image: ${error.message}`));
    return message;
  }

  async sendMessageWithAttachmentRetry(target, body) {
    const delays = [0, 1000, 2500, 5000];
    let lastError = null;

    for (const delay of delays) {
      if (delay) await sleep(delay);
      try {
        return await this.api("POST", "/messages", { params: targetParams(target), body });
      } catch (error) {
        lastError = error;
        const fallback = fallbackTargetParams(target);
        if (fallback) {
          try {
            return await this.api("POST", "/messages", { params: fallback, body });
          } catch (fallbackError) {
            lastError = fallbackError;
          }
        }
        if (error.code !== "attachment.not.ready") throw error;
      }
    }

    throw lastError || new Error("MAX attachment was not ready");
  }

  async handleUpdate(update) {
    try {
      this.status.processedUpdates += 1;
      this.status.lastUpdateAt = new Date().toISOString();

      if (update?.update_type === "bot_started") {
        const event = extractEvent(update);
        if (!event.userId) return;
        await upsertMaxUser(event.user);
        await this.sendHelp(event.target, true, event.user);
        return;
      }

      if (update?.update_type !== "message_created" && update?.update_type !== "message_callback") return;
      const event = extractEvent(update);
      if (!event.userId) return;

      await upsertMaxUser(event.user);
      await logIncomingMaxMessage(update, event).catch((error) => this.logger.warn(`Failed to log MAX incoming message: ${error.message}`));

      const text = event.text.trim();
      if (event.screenshot) {
        const handledImage = await this.handlePaymentScreenshot({ event, text });
        if (handledImage) return;
      }

      if (!text) {
        await this.sendMessage(event.target, "Пришлите команду или выберите действие кнопками.", mainMenuMarkup(this.isAdmin(event.user)));
        return;
      }

      const command = parseCommand(text, this.username);
      if (command) {
        await this.handleCommand({ event, command });
        return;
      }

      const handledMenu = await this.handleMenuText({ event, text });
      if (handledMenu) return;

      const handledState = await this.handleStateText({ event, text });
      if (handledState) return;

      if (isDebtSummaryText(text)) {
        await this.sendDashboard(event.target, mainMenuMarkup(this.isAdmin(event.user)));
        return;
      }

      if (isStreetMapText(text)) {
        await this.sendDashboardCard(event.target, event.user, mainMenuMarkup(this.isAdmin(event.user)));
        return;
      }

      if (isMyDebtText(text)) {
        await this.sendMyHouse(event.target, event.userId, mainMenuMarkup(this.isAdmin(event.user)));
        return;
      }

      const payment = parsePaymentInput(text);
      if (payment) {
        await this.submitPayment({ event, payment });
        return;
      }

      const houseNumber = parseHouseNumber(text);
      if (houseNumber) {
        await this.sendHouse(event.target, houseNumber, mainMenuMarkup(this.isAdmin(event.user)));
        return;
      }

      await this.sendHelp(event.target, true, event.user);
    } catch (error) {
      this.status.lastError = error.message;
      this.status.lastErrorAt = new Date().toISOString();
      this.logger.warn(`MAX update failed: ${error.message}`);
    }
  }

  async handleCommand({ event, command }) {
    const user = event.user;
    const target = event.target;
    const name = command.name;

    if (["start", "help"].includes(name)) {
      if (name === "start" && command.args) {
        const linked = await this.tryLinkHouse(target, event.userId, command.args);
        if (linked) return;
      }
      await this.sendHelp(target, true, user);
      return;
    }

    if (["debts", "debtors", "summary", "dolg", "dolgi", "долги"].includes(name)) {
      await this.sendDashboard(target, mainMenuMarkup(this.isAdmin(user)));
      return;
    }

    if (["map", "street", "dashboard", "карта", "улица"].includes(name)) {
      await this.sendDashboardCard(target, user, mainMenuMarkup(this.isAdmin(user)));
      return;
    }

    if (["house", "dom", "h", "дом"].includes(name)) {
      const houseNumber = parseHouseNumber(command.args);
      if (!houseNumber) {
        await this.sendMessage(target, "Напишите номер дома: /house 12", mainMenuMarkup(this.isAdmin(user)));
        return;
      }
      await this.sendHouse(target, houseNumber, mainMenuMarkup(this.isAdmin(user)));
      return;
    }

    if (["me", "my", "mine", "мой"].includes(name)) {
      await this.sendMyHouse(target, event.userId, mainMenuMarkup(this.isAdmin(user)));
      return;
    }

    if (["link", "bind", "привязать"].includes(name)) {
      if (command.args) await this.tryLinkHouse(target, event.userId, command.args, { showUsage: true });
      else await this.beginLinkFlow(target, event.userId);
      return;
    }

    if (["pay", "payment", "оплата", "платеж", "платёж"].includes(name)) {
      const payment = await this.parsePaymentFromText(command.args, event.userId);
      if (!payment) {
        await this.beginPaymentFlow(target, event.userId);
        return;
      }
      await this.submitPayment({ event, payment });
      return;
    }

    if (name === "pending") {
      await this.sendPendingClaims(target, user, mainMenuMarkup(this.isAdmin(user)));
      return;
    }

    if (name === "approve") {
      await this.handleReviewCommand(target, user, command.args, "approve");
      return;
    }

    if (name === "reject") {
      await this.handleReviewCommand(target, user, command.args, "reject");
      return;
    }

    await this.sendHelp(target, true, user);
  }

  async sendHelp(target, isPrivate, user = null) {
    const lines = [
      "Выберите действие кнопками или используйте команды:",
      "/debts - общая сводка по долгам",
      "/map - карта улицы с домами",
      "/house 12 - информация по дому",
      "/link h12-xxxxxxxxxxxx - привязать дом",
      "/me - посмотреть свой дом",
      "/pay 12 1500 комментарий - отправить платеж на проверку"
    ];
    if (this.isAdmin(user)) {
      lines.push("/pending - заявки на проверке", "/approve 123 - подтвердить заявку", "/reject 123 - отклонить заявку");
    }
    await this.sendMessage(target, lines.join("\n"), isPrivate ? mainMenuMarkup(this.isAdmin(user)) : {});
  }

  async handleMenuText({ event, text }) {
    const action = mainMenuActionFromText(text);
    if (!action) return false;

    await clearMaxUserState(event.userId);

    if (action === "cancel") {
      await this.sendMessage(event.target, "Действие отменено.", mainMenuMarkup(this.isAdmin(event.user)));
      return true;
    }
    if (action === "summary") {
      await this.sendDashboard(event.target, mainMenuMarkup(this.isAdmin(event.user)));
      return true;
    }
    if (action === "map") {
      await this.sendDashboardCard(event.target, event.user, mainMenuMarkup(this.isAdmin(event.user)));
      return true;
    }
    if (action === "me") {
      await this.sendMyHouse(event.target, event.userId, mainMenuMarkup(this.isAdmin(event.user)));
      return true;
    }
    if (action === "pay") {
      await this.beginPaymentFlow(event.target, event.userId);
      return true;
    }
    if (action === "pending") {
      await this.sendPendingClaims(event.target, event.user, mainMenuMarkup(this.isAdmin(event.user)));
      return true;
    }

    return false;
  }

  async beginLinkFlow(target, userId) {
    await setMaxUserState(userId, LINK_FLOW_CODE, {});
    await this.sendMessage(target, "Пришлите код доступа дома из ссылки вида h12-xxxxxxxxxxxx.", cancelMarkup());
  }

  async beginPaymentFlow(target, userId) {
    const linkedHouse = await getLinkedHouse(userId);
    await setMaxUserState(userId, PAYMENT_FLOW_DETAILS, {
      houseNumber: linkedHouse?.house_number || null
    });
    const text = linkedHouse?.house_number
      ? `Введите сумму платежа по ${linkedHouse.house_number} дому и комментарий при необходимости.`
      : "Введите номер дома, сумму платежа и комментарий при необходимости.";
    await this.sendMessage(target, `${text}\n\nПример: ${linkedHouse?.house_number ? "1500 СБП" : "12 1500 СБП"}`, cancelMarkup());
  }

  async handleStateText({ event, text }) {
    const state = await getMaxUserState(event.userId);
    if (!state?.state) return false;

    if (state.state === LINK_FLOW_CODE) {
      const linked = await this.tryLinkHouse(event.target, event.userId, text, { showUsage: true });
      if (linked) await clearMaxUserState(event.userId);
      return true;
    }

    if (state.state === PAYMENT_FLOW_DETAILS) {
      const payload = parseStatePayload(state.state_payload);
      const payment = parsePaymentInput(text) || parseLinkedPaymentInput(text, payload.houseNumber);
      if (!payment) {
        await this.sendPaymentUsage(event.target);
        return true;
      }
      if (payload.screenshotAttachment) {
        await this.submitPayment({
          event,
          payment,
          screenshot: {
            attachment: payload.screenshotAttachment,
            messageId: payload.screenshotMessageId || event.messageId
          }
        });
        return true;
      }
      await this.submitPayment({ event, payment });
      return true;
    }

    return false;
  }

  async askPaymentDetailsForScreenshot({ event, payload = {} }) {
    await setMaxUserState(event.userId, PAYMENT_FLOW_DETAILS, {
      houseNumber: payload.houseNumber || null,
      screenshotAttachment: event.screenshot,
      screenshotMessageId: event.messageId
    });
    await this.sendMessage(
      event.target,
      payload.houseNumber
        ? `Скрин получил. Теперь введите сумму платежа по ${payload.houseNumber} дому и комментарий при необходимости.\n\nПример: 1500 СБП`
        : "Скрин получил. Теперь введите номер дома, сумму платежа и комментарий при необходимости.\n\nПример: 36 1500 СБП",
      cancelMarkup()
    );
  }

  async preparePaymentScreenshot({ event, payment }) {
    const house = await findHouseByNumber(payment.houseNumber);
    if (!house) {
      await this.sendMessage(event.target, `Дом ${payment.houseNumber} не найден.`, mainMenuMarkup(this.isAdmin(event.user)));
      return;
    }

    await setMaxUserState(event.userId, PAYMENT_FLOW_SCREENSHOT, payment);
    await this.sendMessage(
      event.target,
      `Платеж: дом ${house.number}, ${rub(payment.amount)}, ${formatDate(payment.paidAt)}.\nТеперь отправьте скриншот платежа картинкой.`,
      cancelMarkup()
    );
  }

  async handlePaymentScreenshot({ event, text }) {
    const command = parseCommand(text, this.username);
    if (command?.name && ["pay", "payment", "оплата", "платеж", "платёж"].includes(command.name)) {
      const payment = await this.parsePaymentFromText(command.args, event.userId);
      if (!payment) {
        await this.sendPaymentUsage(event.target);
        return true;
      }
      await this.submitPayment({ event, payment, screenshot: { attachment: event.screenshot, messageId: event.messageId } });
      return true;
    }

    const state = await getMaxUserState(event.userId);
    if (state?.state === PAYMENT_FLOW_DETAILS) {
      const payload = parseStatePayload(state.state_payload);
      const payment = parsePaymentInput(text) || parseLinkedPaymentInput(text, payload.houseNumber);
      if (!payment) {
        await this.askPaymentDetailsForScreenshot({ event, payload });
        return true;
      }
      await this.submitPayment({ event, payment, screenshot: { attachment: event.screenshot, messageId: event.messageId } });
      return true;
    }

    if (state?.state !== PAYMENT_FLOW_SCREENSHOT) {
      if (text) {
        const payment = await this.parsePaymentFromText(text, event.userId);
        if (payment) {
          await this.submitPayment({ event, payment, screenshot: { attachment: event.screenshot, messageId: event.messageId } });
          return true;
        }
      }

      const linkedHouse = await getLinkedHouse(event.userId);
      await this.askPaymentDetailsForScreenshot({
        event,
        payload: { houseNumber: linkedHouse?.house_number || null }
      });
      return true;
    }

    const payment = parseStatePayload(state.state_payload);
    if (!payment?.houseNumber || !payment?.amount || !payment?.paidAt) {
      await clearMaxUserState(event.userId);
      await this.sendMessage(event.target, "Не удалось восстановить данные платежа. Начните заново.", mainMenuMarkup(this.isAdmin(event.user)));
      return true;
    }

    await this.submitPayment({ event, payment, screenshot: { attachment: event.screenshot, messageId: event.messageId } });
    return true;
  }

  async parsePaymentFromText(text, userId) {
    const linkedHouse = await getLinkedHouse(userId);
    return parsePaymentInput(text) || parseLinkedPaymentInput(text, linkedHouse?.house_number);
  }

  async sendPaymentUsage(target) {
    await this.sendMessage(
      target,
      "Формат платежа: /pay 12 1500 комментарий\nДата ставится автоматически. Заявка уйдет администратору на проверку.",
      cancelMarkup()
    );
  }

  async submitPayment({ event, payment, screenshot = null }) {
    const house = await findHouseByNumber(payment.houseNumber);
    if (!house) {
      await this.sendMessage(event.target, `Дом ${payment.houseNumber} не найден.`, mainMenuMarkup(this.isAdmin(event.user)));
      return;
    }

    if (this.isAdmin(event.user)) {
      const created = await createPayment({
        houseNumber: payment.houseNumber,
        amount: payment.amount,
        paidAt: payment.paidAt,
        method: "other",
        commentPublic: payment.comment,
        commentPrivate: `MAX admin payment from ${formatUserName(event.user)} (${event.userId})`,
        source: "max"
      });
      await clearMaxUserState(event.userId);
      await this.sendMessage(
        event.target,
        `Платеж записан.\nДом: ${payment.houseNumber}\nСумма: ${rub(payment.amount)}\nПлатеж ID: ${created.id}`,
        mainMenuMarkup(true)
      );
      return;
    }

    if (!screenshot?.attachment) {
      await this.preparePaymentScreenshot({ event, payment });
      return;
    }

    const claim = await createMaxPaymentClaim({
      house,
      user: event.user,
      target: event.target,
      messageId: event.messageId,
      payment,
      screenshot
    });
    await clearMaxUserState(event.userId);
    await this.sendMessage(
      event.target,
      `Заявка #${claim.id} отправлена администратору.\nДом: ${payment.houseNumber}\nСумма: ${rub(payment.amount)}\nПосле проверки платеж появится в базе.`,
      mainMenuMarkup(false)
    );
    await this.notifyAdminsAboutClaim(claim);
  }

  async notifyAdminsAboutClaim(claim) {
    if (!this.adminIds.size) return;
    const text = `${formatClaimForAdmin(claim)}\n\nКоманды: /approve ${claim.id} или /reject ${claim.id}`;
    const buttons = reviewMarkup(claim.id);
    for (const adminId of this.adminIds) {
      await this.sendMessage({ userId: adminId }, text, buttons).catch((error) =>
        this.logger.warn(`Failed to notify MAX admin ${adminId}: ${error.message}`)
      );
    }
  }

  async sendDashboard(target, extra = {}) {
    await this.sendMessage(target, formatDashboard(await getDashboard()), extra);
  }

  async sendDashboardCard(target, user, extra = {}) {
    try {
      const dashboard = await getDashboard();
      const png = await renderDashboardCardPng(dashboard);
      await this.sendImage(target, png, formatDashboardCardCaption(dashboard), extra);
    } catch (error) {
      this.logger.warn(`Failed to render MAX dashboard card: ${error.message}`);
      await this.sendMessage(
        target,
        "Не удалось собрать картинку улицы. Покажу обычную сводку.",
        extra || mainMenuMarkup(this.isAdmin(user))
      );
      await this.sendDashboard(target, extra || mainMenuMarkup(this.isAdmin(user)));
    }
  }

  async sendHouse(target, houseNumber, extra = {}) {
    const dashboard = await getDashboard();
    const house = dashboard.houses.find((item) => Number(item.number) === Number(houseNumber));
    if (!house) {
      await this.sendMessage(target, `Дом ${houseNumber} не найден.`, extra);
      return;
    }
    await this.sendMessage(target, formatHouseSummary({ ...house, asOfMonth: dashboard.asOfMonth }), extra);
  }

  async sendMyHouse(target, userId, extra = {}) {
    const linkedHouse = await getLinkedHouse(userId);
    if (!linkedHouse) {
      await this.sendMessage(target, "Дом пока не привязан. Отправьте /link h12-xxxxxxxxxxxx или код из вашей ссылки.", extra);
      return;
    }

    const dashboard = await getDashboard();
    const house = dashboard.houses.find((item) => Number(item.number) === Number(linkedHouse.house_number));
    if (!house) {
      await this.sendMessage(target, "Привязанный дом не найден в базе.", extra);
      return;
    }
    await this.sendMessage(target, formatHouseSummary({ ...house, asOfMonth: dashboard.asOfMonth }, { personal: true }), extra);
  }

  async tryLinkHouse(target, userId, text, { showUsage = false } = {}) {
    const accessCode = extractAccessCode(text);
    if (!accessCode) {
      if (showUsage) await this.sendMessage(target, "Пришлите код вида h12-xxxxxxxxxxxx или полную ссылку на дом.", cancelMarkup());
      return false;
    }

    const house = await findHouseByCode(accessCode);
    if (!house) {
      await this.sendMessage(target, "Код не найден. Проверьте ссылку или попросите администратора выдать новую.", cancelMarkup());
      return false;
    }

    await linkMaxUser(userId, house.id);
    await clearMaxUserState(userId);
    await this.sendMessage(target, `Готово, привязал дом ${house.number}.`, mainMenuMarkup(this.adminIds.has(String(userId))));
    return true;
  }

  async sendPendingClaims(target, user, extra = {}) {
    if (!this.isAdmin(user)) {
      await this.sendMessage(target, "Эта команда доступна только администратору.", extra);
      return;
    }

    const rows = await query(`
      SELECT c.*, h.number AS house_number
      FROM max_payment_claims c
      JOIN houses h ON h.id = c.house_id
      WHERE c.status = 'pending'
      ORDER BY c.created_at
      LIMIT 20
    `);
    if (!rows.length) {
      await this.sendMessage(target, "Заявок на проверке нет.", extra);
      return;
    }

    const lines = ["Заявки на проверке:", ...rows.map(formatClaimLine), "", "Подтверждение: /approve 123", "Отклонение: /reject 123"];
    await this.sendMessage(target, lines.join("\n"), extra);
  }

  async handleReviewCommand(target, user, args, action) {
    if (!this.isAdmin(user)) {
      await this.sendMessage(target, "Эта команда доступна только администратору.", mainMenuMarkup(false));
      return;
    }

    if (!/^\d+$/.test(String(args || "").trim())) {
      await this.sendMessage(target, action === "approve" ? "Формат: /approve 123" : "Формат: /reject 123", mainMenuMarkup(true));
      return;
    }

    const claimId = normalizeInt(args, "claim id");
    const result = action === "approve" ? await this.approveClaim(claimId, user) : await this.rejectClaim(claimId, user);
    await this.sendMessage(target, result.message, mainMenuMarkup(true));
  }

  async approveClaim(claimId, adminUser) {
    const result = await approveMaxPaymentClaim(claimId, getUserId(adminUser));
    if (result.claim?.status === "approved") {
      await this.notifySubmitter(result.claim, `Платеж по заявке #${claimId} подтвержден. Спасибо!`);
    }
    return result;
  }

  async rejectClaim(claimId, adminUser) {
    const result = await rejectMaxPaymentClaim(claimId, getUserId(adminUser));
    if (result.claim?.status === "rejected") {
      await this.notifySubmitter(result.claim, `Платеж по заявке #${claimId} отклонен. Свяжитесь с администратором.`);
    }
    return result;
  }

  async notifySubmitter(claim, text) {
    if (!claim?.max_user_id && !claim?.chat_id) return;
    await this.sendMessage({ userId: claim.max_user_id, chatId: claim.chat_id }, text, mainMenuMarkup(this.adminIds.has(String(claim.max_user_id)))).catch(
      (error) => this.logger.warn(`Failed to notify MAX payment submitter: ${error.message}`)
    );
  }

  async notifyPaymentDeleted({ payment, maxClaim }) {
    const notifications = { submitter: false, admins: 0 };
    if (!payment) return notifications;
    const claim = maxClaim || null;

    if (claim?.chat_id || claim?.max_user_id) {
      await this.sendMessage(
        { userId: claim.max_user_id, chatId: claim.chat_id },
        formatDeletedPaymentForSubmitter(payment, claim),
        mainMenuMarkup(this.adminIds.has(String(claim.max_user_id)))
      )
        .then(() => {
          notifications.submitter = true;
        })
        .catch((error) => this.logger.warn(`Failed to notify MAX deleted payment submitter: ${error.message}`));
    }

    const adminText = formatDeletedPaymentForAdmin(payment, claim);
    for (const adminId of this.adminIds) {
      await this.sendMessage({ userId: adminId }, adminText, mainMenuMarkup(true))
        .then(() => {
          notifications.admins += 1;
        })
        .catch((error) => this.logger.warn(`Failed to notify MAX admin ${adminId} about deleted payment: ${error.message}`));
    }

    return notifications;
  }

  isAdmin(user) {
    const id = getUserId(user);
    return Boolean(id && this.adminIds.has(String(id)));
  }
}

async function logIncomingMaxMessage(update, event) {
  await logMaxMessage({
    updateId: update?.marker || update?.update_id || update?.timestamp || "",
    target: event.target,
    direction: "in",
    kind: event.screenshot ? "image" : "text",
    maxMessageId: event.messageId,
    maxUserId: event.userId,
    text: event.text,
    attachmentJson: event.screenshot ? JSON.stringify(event.screenshot) : ""
  });
}

async function logMaxMessage(body) {
  await run(`
    INSERT INTO max_messages (
      update_id,
      max_message_id,
      max_user_id,
      chat_id,
      direction,
      kind,
      text,
      callback_payload,
      attachment_json
    )
    VALUES (
      ${sqlText(body.updateId || "")},
      ${sqlText(body.maxMessageId || "")},
      ${sqlText(body.maxUserId || body.target?.userId || "")},
      ${sqlText(body.target?.chatId || body.target?.userId || "")},
      ${sqlRequiredText(body.direction, "direction")},
      ${sqlText(body.kind || "text")},
      ${sqlText(body.text || "")},
      ${sqlText(body.callbackPayload || "")},
      ${sqlText(body.attachmentJson || "")}
    )
  `);
}

async function upsertMaxUser(user) {
  const userId = getUserId(user);
  if (!userId) return;
  await run(`
    INSERT INTO max_users (max_user_id, username, first_name, last_name)
    VALUES (
      ${sqlRequiredText(userId, "MAX user id")},
      ${sqlText(user.username || "")},
      ${sqlText(user.first_name || user.firstName || user.name || "")},
      ${sqlText(user.last_name || user.lastName || "")}
    )
    ON CONFLICT(max_user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      updated_at = CURRENT_TIMESTAMP
  `);
}

async function setMaxUserState(userId, state, payload = {}) {
  await run(`
    UPDATE max_users
    SET state = ${sqlText(state)},
        state_payload = ${sqlText(JSON.stringify(payload || {}))},
        updated_at = CURRENT_TIMESTAMP
    WHERE max_user_id = ${sqlRequiredText(userId, "MAX user id")}
  `);
}

async function clearMaxUserState(userId) {
  await setMaxUserState(userId, "", {});
}

async function getMaxUserState(userId) {
  const rows = await query(`
    SELECT state, state_payload
    FROM max_users
    WHERE max_user_id = ${sqlRequiredText(userId, "MAX user id")}
    LIMIT 1
  `);
  return rows[0] || null;
}

async function linkMaxUser(userId, houseId) {
  await run(`
    UPDATE max_users
    SET linked_house_id = ${sqlInt(houseId, "house id")},
        updated_at = CURRENT_TIMESTAMP
    WHERE max_user_id = ${sqlRequiredText(userId, "MAX user id")}
  `);
}

async function getLinkedHouse(userId) {
  const rows = await query(`
    SELECT h.id, h.number AS house_number, h.display_name
    FROM max_users mu
    JOIN houses h ON h.id = mu.linked_house_id
    WHERE mu.max_user_id = ${sqlRequiredText(userId, "MAX user id")}
    LIMIT 1
  `);
  return rows[0] || null;
}

async function findHouseByNumber(houseNumber) {
  const rows = await query(`SELECT * FROM houses WHERE number = ${sqlInt(houseNumber, "house number")} LIMIT 1`);
  return rows[0] || null;
}

async function findHouseByCode(accessCode) {
  const rows = await query(`SELECT * FROM houses WHERE access_code = ${sqlRequiredText(accessCode, "access code")} LIMIT 1`);
  return rows[0] || null;
}

async function createMaxPaymentClaim({ house, user, target, messageId, payment, screenshot = null }) {
  const rows = await query(`
    INSERT INTO max_payment_claims (
      house_id,
      max_user_id,
      chat_id,
      message_id,
      submitted_by_name,
      amount,
      paid_at,
      method,
      comment_public,
      comment_private,
      screenshot_attachment,
      screenshot_message_id
    )
    VALUES (
      ${sqlInt(house.id, "house id")},
      ${sqlRequiredText(getUserId(user), "MAX user id")},
      ${sqlRequiredText(target.chatId || target.userId, "chat id")},
      ${sqlText(messageId || "")},
      ${sqlText(formatUserName(user))},
      ${sqlInt(payment.amount, "amount")},
      ${sqlDate(payment.paidAt, "paid at")},
      ${sqlText("other")},
      ${sqlText(payment.comment || "")},
      ${sqlText(`MAX claim from ${formatUserName(user)} (${getUserId(user)})`)},
      ${sqlText(JSON.stringify(screenshot?.attachment || {}))},
      ${sqlText(screenshot?.messageId || "")}
    )
    RETURNING id
  `);
  return getMaxPaymentClaim(rows[0].id);
}

async function getMaxPaymentClaim(claimId) {
  const rows = await query(`
    SELECT
      c.*,
      h.number AS house_number,
      h.display_name AS house_display_name,
      mu.username,
      mu.first_name,
      mu.last_name
    FROM max_payment_claims c
    JOIN houses h ON h.id = c.house_id
    LEFT JOIN max_users mu ON mu.max_user_id = c.max_user_id
    WHERE c.id = ${sqlInt(claimId, "claim id")}
    LIMIT 1
  `);
  return rows[0] || null;
}

export async function approveMaxPaymentClaim(claimId, adminMaxUserId = "max-admin") {
  const rows = await query(`
    UPDATE max_payment_claims
    SET status = 'processing',
        admin_max_user_id = ${sqlRequiredText(adminMaxUserId, "admin id")},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlInt(claimId, "claim id")} AND status = 'pending'
    RETURNING *
  `);
  const claim = rows[0];
  if (!claim) {
    const current = await getMaxPaymentClaim(claimId);
    return {
      claim: current,
      message: current ? `Заявка #${claimId} уже не ожидает проверки: ${current.status}.` : `Заявка #${claimId} не найдена.`
    };
  }

  try {
    const house = await query(`SELECT number FROM houses WHERE id = ${sqlInt(claim.house_id, "house id")} LIMIT 1`);
    if (!house[0]) throw new Error(`House ${claim.house_id} not found`);

    const payment = await createPayment({
      houseNumber: house[0].number,
      amount: claim.amount,
      paidAt: claim.paid_at,
      method: claim.method || "other",
      commentPublic: claim.comment_public || "",
      commentPrivate: claim.comment_private || `MAX claim #${claim.id}`,
      source: "max"
    });

    await run(`
      UPDATE max_payment_claims
      SET status = 'approved',
          payment_id = ${sqlInt(payment.id, "payment id")},
          reviewed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlInt(claim.id, "claim id")}
    `);

    const approved = await getMaxPaymentClaim(claim.id);
    return { claim: approved, message: `Заявка #${claim.id} подтверждена. Платеж ID: ${payment.id}.` };
  } catch (error) {
    await run(`
      UPDATE max_payment_claims
      SET status = 'pending',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlInt(claim.id, "claim id")} AND status = 'processing'
    `);
    throw error;
  }
}

export async function rejectMaxPaymentClaim(claimId, adminMaxUserId = "max-admin") {
  const rows = await query(`
    UPDATE max_payment_claims
    SET status = 'rejected',
        admin_max_user_id = ${sqlRequiredText(adminMaxUserId, "admin id")},
        reviewed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlInt(claimId, "claim id")} AND status IN ('pending', 'processing')
    RETURNING *
  `);
  const claim = rows[0] || (await getMaxPaymentClaim(claimId));
  if (!rows[0]) {
    return {
      claim,
      message: claim ? `Заявка #${claimId} уже не ожидает проверки: ${claim.status}.` : `Заявка #${claimId} не найдена.`
    };
  }

  const rejected = await getMaxPaymentClaim(claimId);
  return { claim: rejected, message: `Заявка #${claimId} отклонена.` };
}

export async function getMaxAdminData() {
  const [users, pendingClaims, messages, houseMessages] = await Promise.all([
    query(`
      SELECT
        mu.max_user_id,
        mu.username,
        mu.first_name,
        mu.last_name,
        mu.state,
        mu.updated_at,
        h.number AS house_number,
        h.display_name AS house_display_name,
        (
          SELECT COUNT(*)
          FROM max_messages mm
          WHERE mm.max_user_id = mu.max_user_id
        ) AS message_count,
        (
          SELECT MAX(created_at)
          FROM max_messages mm
          WHERE mm.max_user_id = mu.max_user_id
        ) AS last_message_at
      FROM max_users mu
      LEFT JOIN houses h ON h.id = mu.linked_house_id
      ORDER BY COALESCE(last_message_at, mu.updated_at) DESC
      LIMIT 100
    `),
    query(`
      SELECT
        c.*,
        h.number AS house_number,
        h.display_name AS house_display_name,
        mu.username,
        mu.first_name,
        mu.last_name
      FROM max_payment_claims c
      JOIN houses h ON h.id = c.house_id
      LEFT JOIN max_users mu ON mu.max_user_id = c.max_user_id
      WHERE c.status = 'pending'
      ORDER BY c.created_at
      LIMIT 100
    `),
    query(`
      SELECT
        mm.*,
        mu.username,
        mu.first_name,
        mu.last_name,
        h.number AS house_number
      FROM max_messages mm
      LEFT JOIN max_users mu ON mu.max_user_id = COALESCE(NULLIF(mm.max_user_id, ''), mm.chat_id)
      LEFT JOIN houses h ON h.id = mu.linked_house_id
      ORDER BY mm.created_at DESC, mm.id DESC
      LIMIT 50
    `),
    query(`
      SELECT
        mm.*,
        mu.username,
        mu.first_name,
        mu.last_name,
        h.number AS house_number,
        h.display_name AS house_display_name
      FROM max_messages mm
      LEFT JOIN max_users mu ON mu.max_user_id = COALESCE(NULLIF(mm.max_user_id, ''), mm.chat_id)
      LEFT JOIN houses h ON h.id = mu.linked_house_id
      WHERE h.number IS NOT NULL
      ORDER BY mm.created_at DESC, mm.id DESC
      LIMIT 500
    `)
  ]);

  const messagesByHouse = {};
  for (const message of houseMessages) {
    const key = String(message.house_number || "");
    if (!key) continue;
    if (!messagesByHouse[key]) messagesByHouse[key] = [];
    if (messagesByHouse[key].length < 10) messagesByHouse[key].push({ ...message, channel: "max" });
  }

  return {
    users,
    pendingClaims,
    messages: messages.map((message) => ({ ...message, channel: "max" })),
    messagesByHouse
  };
}

export async function setMaxUserHouse(body) {
  const maxUserId = sqlRequiredText(body.maxUserId, "MAX user id");
  const userRows = await query(`
    SELECT id
    FROM max_users
    WHERE max_user_id = ${maxUserId}
    LIMIT 1
  `);
  if (!userRows[0]) throw new Error(`MAX user ${body.maxUserId} not found`);

  const rawHouseNumber = String(body.houseNumber || "").trim();
  if (!rawHouseNumber) {
    await run(`
      UPDATE max_users
      SET linked_house_id = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE max_user_id = ${maxUserId}
    `);
    return { ok: true, linked: false };
  }

  const house = await findHouseByNumber(rawHouseNumber);
  if (!house) throw new Error(`House ${rawHouseNumber} not found`);
  await linkMaxUser(body.maxUserId, house.id);
  return { ok: true, linked: true, houseNumber: house.number };
}

export async function upsertMaxUserFromAdmin(body) {
  const maxUserId = String(body.maxUserId || "").trim();
  if (!/^-?\d+$/.test(maxUserId)) throw new Error("MAX user id must be numeric");

  const rawHouseNumber = String(body.houseNumber || "").trim();
  if (!rawHouseNumber) throw new Error("house number is required");
  const house = await findHouseByNumber(rawHouseNumber);
  if (!house) throw new Error(`House ${rawHouseNumber} not found`);

  const username = String(body.username || "").trim().replace(/^@+/, "");
  const firstName = String(body.firstName || body.first_name || "").trim();
  const lastName = String(body.lastName || body.last_name || "").trim();

  const rows = await query(`
    INSERT INTO max_users (max_user_id, username, first_name, last_name, linked_house_id)
    VALUES (
      ${sqlRequiredText(maxUserId, "MAX user id")},
      ${sqlText(username)},
      ${sqlText(firstName)},
      ${sqlText(lastName)},
      ${sqlInt(house.id, "house id")}
    )
    ON CONFLICT(max_user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      linked_house_id = excluded.linked_house_id,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `);

  return { ok: true, id: rows[0]?.id || null, maxUserId, houseNumber: house.number };
}

function extractEvent(update) {
  const message = update?.message || update?.payload?.message || update?.data?.message || {};
  const body = message.body || update?.body || {};
  const attachments = Array.isArray(body.attachments)
    ? body.attachments
    : Array.isArray(message.attachments)
      ? message.attachments
      : Array.isArray(update?.attachments)
        ? update.attachments
        : [];
  const user = update?.user || message.sender || message.from || update?.sender || {};
  const userId = getUserId(user) || update?.user_id || message.sender_id || "";
  const chatId =
    update?.chat_id ||
    message.chat_id ||
    message.chat?.id ||
    message.recipient?.chat_id ||
    (message.recipient?.type === "chat" ? message.recipient?.id : "") ||
    "";
  const text = body.text || message.text || update?.text || "";
  const target = {
    userId: String(userId || ""),
    chatId: String(chatId || ""),
    preferChat: Boolean(chatId && !userId)
  };

  return {
    user: { ...user, user_id: userId || user.user_id || user.id },
    userId: String(userId || ""),
    target,
    text: String(text || ""),
    messageId: extractMessageId(message || update),
    attachments,
    screenshot: getFirstImageAttachment(attachments)
  };
}

function extractMessageId(message) {
  return String(message?.message_id || message?.id || message?.mid || "");
}

function getUserId(user) {
  return String(user?.user_id || user?.id || "").trim();
}

function targetParams(target) {
  if (target?.preferChat && target.chatId) return { chat_id: target.chatId };
  if (target?.userId) return { user_id: target.userId };
  if (target?.chatId) return { chat_id: target.chatId };
  return { user_id: String(target || "") };
}

function fallbackTargetParams(target) {
  if (target?.userId && target?.chatId) return { chat_id: target.chatId };
  return null;
}

function attachmentsFromExtra(extra = {}) {
  return Array.isArray(extra.attachments) ? extra.attachments : [];
}

function getFirstImageAttachment(attachments) {
  return (attachments || []).find((attachment) => ["image", "photo"].includes(String(attachment?.type || "").toLowerCase())) || null;
}

function parseAdminIds() {
  return new Set(
    String(process.env.MAX_ADMIN_IDS || "")
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function normalizeWebhookUrl(value) {
  const text = String(value || "").trim();
  return text ? text.replace(/\/+$/, "") : "";
}

function parseCommand(text, botUsername) {
  const trimmed = String(text || "").trim();
  const [head] = trimmed.split(/\s+/, 1);
  const match = head.match(/^\/([\p{L}0-9_]+)(?:@([A-Za-z0-9_]+))?$/u);
  if (!match) return null;

  const mention = match[2] || "";
  if (mention && botUsername && mention.toLowerCase() !== botUsername.toLowerCase()) return null;

  return {
    name: match[1].toLowerCase(),
    args: trimmed.slice(head.length).trim()
  };
}

function parseHouseNumber(text) {
  const match = String(text || "").match(/(?:^|\s)(?:дом|house|h)?\s*#?(\d{1,5})(?:\s|$)/i);
  return match ? Number(match[1]) : null;
}

function parsePaymentInput(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^\/pay(?:@\w+)?\s*/i, "")
    .replace(/^(?:оплатил|оплатила|оплата|плат[её]ж)\s+/i, "");
  const match = cleaned.match(/^(?:дом\s*)?(\d{1,5})\s+([0-9]+(?:[.,][0-9]+)?)\s*([\s\S]*)$/i);
  if (!match) return null;

  const amount = Math.round(Number(match[2].replace(",", ".")));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return {
    houseNumber: Number(match[1]),
    amount,
    paidAt: todayIso(),
    comment: cleanComment(match[3] || "")
  };
}

function parseLinkedPaymentInput(text, houseNumber) {
  if (!houseNumber) return null;
  const cleaned = String(text || "").trim().replace(/^\/pay(?:@\w+)?\s*/i, "");
  const match = cleaned.match(/^([0-9]+(?:[.,][0-9]+)?)\s*([\s\S]*)$/i);
  if (!match) return null;

  const amount = Math.round(Number(match[1].replace(",", ".")));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return {
    houseNumber: Number(houseNumber),
    amount,
    paidAt: todayIso(),
    comment: cleanComment(match[2] || "")
  };
}

function parseStatePayload(value) {
  try {
    return JSON.parse(value || "{}") || {};
  } catch {
    return {};
  }
}

function extractAccessCode(text) {
  const raw = String(text || "").trim();
  const urlMatch = raw.match(/\/h\/([A-Za-z0-9-]+)/);
  const code = (urlMatch ? urlMatch[1] : raw).trim();
  return /^h\d+-[a-f0-9]{12}$/i.test(code) ? code.toLowerCase() : "";
}

function mainMenuMarkup(isAdmin = false) {
  const buttons = [
    [
      { type: "message", text: MAIN_MENU_BUTTONS.me },
      { type: "message", text: MAIN_MENU_BUTTONS.summary }
    ],
    [{ type: "message", text: MAIN_MENU_BUTTONS.map }],
    [{ type: "message", text: MAIN_MENU_BUTTONS.pay }]
  ];
  if (isAdmin) buttons.push([{ type: "message", text: MAIN_MENU_BUTTONS.pending }]);
  return inlineKeyboard(buttons);
}

function cancelMarkup() {
  return inlineKeyboard([[{ type: "message", text: CANCEL_BUTTON_TEXT }]]);
}

function reviewMarkup(claimId) {
  return inlineKeyboard([
    [
      { type: "message", text: `/approve ${claimId}` },
      { type: "message", text: `/reject ${claimId}` }
    ]
  ]);
}

function inlineKeyboard(buttons) {
  return {
    attachments: [
      {
        type: "inline_keyboard",
        payload: { buttons }
      }
    ]
  };
}

function mainMenuActionFromText(text) {
  const normalized = normalizeMenuText(text);
  const actions = {
    [normalizeMenuText(MAIN_MENU_BUTTONS.me)]: "me",
    [normalizeMenuText(MAIN_MENU_BUTTONS.summary)]: "summary",
    [normalizeMenuText(MAIN_MENU_BUTTONS.map)]: "map",
    [normalizeMenuText(MAIN_MENU_BUTTONS.pay)]: "pay",
    [normalizeMenuText(MAIN_MENU_BUTTONS.pending)]: "pending",
    [normalizeMenuText(CANCEL_BUTTON_TEXT)]: "cancel"
  };
  return actions[normalized] || "";
}

function normalizeMenuText(text) {
  return String(text || "").trim().toLowerCase();
}

function isDebtSummaryText(text) {
  return /^(долги|задолженности|сводка)$/i.test(String(text || "").trim());
}

function isStreetMapText(text) {
  return /^(карта|карта улицы|улица|дашборд)$/i.test(String(text || "").trim());
}

function isMyDebtText(text) {
  return /^(мой долг|моя задолженность|мой дом|по себе)$/i.test(String(text || "").trim());
}

function formatDashboard(dashboard) {
  const debtors = dashboard.houses
    .filter((house) => Number(house.debt || 0) > 0)
    .sort((a, b) => Number(b.debt) - Number(a.debt) || Number(a.number) - Number(b.number));

  const lines = [
    `Сводка на ${formatMonth(dashboard.asOfMonth)}`,
    `Домов: ${dashboard.totals.houses}`,
    `Общий долг: ${rub(dashboard.totals.debt)}`,
    `Переплаты: ${rub(dashboard.totals.overpaid)}`,
    `Баланс кассы: ${rub(dashboard.totals.balance)}`
  ];

  if (!debtors.length) {
    lines.push("", "Долгов нет.");
    return lines.join("\n");
  }

  lines.push("", "Должники:");
  for (const house of debtors.slice(0, 20)) {
    lines.push(`Дом ${house.number}: ${rub(house.debt)}`);
  }
  if (debtors.length > 20) lines.push(`Еще домов с долгом: ${debtors.length - 20}`);
  return lines.join("\n");
}

function formatDashboardCardCaption(dashboard) {
  return [
    `Карта улицы на ${formatMonth(dashboard.asOfMonth)}`,
    `Баланс кассы: ${rub(dashboard.totals.balance)}`,
    `Долг: ${rub(dashboard.totals.debt)}`
  ].join("\n");
}

function formatHouseSummary(house, options = {}) {
  const lines = [
    `${options.personal ? "Ваш дом" : "Дом"} ${house.number}`,
    house.displayName,
    `Расчетный месяц: ${formatMonth(house.asOfMonth)}`,
    `Начислено: ${rub(house.due)}`,
    `Оплачено: ${rub(house.paid)}`,
    `Долг: ${rub(house.debt)}`,
    `Переплата: ${rub(house.overpaid)}`
  ];
  if (house.lastPaymentAt) lines.push(`Последний платеж: ${formatDate(house.lastPaymentAt)}`);
  return lines.join("\n");
}

function formatClaimForAdmin(claim) {
  if (!claim) return "Заявка не найдена.";
  return [
    `Заявка #${claim.id} на платеж из MAX`,
    `Дом: ${claim.house_number}`,
    `Сумма: ${rub(claim.amount)}`,
    `Дата: ${formatDate(claim.paid_at)}`,
    `Отправил: ${claim.submitted_by_name || claim.max_user_id}`,
    `Статус: ${claim.status}`,
    claim.comment_public ? `Комментарий: ${claim.comment_public}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function formatClaimLine(claim) {
  return `#${claim.id}: дом ${claim.house_number}, ${rub(claim.amount)}, ${formatDate(claim.paid_at)}, ${claim.submitted_by_name || claim.max_user_id}`;
}

function formatDeletedPaymentForSubmitter(payment, claim) {
  return [
    "Платеж удален администратором.",
    `Дом: ${payment.houseNumber}`,
    `Сумма: ${rub(payment.amount)}`,
    `Дата: ${formatDate(payment.paidAt)}`,
    claim?.id ? `Заявка MAX: #${claim.id}` : "",
    "Если это ошибка, свяжитесь с администратором."
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDeletedPaymentForAdmin(payment, claim) {
  return [
    "Платеж удален в админке",
    `ID платежа: #${payment.id}`,
    `Дом: ${payment.houseNumber}`,
    `Сумма: ${rub(payment.amount)}`,
    `Дата: ${formatDate(payment.paidAt)}`,
    `Источник: ${payment.source || "-"}`,
    claim?.id ? `MAX-заявка: #${claim.id}` : "MAX-заявка: не найдена",
    claim ? `Автор: ${formatClaimAuthor(claim)}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function formatClaimAuthor(claim) {
  const fullName = [claim.first_name, claim.last_name].filter(Boolean).join(" ").trim();
  const username = claim.username ? `@${claim.username}` : "";
  const name = [fullName, username].filter(Boolean).join(" ").trim();
  return claim.submitted_by_name || name || claim.max_user_id || "-";
}

function formatUserName(user) {
  const fullName = [user?.first_name || user?.firstName || user?.name, user?.last_name || user?.lastName].filter(Boolean).join(" ").trim();
  if (fullName && user?.username) return `${fullName} (@${user.username})`;
  if (fullName) return fullName;
  if (user?.username) return `@${user.username}`;
  return `id ${getUserId(user)}`;
}

function rub(value) {
  return `${new Intl.NumberFormat("ru-RU").format(Number(value || 0))} руб.`;
}

function formatDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text || "не указана";
  const [year, month, day] = text.split("-");
  return `${day}.${month}.${year}`;
}

function formatMonth(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}$/.test(text)) return text || "не указан";
  const [year, month] = text.split("-");
  return `${month}.${year}`;
}

function todayIso() {
  const timeZone = process.env.TZ || "Europe/Moscow";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function cleanComment(value) {
  return String(value || "").trim().slice(0, MAX_COMMENT_LENGTH);
}

function limitMaxText(text) {
  const value = String(text || "");
  return value.length > 3900 ? `${value.slice(0, 3900)}\n...` : value;
}

async function renderDashboardCardPng(dashboard) {
  const input = JSON.stringify(dashboard);
  let lastError = null;
  for (const command of PYTHON_CANDIDATES) {
    try {
      return await runPythonScript(command, DASHBOARD_CARD_SCRIPT, input);
    } catch (error) {
      lastError = error;
      if (error.code && error.code !== "ENOENT") break;
    }
  }
  throw lastError || new Error("Python 3 was not found");
}

function runPythonScript(command, scriptPath, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 10 * 1024 * 1024) {
        child.kill();
        reject(new Error("Rendered image is too large"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      const message = Buffer.concat(stderr).toString("utf-8").trim();
      reject(new Error(message || `${command} exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
