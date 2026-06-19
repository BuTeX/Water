import { createPayment, getDashboard } from "./repository.mjs";
import { normalizeInt, query, run, sqlDate, sqlInt, sqlRequiredText, sqlText } from "./sql.mjs";

const POLL_TIMEOUT_SECONDS = 25;
const RETRY_DELAY_MS = 5000;
const MAX_COMMENT_LENGTH = 500;
const PAYMENT_FLOW_DETAILS = "awaiting_payment_details";
const PAYMENT_FLOW_SCREENSHOT = "awaiting_payment_screenshot";
const LINK_FLOW_CODE = "awaiting_link_code";

export function startTelegramBot({ logger = console } = {}) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token || process.env.TELEGRAM_BOT_ENABLED === "false") return null;

  const bot = new TelegramWaterBot({
    token,
    adminIds: parseAdminIds(),
    logger
  });
  bot.start();
  return bot;
}

export function getTelegramBotStatus(bot) {
  if (bot) return bot.getStatus();

  const configured = Boolean(String(process.env.TELEGRAM_BOT_TOKEN || "").trim());
  const explicitlyDisabled = process.env.TELEGRAM_BOT_ENABLED === "false";
  return {
    configured,
    enabled: configured && !explicitlyDisabled,
    running: false,
    username: "",
    adminCount: parseAdminIds().size,
    startedAt: null,
    lastPollAt: null,
    lastUpdateAt: null,
    lastError: configured ? (explicitlyDisabled ? "Telegram bot is disabled by TELEGRAM_BOT_ENABLED=false" : "Bot is not running") : "TELEGRAM_BOT_TOKEN is not set",
    lastErrorAt: null,
    processedUpdates: 0
  };
}

class TelegramWaterBot {
  constructor({ token, adminIds, logger }) {
    this.token = token;
    this.adminIds = adminIds;
    this.logger = logger;
    this.offset = 0;
    this.stopped = false;
    this.username = "";
    this.status = {
      configured: true,
      enabled: true,
      running: false,
      username: "",
      adminCount: adminIds.size,
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
    this.loopPromise = this.pollLoop();
  }

  stop() {
    this.stopped = true;
    this.status.running = false;
  }

  getStatus() {
    return { ...this.status };
  }

  async pollLoop() {
    await this.initializeBot();

    while (!this.stopped) {
      try {
        const updates = await this.api("getUpdates", {
          offset: this.offset,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ["message", "callback_query"]
        });
        this.status.running = true;
        this.status.lastPollAt = new Date().toISOString();
        this.status.lastError = "";

        for (const update of updates) {
          this.offset = update.update_id + 1;
          this.status.processedUpdates += 1;
          this.status.lastUpdateAt = new Date().toISOString();
          await this.handleUpdate(update);
        }
      } catch (error) {
        this.status.running = false;
        this.status.lastError = error.message;
        this.status.lastErrorAt = new Date().toISOString();
        this.logger.warn(`Telegram bot polling failed: ${error.message}`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  async initializeBot() {
    try {
      await this.api("deleteWebhook", { drop_pending_updates: false });
      const me = await this.api("getMe", {});
      this.username = me.username || "";
      this.status.username = this.username;
      await this.api("setMyCommands", {
        commands: [
          { command: "debts", description: "Сводка по долгам" },
          { command: "house", description: "Долг по дому: /house 12" },
          { command: "me", description: "Мой привязанный дом" },
          { command: "link", description: "Привязать дом по коду" },
          { command: "pay", description: "Отправить платеж: /pay 12 1500" },
          { command: "help", description: "Список команд" }
        ]
      });
      this.logger.log(`Telegram bot @${this.username || "unknown"} started.`);
      if (!this.adminIds.size) {
        this.logger.warn("TELEGRAM_ADMIN_IDS is empty; payment approval is disabled.");
      }
    } catch (error) {
      this.status.lastError = error.message;
      this.status.lastErrorAt = new Date().toISOString();
      this.logger.warn(`Telegram bot initialization failed: ${error.message}`);
    }
  }

  async api(method, payload) {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.description || `${method} failed with HTTP ${response.status}`);
    }
    return data.result;
  }

  async sendMessage(chatId, text, extra = {}) {
    const message = await this.api("sendMessage", {
      chat_id: chatId,
      text: limitTelegramText(text),
      disable_web_page_preview: true,
      ...extra
    });
    await logTelegramMessage({
      chatId,
      direction: "out",
      kind: "text",
      telegramMessageId: message?.message_id,
      text
    }).catch((error) => this.logger.warn(`Failed to log Telegram outgoing message: ${error.message}`));
    return message;
  }

  async editMessageText(chatId, messageId, text, extra = {}) {
    const message = await this.api("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: limitTelegramText(text),
      disable_web_page_preview: true,
      ...extra
    });
    await logTelegramMessage({
      chatId,
      direction: "out",
      kind: "edit",
      telegramMessageId: message?.message_id || messageId,
      text
    }).catch((error) => this.logger.warn(`Failed to log Telegram edited message: ${error.message}`));
    return message;
  }

  async editMessageCaption(chatId, messageId, caption, extra = {}) {
    const message = await this.api("editMessageCaption", {
      chat_id: chatId,
      message_id: messageId,
      caption: limitTelegramText(caption),
      ...extra
    });
    await logTelegramMessage({
      chatId,
      direction: "out",
      kind: "edit",
      telegramMessageId: message?.message_id || messageId,
      text: caption
    }).catch((error) => this.logger.warn(`Failed to log Telegram edited caption: ${error.message}`));
    return message;
  }

  async sendPhoto(chatId, photoFileId, caption, extra = {}) {
    const message = await this.api("sendPhoto", {
      chat_id: chatId,
      photo: photoFileId,
      caption: limitTelegramText(caption),
      ...extra
    });
    await logTelegramMessage({
      chatId,
      direction: "out",
      kind: "photo",
      telegramMessageId: message?.message_id,
      text: caption,
      photoFileId
    }).catch((error) => this.logger.warn(`Failed to log Telegram outgoing photo: ${error.message}`));
    return message;
  }

  async handleUpdate(update) {
    try {
      if (update.message) await this.handleMessage(update.message, update.update_id);
      if (update.callback_query) await this.handleCallback(update.callback_query, update.update_id);
    } catch (error) {
      this.logger.warn(`Telegram update failed: ${error.message}`);
    }
  }

  async handleMessage(message, updateId = "") {
    const text = message.text || message.caption || "";
    const user = message.from;
    const chat = message.chat;
    const photo = getLargestPhoto(message);
    if (!user || !chat) return;

    await upsertTelegramUser(user);
    await logIncomingMessage(message, updateId).catch((error) =>
      this.logger.warn(`Failed to log Telegram incoming message: ${error.message}`)
    );

    const command = parseCommand(text, this.username);
    if (command) {
      await this.handleCommand({ message, command });
      return;
    }

    if (photo) {
      const handledPhoto = await this.handlePaymentScreenshot({ message, screenshot: photo });
      if (handledPhoto) return;
    }

    if (!text.trim()) {
      if (chat.type === "private") {
        await this.sendMessage(chat.id, "Пришлите команду или выберите действие кнопками.", mainMenuMarkup(this.isAdmin(user)));
      }
      return;
    }

    const isPrivate = chat.type === "private";
    const cleanedText = stripBotMention(text, this.username);
    if (!isPrivate && cleanedText === text) return;

    const freeText = cleanedText.trim();
    const handledState = await this.handleStateText({ message, text: freeText });
    if (handledState) return;

    if (isDebtSummaryText(freeText)) {
      await this.sendDashboard(chat.id);
      return;
    }

    if (isMyDebtText(freeText)) {
      await this.sendMyHouse(chat.id, user.id);
      return;
    }

    const payment = parsePaymentInput(freeText);
    if (payment) {
      await this.preparePaymentScreenshot({ message, payment });
      return;
    }

    const houseNumber = parseHouseNumber(freeText);
    if (houseNumber) {
      await this.sendHouse(chat.id, houseNumber);
      return;
    }

    if (isPrivate) {
      await this.sendHelp(chat.id, true);
    }
  }

  async handleCommand({ message, command }) {
    const chatId = message.chat.id;
    const user = message.from;
    const name = command.name;

    if (["start", "help"].includes(name)) {
      if (name === "start" && command.args) {
        const linked = await this.tryLinkHouse(chatId, user.id, command.args);
        if (linked) return;
      }
      await this.sendHelp(chatId, message.chat.type === "private", user);
      return;
    }

    if (["debts", "debtors", "summary", "dolg", "dolgi", "долги"].includes(name)) {
      await this.sendDashboard(chatId);
      return;
    }

    if (["house", "dom", "h", "дом"].includes(name)) {
      const houseNumber = parseHouseNumber(command.args);
      if (!houseNumber) {
        await this.sendMessage(chatId, "Напишите номер дома: /house 12");
        return;
      }
      await this.sendHouse(chatId, houseNumber);
      return;
    }

    if (["me", "my", "mine", "мой"].includes(name)) {
      await this.sendMyHouse(chatId, user.id);
      return;
    }

    if (["link", "bind", "привязать"].includes(name)) {
      if (command.args) await this.tryLinkHouse(chatId, user.id, command.args, { showUsage: true });
      else await this.beginLinkFlow(chatId, user);
      return;
    }

    if (["pay", "payment", "оплата", "платеж"].includes(name)) {
      const payment = await this.parsePaymentFromText(command.args, user.id);
      if (!payment) {
        await this.beginPaymentFlow(chatId, user);
        return;
      }
      const screenshot = getLargestPhoto(message);
      if (screenshot) await this.submitPayment({ message, payment, screenshot });
      else await this.preparePaymentScreenshot({ message, payment });
      return;
    }

    if (name === "pending") {
      await this.sendPendingClaims(chatId, user);
      return;
    }

    if (name === "approve") {
      await this.handleReviewCommand(chatId, user, command.args, "approve");
      return;
    }

    if (name === "reject") {
      await this.handleReviewCommand(chatId, user, command.args, "reject");
      return;
    }

    await this.sendHelp(chatId, message.chat.type === "private", user);
  }

  async sendHelp(chatId, isPrivate, user = null) {
    const lines = [
      "Выберите действие кнопками или используйте команды:",
      "/debts - общая сводка по долгам",
      "/house 12 - информация по дому",
      "/pay 12 1500 2026-06-18 комментарий - отправить платеж со скрином"
    ];
    if (isPrivate) {
      lines.splice(3, 0, "/link h12-xxxxxxxxxxxx - привязать свой дом", "/me - посмотреть свой дом");
    }
    await this.sendMessage(chatId, lines.join("\n"), isPrivate ? mainMenuMarkup(this.isAdmin(user)) : {});
  }

  async sendPaymentUsage(chatId) {
    await this.sendMessage(
      chatId,
      "Формат платежа: /pay 12 1500 2026-06-18 комментарий\nПосле суммы обязательно отправьте скриншот платежа."
    );
  }

  async beginLinkFlow(chatId, user) {
    await setTelegramUserState(user.id, LINK_FLOW_CODE, {});
    await this.sendMessage(chatId, "Пришлите код доступа дома из ссылки вида h12-xxxxxxxxxxxx.", cancelMarkup());
  }

  async beginPaymentFlow(chatId, user) {
    const linkedHouse = await getLinkedHouse(user.id);
    await setTelegramUserState(user.id, PAYMENT_FLOW_DETAILS, {
      houseNumber: linkedHouse?.house_number || null
    });
    const text = linkedHouse?.house_number
      ? `Дом ${linkedHouse.house_number} привязан. Введите сумму платежа, дату и комментарий при необходимости.`
      : "Введите номер дома, сумму платежа, дату и комментарий при необходимости.";
    await this.sendMessage(
      chatId,
      `${text}\n\nПример: ${linkedHouse?.house_number ? "1500 2026-06-18 СБП" : "12 1500 2026-06-18 СБП"}`,
      cancelMarkup()
    );
  }

  async handleStateText({ message, text }) {
    if (message.chat.type !== "private") return false;

    const state = await getTelegramUserState(message.from.id);
    if (!state?.state) return false;

    if (state.state === LINK_FLOW_CODE) {
      const linked = await this.tryLinkHouse(message.chat.id, message.from.id, text, { showUsage: true });
      if (linked) await clearTelegramUserState(message.from.id);
      return true;
    }

    if (state.state === PAYMENT_FLOW_DETAILS) {
      const payload = parseStatePayload(state.state_payload);
      const payment = parsePaymentInput(text) || parseLinkedPaymentInput(text, payload.houseNumber);
      if (!payment) {
        await this.sendPaymentUsage(message.chat.id);
        return true;
      }
      await this.preparePaymentScreenshot({ message, payment });
      return true;
    }

    if (state.state === PAYMENT_FLOW_SCREENSHOT) {
      await this.sendMessage(message.chat.id, "Скриншот обязателен. Пришлите фото платежа или нажмите «Отменить».", cancelMarkup());
      return true;
    }

    return false;
  }

  async parsePaymentFromText(text, telegramUserId) {
    const explicitPayment = parsePaymentInput(text);
    if (explicitPayment) return explicitPayment;

    const linkedHouse = await getLinkedHouse(telegramUserId);
    return parseLinkedPaymentInput(text, linkedHouse?.house_number);
  }

  async preparePaymentScreenshot({ message, payment }) {
    const house = await findHouseByNumber(payment.houseNumber);
    if (!house) {
      await this.sendMessage(message.chat.id, `Дом ${payment.houseNumber} не найден.`, mainMenuMarkup(this.isAdmin(message.from)));
      return;
    }

    await setTelegramUserState(message.from.id, PAYMENT_FLOW_SCREENSHOT, payment);
    await this.sendMessage(
      message.chat.id,
      `Платеж: дом ${house.number}, ${rub(payment.amount)}, ${formatDate(payment.paidAt)}.\nТеперь отправьте скриншот платежа фото-сообщением.`,
      cancelMarkup()
    );
  }

  async handlePaymentScreenshot({ message, screenshot }) {
    const command = parseCommand(message.caption || "", this.username);
    if (command?.name && ["pay", "payment", "оплата", "платеж"].includes(command.name)) {
      const payment = await this.parsePaymentFromText(command.args, message.from.id);
      if (!payment) {
        await this.sendPaymentUsage(message.chat.id);
        return true;
      }
      await this.submitPayment({ message, payment, screenshot });
      return true;
    }

    const state = await getTelegramUserState(message.from.id);
    if (state?.state !== PAYMENT_FLOW_SCREENSHOT) return false;

    const payment = parseStatePayload(state.state_payload);
    if (!payment?.houseNumber || !payment?.amount || !payment?.paidAt) {
      await clearTelegramUserState(message.from.id);
      await this.sendMessage(message.chat.id, "Не удалось восстановить данные платежа. Начните заново.", mainMenuMarkup(this.isAdmin(message.from)));
      return true;
    }

    await this.submitPayment({ message, payment, screenshot });
    return true;
  }

  async sendDashboard(chatId) {
    const dashboard = await getDashboard();
    await this.sendMessage(chatId, formatDashboard(dashboard));
  }

  async sendHouse(chatId, houseNumber) {
    const house = await getHouseSummaryByNumber(houseNumber);
    if (!house) {
      await this.sendMessage(chatId, `Дом ${houseNumber} не найден.`);
      return;
    }
    await this.sendMessage(chatId, formatHouseSummary(house));
  }

  async sendMyHouse(chatId, telegramUserId) {
    const userHouse = await getLinkedHouse(telegramUserId);
    if (!userHouse?.house_number) {
      await this.sendMessage(chatId, "Дом пока не привязан. Напишите /link и код доступа из ссылки вашего дома.");
      return;
    }

    const house = await getHouseSummaryByNumber(userHouse.house_number);
    if (!house) {
      await this.sendMessage(chatId, "Привязанный дом больше не найден. Привяжите дом заново через /link.");
      return;
    }
    await this.sendMessage(chatId, formatHouseSummary(house, { personal: true }));
  }

  async tryLinkHouse(chatId, telegramUserId, rawCode, options = {}) {
    const accessCode = extractAccessCode(rawCode);
    if (!accessCode) {
      if (options.showUsage) {
        await this.sendMessage(chatId, "Формат: /link h12-xxxxxxxxxxxx");
      }
      return false;
    }

    const house = await findHouseByAccessCode(accessCode);
    if (!house) {
      await this.sendMessage(chatId, "Не нашел дом по этому коду. Проверьте ссылку или код доступа.");
      return true;
    }

    await linkTelegramUser(telegramUserId, house.id);
    await clearTelegramUserState(telegramUserId);
    await this.sendMessage(chatId, `Готово. Привязал вас к дому ${house.number}. Теперь можно писать /me.`, mainMenuMarkup(false));
    return true;
  }

  async submitPayment({ message, payment, screenshot }) {
    const chatId = message.chat.id;
    const user = message.from;
    const house = await findHouseByNumber(payment.houseNumber);
    if (!house) {
      await this.sendMessage(chatId, `Дом ${payment.houseNumber} не найден.`);
      return;
    }

    if (!screenshot?.file_id) {
      await this.preparePaymentScreenshot({ message, payment });
      return;
    }

    if (this.isAdmin(user)) {
      const result = await createPayment({
        houseNumber: house.number,
        amount: payment.amount,
        paidAt: payment.paidAt,
        method: "other",
        commentPublic: payment.comment,
        commentPrivate: `Telegram admin ${formatUserName(user)}; screenshot ${screenshot.file_id}`,
        source: "telegram"
      });
      await clearTelegramUserState(user.id);
      await this.sendMessage(
        chatId,
        `Платеж добавлен: дом ${house.number}, ${rub(payment.amount)}, ${formatDate(payment.paidAt)}. ID: ${result.id}.`,
        mainMenuMarkup(true)
      );
      return;
    }

    const claimId = await createPaymentClaim({
      houseId: house.id,
      telegramUserId: user.id,
      chatId,
      messageId: message.message_id,
      submittedByName: formatUserName(user),
      amount: payment.amount,
      paidAt: payment.paidAt,
      commentPublic: payment.comment,
      commentPrivate: `Telegram claim from ${formatUserName(user)} (${user.id})`,
      screenshotFileId: screenshot.file_id,
      screenshotFileUniqueId: screenshot.file_unique_id,
      screenshotMessageId: message.message_id
    });

    const claim = await getPaymentClaim(claimId);
    const notified = await this.notifyAdmins(claim);
    await clearTelegramUserState(user.id);
    await this.sendMessage(
      chatId,
      notified
        ? `Платеж отправлен на проверку. Заявка #${claimId}.`
        : `Заявка #${claimId} сохранена, но администратор в Telegram не настроен. Сообщите владельцу.`,
      mainMenuMarkup(false)
    );
  }

  async notifyAdmins(claim) {
    if (!this.adminIds.size) return false;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "Подтвердить", callback_data: `pay:approve:${claim.id}` },
          { text: "Отклонить", callback_data: `pay:reject:${claim.id}` }
        ]
      ]
    };

    let delivered = false;
    for (const adminId of this.adminIds) {
      try {
        if (claim.screenshot_file_id) {
          await this.sendPhoto(adminId, claim.screenshot_file_id, formatClaimForAdmin(claim), { reply_markup: keyboard });
        } else {
          await this.sendMessage(adminId, formatClaimForAdmin(claim), { reply_markup: keyboard });
        }
        delivered = true;
      } catch (error) {
        this.logger.warn(`Failed to notify Telegram admin ${adminId}: ${error.message}`);
      }
    }
    return delivered;
  }

  async handleCallback(callbackQuery, updateId = "") {
    const data = callbackQuery.data || "";
    const user = callbackQuery.from;
    await upsertTelegramUser(user);
    await logIncomingCallback(callbackQuery, updateId).catch((error) =>
      this.logger.warn(`Failed to log Telegram callback: ${error.message}`)
    );

    if (data.startsWith("menu:")) {
      await this.api("answerCallbackQuery", { callback_query_id: callbackQuery.id });
      await this.handleMenuCallback(callbackQuery, data);
      return;
    }

    if (data === "flow:cancel") {
      await clearTelegramUserState(user.id);
      await this.api("answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "Отменено" });
      await this.sendMessage(callbackQuery.message.chat.id, "Действие отменено.", mainMenuMarkup(this.isAdmin(user)));
      return;
    }

    const match = data.match(/^pay:(approve|reject):(\d+)$/);
    if (!match) return;

    if (!this.isAdmin(user)) {
      await this.api("answerCallbackQuery", {
        callback_query_id: callbackQuery.id,
        text: "Недостаточно прав",
        show_alert: true
      });
      return;
    }

    const action = match[1];
    const claimId = Number(match[2]);
    const result = action === "approve" ? await this.approveClaim(claimId, user) : await this.rejectClaim(claimId, user);

    await this.api("answerCallbackQuery", {
      callback_query_id: callbackQuery.id,
      text: result.message
    });

    if (callbackQuery.message) {
      const editText = `${formatClaimForAdmin(result.claim)}\n\n${result.message}`;
      const editOptions = { reply_markup: { inline_keyboard: [] } };
      const edit = callbackQuery.message.photo ? this.editMessageCaption : this.editMessageText;
      await edit
        .call(this, callbackQuery.message.chat.id, callbackQuery.message.message_id, editText, editOptions)
        .catch((error) => this.logger.warn(`Failed to edit Telegram callback message: ${error.message}`));
    }
  }

  async handleMenuCallback(callbackQuery, data) {
    const chatId = callbackQuery.message.chat.id;
    const user = callbackQuery.from;
    const action = data.replace("menu:", "");

    if (action === "home") {
      await this.sendHelp(chatId, callbackQuery.message.chat.type === "private", user);
      return;
    }
    if (action === "summary") {
      await this.sendDashboard(chatId);
      return;
    }
    if (action === "me") {
      await this.sendMyHouse(chatId, user.id);
      return;
    }
    if (action === "link") {
      await this.beginLinkFlow(chatId, user);
      return;
    }
    if (action === "pay") {
      await this.beginPaymentFlow(chatId, user);
      return;
    }
    if (action === "pending") {
      await this.sendPendingClaims(chatId, user);
    }
  }

  async handleReviewCommand(chatId, user, args, action) {
    if (!this.isAdmin(user)) {
      await this.sendMessage(chatId, "Эта команда доступна только администратору.");
      return;
    }

    if (!/^\d+$/.test(String(args || "").trim())) {
      await this.sendMessage(chatId, action === "approve" ? "Формат: /approve 123" : "Формат: /reject 123");
      return;
    }

    const claimId = normalizeInt(args, "claim id");
    const result = action === "approve" ? await this.approveClaim(claimId, user) : await this.rejectClaim(claimId, user);
    await this.sendMessage(chatId, result.message);
  }

  async approveClaim(claimId, adminUser) {
    const result = await approveTelegramPaymentClaim(claimId, adminUser.id);
    if (result.claim?.status === "approved") {
      await this.notifySubmitter(result.claim, `Платеж по заявке #${claimId} подтвержден. Спасибо!`);
    }
    return result;
  }

  async rejectClaim(claimId, adminUser) {
    const result = await rejectTelegramPaymentClaim(claimId, adminUser.id);
    if (result.claim?.status === "rejected") {
      await this.notifySubmitter(result.claim, `Платеж по заявке #${claimId} отклонен. Свяжитесь с администратором.`);
    }
    return result;
  }

  async notifySubmitter(claim, text) {
    if (!claim?.chat_id) return;
    await this.sendMessage(claim.chat_id, text).catch((error) =>
      this.logger.warn(`Failed to notify payment submitter: ${error.message}`)
    );
  }

  async sendPendingClaims(chatId, user) {
    if (!this.isAdmin(user)) {
      await this.sendMessage(chatId, "Эта команда доступна только администратору.");
      return;
    }

    const rows = await query(`
      SELECT c.*, h.number AS house_number
      FROM telegram_payment_claims c
      JOIN houses h ON h.id = c.house_id
      WHERE c.status = 'pending'
      ORDER BY c.created_at
      LIMIT 10
    `);

    if (!rows.length) {
      await this.sendMessage(chatId, "Ожидающих платежей нет.");
      return;
    }

    await this.sendMessage(
      chatId,
      ["Ожидают проверки:", ...rows.map((row) => formatClaimLine(row))].join("\n")
    );
  }

  isAdmin(user) {
    return this.adminIds.has(String(user?.id || ""));
  }
}

function parseAdminIds() {
  const raw = [process.env.TELEGRAM_ADMIN_ID, process.env.TELEGRAM_ADMIN_IDS].filter(Boolean).join(",");
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

async function logIncomingMessage(message, updateId) {
  const photo = getLargestPhoto(message);
  await logTelegramMessage({
    updateId,
    chatId: message.chat.id,
    telegramUserId: message.from?.id || "",
    telegramMessageId: message.message_id,
    direction: "in",
    kind: photo ? "photo" : "text",
    text: message.text || message.caption || "",
    photoFileId: photo?.file_id || "",
    photoFileUniqueId: photo?.file_unique_id || ""
  });
}

async function logIncomingCallback(callbackQuery, updateId) {
  await logTelegramMessage({
    updateId,
    chatId: callbackQuery.message?.chat?.id || callbackQuery.from?.id || "",
    telegramUserId: callbackQuery.from?.id || "",
    telegramMessageId: callbackQuery.message?.message_id || "",
    direction: "in",
    kind: "callback",
    text: callbackQuery.message?.text || "",
    callbackData: callbackQuery.data || ""
  });
}

async function logTelegramMessage(body) {
  await run(`
    INSERT INTO telegram_messages (
      update_id,
      telegram_message_id,
      telegram_user_id,
      chat_id,
      direction,
      kind,
      text,
      callback_data,
      photo_file_id,
      photo_file_unique_id
    )
    VALUES (
      ${sqlText(body.updateId || "")},
      ${sqlText(body.telegramMessageId || "")},
      ${sqlText(body.telegramUserId || "")},
      ${sqlRequiredText(body.chatId, "chat id")},
      ${sqlRequiredText(body.direction, "direction")},
      ${sqlText(body.kind || "text")},
      ${sqlText(cleanComment(body.text || ""))},
      ${sqlText(body.callbackData || "")},
      ${sqlText(body.photoFileId || "")},
      ${sqlText(body.photoFileUniqueId || "")}
    )
  `);
}

async function upsertTelegramUser(user) {
  await run(`
    INSERT INTO telegram_users (telegram_user_id, username, first_name, last_name)
    VALUES (
      ${sqlRequiredText(user.id, "telegram user id")},
      ${sqlText(user.username || "")},
      ${sqlText(user.first_name || "")},
      ${sqlText(user.last_name || "")}
    )
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      updated_at = CURRENT_TIMESTAMP
  `);
}

async function linkTelegramUser(telegramUserId, houseId) {
  await run(`
    UPDATE telegram_users
    SET linked_house_id = ${sqlInt(houseId, "house id")},
        updated_at = CURRENT_TIMESTAMP
    WHERE telegram_user_id = ${sqlRequiredText(telegramUserId, "telegram user id")}
  `);
}

async function setTelegramUserState(telegramUserId, state, payload = {}) {
  await run(`
    UPDATE telegram_users
    SET state = ${sqlText(state || "")},
        state_payload = ${sqlText(JSON.stringify(payload || {}))},
        updated_at = CURRENT_TIMESTAMP
    WHERE telegram_user_id = ${sqlRequiredText(telegramUserId, "telegram user id")}
  `);
}

async function clearTelegramUserState(telegramUserId) {
  await setTelegramUserState(telegramUserId, "", {});
}

async function getTelegramUserState(telegramUserId) {
  const rows = await query(`
    SELECT state, state_payload
    FROM telegram_users
    WHERE telegram_user_id = ${sqlRequiredText(telegramUserId, "telegram user id")}
    LIMIT 1
  `);
  return rows[0] || null;
}

async function getLinkedHouse(telegramUserId) {
  const rows = await query(`
    SELECT tu.*, h.number AS house_number
    FROM telegram_users tu
    LEFT JOIN houses h ON h.id = tu.linked_house_id
    WHERE tu.telegram_user_id = ${sqlRequiredText(telegramUserId, "telegram user id")}
    LIMIT 1
  `);
  return rows[0] || null;
}

async function findHouseByAccessCode(accessCode) {
  const rows = await query(`SELECT * FROM houses WHERE access_code = ${sqlRequiredText(accessCode, "access code")} LIMIT 1`);
  return rows[0] || null;
}

async function findHouseByNumber(number) {
  const rows = await query(`SELECT * FROM houses WHERE number = ${sqlInt(number, "house number")} LIMIT 1`);
  return rows[0] || null;
}

async function findHouseById(id) {
  const rows = await query(`SELECT * FROM houses WHERE id = ${sqlInt(id, "house id")} LIMIT 1`);
  return rows[0] || null;
}

async function getHouseSummaryByNumber(number) {
  const dashboard = await getDashboard();
  const house = dashboard.houses.find((item) => Number(item.number) === Number(number));
  return house ? { ...house, asOfMonth: dashboard.asOfMonth } : null;
}

async function createPaymentClaim(body) {
  const rows = await query(`
    INSERT INTO telegram_payment_claims (
      house_id,
      telegram_user_id,
      chat_id,
      message_id,
      submitted_by_name,
      amount,
      paid_at,
      method,
      comment_public,
      comment_private,
      screenshot_file_id,
      screenshot_file_unique_id,
      screenshot_message_id
    )
    VALUES (
      ${sqlInt(body.houseId, "house id")},
      ${sqlRequiredText(body.telegramUserId, "telegram user id")},
      ${sqlRequiredText(body.chatId, "chat id")},
      ${sqlText(body.messageId || "")},
      ${sqlText(body.submittedByName || "")},
      ${sqlInt(body.amount, "amount")},
      ${sqlDate(body.paidAt, "paid at")},
      'other',
      ${sqlText(cleanComment(body.commentPublic || ""))},
      ${sqlText(cleanComment(body.commentPrivate || ""))},
      ${sqlText(body.screenshotFileId || "")},
      ${sqlText(body.screenshotFileUniqueId || "")},
      ${sqlText(body.screenshotMessageId || "")}
    )
    RETURNING id
  `);
  return rows[0].id;
}

async function getPaymentClaim(id) {
  const rows = await query(`
    SELECT c.*, h.number AS house_number
    FROM telegram_payment_claims c
    JOIN houses h ON h.id = c.house_id
    WHERE c.id = ${sqlInt(id, "claim id")}
    LIMIT 1
  `);
  return rows[0] || null;
}

export async function getTelegramAdminData() {
  const [users, pendingClaims, messages] = await Promise.all([
    query(`
      SELECT
        tu.telegram_user_id,
        tu.username,
        tu.first_name,
        tu.last_name,
        tu.state,
        tu.updated_at,
        h.number AS house_number,
        h.display_name AS house_display_name,
        (
          SELECT COUNT(*)
          FROM telegram_messages tm
          WHERE tm.telegram_user_id = tu.telegram_user_id
        ) AS message_count,
        (
          SELECT MAX(created_at)
          FROM telegram_messages tm
          WHERE tm.telegram_user_id = tu.telegram_user_id
        ) AS last_message_at
      FROM telegram_users tu
      LEFT JOIN houses h ON h.id = tu.linked_house_id
      ORDER BY COALESCE(last_message_at, tu.updated_at) DESC
      LIMIT 100
    `),
    query(`
      SELECT
        c.*,
        h.number AS house_number,
        h.display_name AS house_display_name,
        tu.username,
        tu.first_name,
        tu.last_name
      FROM telegram_payment_claims c
      JOIN houses h ON h.id = c.house_id
      LEFT JOIN telegram_users tu ON tu.telegram_user_id = c.telegram_user_id
      WHERE c.status = 'pending'
      ORDER BY c.created_at
      LIMIT 100
    `),
    query(`
      SELECT
        tm.*,
        tu.username,
        tu.first_name,
        tu.last_name,
        h.number AS house_number
      FROM telegram_messages tm
      LEFT JOIN telegram_users tu ON tu.telegram_user_id = tm.telegram_user_id
      LEFT JOIN houses h ON h.id = tu.linked_house_id
      ORDER BY tm.created_at DESC, tm.id DESC
      LIMIT 120
    `)
  ]);

  return { users, pendingClaims, messages };
}

export async function setTelegramUserHouse(body) {
  const telegramUserId = sqlRequiredText(body.telegramUserId, "telegram user id");
  const userRows = await query(`
    SELECT id
    FROM telegram_users
    WHERE telegram_user_id = ${telegramUserId}
    LIMIT 1
  `);
  if (!userRows[0]) throw new Error(`Telegram user ${body.telegramUserId} not found`);

  const rawHouseNumber = String(body.houseNumber || "").trim();
  if (!rawHouseNumber) {
    await run(`
      UPDATE telegram_users
      SET linked_house_id = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ${telegramUserId}
    `);
    return { ok: true, linked: false };
  }

  const house = await findHouseByNumber(rawHouseNumber);
  if (!house) throw new Error(`House ${rawHouseNumber} not found`);
  await linkTelegramUser(body.telegramUserId, house.id);
  return { ok: true, linked: true, houseNumber: house.number };
}

export async function approveTelegramPaymentClaim(claimId, adminTelegramUserId = "web-admin") {
  const rows = await query(`
    UPDATE telegram_payment_claims
    SET status = 'processing',
        admin_telegram_user_id = ${sqlRequiredText(adminTelegramUserId, "admin id")},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlInt(claimId, "claim id")} AND status = 'pending'
    RETURNING *
  `);
  const claim = rows[0];
  if (!claim) {
    const current = await getPaymentClaim(claimId);
    return {
      claim: current,
      message: current ? `Заявка #${claimId} уже не ожидает проверки: ${current.status}.` : `Заявка #${claimId} не найдена.`
    };
  }

  try {
    const house = await findHouseById(claim.house_id);
    if (!house) throw new Error(`House ${claim.house_id} not found`);

    const screenshotNote = claim.screenshot_file_id ? `; screenshot ${claim.screenshot_file_id}` : "";
    const payment = await createPayment({
      houseNumber: house.number,
      amount: claim.amount,
      paidAt: claim.paid_at,
      method: claim.method || "other",
      commentPublic: claim.comment_public || "",
      commentPrivate: `${claim.comment_private || `Telegram claim #${claim.id}`}${screenshotNote}`,
      source: "telegram"
    });

    await run(`
      UPDATE telegram_payment_claims
      SET status = 'approved',
          payment_id = ${sqlInt(payment.id, "payment id")},
          reviewed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlInt(claim.id, "claim id")}
    `);

    const approved = await getPaymentClaim(claim.id);
    return { claim: approved, message: `Заявка #${claim.id} подтверждена. Платеж ID: ${payment.id}.` };
  } catch (error) {
    await run(`
      UPDATE telegram_payment_claims
      SET status = 'pending',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlInt(claim.id, "claim id")} AND status = 'processing'
    `);
    throw error;
  }
}

export async function rejectTelegramPaymentClaim(claimId, adminTelegramUserId = "web-admin") {
  const rows = await query(`
    UPDATE telegram_payment_claims
    SET status = 'rejected',
        admin_telegram_user_id = ${sqlRequiredText(adminTelegramUserId, "admin id")},
        reviewed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${sqlInt(claimId, "claim id")} AND status IN ('pending', 'processing')
    RETURNING *
  `);
  const claim = rows[0] || (await getPaymentClaim(claimId));
  if (!rows[0]) {
    return {
      claim,
      message: claim ? `Заявка #${claimId} уже не ожидает проверки: ${claim.status}.` : `Заявка #${claimId} не найдена.`
    };
  }

  const rejected = await getPaymentClaim(claimId);
  return { claim: rejected, message: `Заявка #${claimId} отклонена.` };
}

export async function getTelegramFileInfo(fileId) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const response = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || `getFile failed with HTTP ${response.status}`);
  return {
    token,
    filePath: data.result.file_path,
    fileSize: data.result.file_size || 0
  };
}

function parseCommand(text, botUsername) {
  const trimmed = text.trim();
  const [head] = trimmed.split(/\s+/, 1);
  const match = head.match(/^\/([A-Za-z0-9_А-Яа-яЁё]+)(?:@([A-Za-z0-9_]+))?$/);
  if (!match) return null;

  const mention = match[2] || "";
  if (mention && botUsername && mention.toLowerCase() !== botUsername.toLowerCase()) return null;

  return {
    name: match[1].toLowerCase(),
    args: trimmed.slice(head.length).trim()
  };
}

function stripBotMention(text, botUsername) {
  if (!botUsername) return text;
  return text.replace(new RegExp(`@${escapeRegExp(botUsername)}`, "gi"), "").trim();
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
  const match = cleaned.match(/^(?:дом\s*)?(\d{1,5})\s+([0-9]+(?:[.,][0-9]+)?)\s*(?:(\d{4}-\d{2}-\d{2})\s*)?([\s\S]*)$/i);
  if (!match) return null;

  const amount = Math.round(Number(match[2].replace(",", ".")));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const paidAt = match[3] || todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) return null;

  return {
    houseNumber: Number(match[1]),
    amount,
    paidAt,
    comment: cleanComment(match[4] || "")
  };
}

function parseLinkedPaymentInput(text, houseNumber) {
  if (!houseNumber) return null;
  const cleaned = String(text || "").trim().replace(/^\/pay(?:@\w+)?\s*/i, "");
  const match = cleaned.match(/^([0-9]+(?:[.,][0-9]+)?)\s*(?:(\d{4}-\d{2}-\d{2})\s*)?([\s\S]*)$/i);
  if (!match) return null;

  const amount = Math.round(Number(match[1].replace(",", ".")));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const paidAt = match[2] || todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) return null;

  return {
    houseNumber: Number(houseNumber),
    amount,
    paidAt,
    comment: cleanComment(match[3] || "")
  };
}

function getLargestPhoto(message) {
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  return photos.length ? photos.slice().sort((a, b) => Number(b.file_size || 0) - Number(a.file_size || 0))[0] : null;
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
  const keyboard = [
    [
      { text: "Мой дом", callback_data: "menu:me" },
      { text: "Сводка", callback_data: "menu:summary" }
    ],
    [
      { text: "Отправить платеж", callback_data: "menu:pay" },
      { text: "Привязать дом", callback_data: "menu:link" }
    ]
  ];
  if (isAdmin) keyboard.push([{ text: "Ожидают проверки", callback_data: "menu:pending" }]);
  return { reply_markup: { inline_keyboard: keyboard } };
}

function cancelMarkup() {
  return { reply_markup: { inline_keyboard: [[{ text: "Отменить", callback_data: "flow:cancel" }]] } };
}

function isDebtSummaryText(text) {
  return /^(долги|задолженности|сводка)$/i.test(String(text || "").trim());
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
    `Заявка #${claim.id} на платеж`,
    `Дом: ${claim.house_number}`,
    `Сумма: ${rub(claim.amount)}`,
    `Дата: ${formatDate(claim.paid_at)}`,
    `Отправил: ${claim.submitted_by_name || claim.telegram_user_id}`,
    `Статус: ${claim.status}`,
    claim.screenshot_file_id ? "Скрин: приложен" : "Скрин: нет",
    claim.comment_public ? `Комментарий: ${claim.comment_public}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function formatClaimLine(claim) {
  return `#${claim.id}: дом ${claim.house_number}, ${rub(claim.amount)}, ${formatDate(claim.paid_at)}, ${claim.submitted_by_name || claim.telegram_user_id}`;
}

function formatUserName(user) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (fullName && user.username) return `${fullName} (@${user.username})`;
  if (fullName) return fullName;
  if (user.username) return `@${user.username}`;
  return `id ${user.id}`;
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

function limitTelegramText(text) {
  const value = String(text || "");
  return value.length > 3900 ? `${value.slice(0, 3900)}\n...` : value;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
