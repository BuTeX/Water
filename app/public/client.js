const page = document.body.dataset.page;
const houseLinkPrefix = document.body.dataset.housePrefix || "";

const money = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0
});

function rub(value) {
  return money.format(Number(value || 0));
}

function plainRub(value) {
  return rub(value).replace(/\s?₽/, " ₽");
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ru-RU").format(new Date(`${value}T00:00:00`));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Ошибка запроса");
  return payload;
}

async function uploadDatabase(file) {
  const response = await fetch("/api/admin/database", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Ошибка загрузки");
  return payload;
}

function percent(value, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(value || 0) / Number(total || 0)) * 100)));
}

function balanceClass(house) {
  if (house.debt > 0) return "amount-danger";
  if (house.overpaid > 0) return "amount-ok";
  return "amount-ok";
}

function housePageUrl(house) {
  const url = house?.url || "";
  if (!url) return "";
  return houseLinkPrefix ? url.replace(/^\/h\//, `${houseLinkPrefix}/h/`) : url;
}

function stat(label, value, tone = "", detail = "") {
  return `
    <div class="stat ${tone}">
      <span>${label}</span>
      <strong>${value}</strong>
      ${detail ? `<em>${detail}</em>` : ""}
    </div>
  `;
}

function renderStats(target, totals) {
  target.innerHTML = [
    stat("Остаток кассы", rub(totals.balance), "amount-ok"),
    stat("Поступления", rub(totals.payments)),
    stat("Расходы", rub(totals.expenses)),
    stat("Долг / аванс", `${rub(totals.debt)} / ${rub(totals.overpaid)}`)
  ].join("");
}

function renderHouseStats(target, house) {
  const balance = house.overpaid - house.debt;
  target.innerHTML = [
    stat("Баланс дома", balance >= 0 ? `+${rub(balance)}` : rub(balance), balance >= 0 ? "amount-ok" : "amount-danger"),
    stat("Оплачено", rub(house.paid)),
    stat("Начислено", rub(house.due)),
    stat("Долг / аванс", `${rub(house.debt)} / ${rub(house.overpaid)}`)
  ].join("");
}

function dashboardMetrics(data) {
  const houses = data.houses || [];
  const due = houses.reduce((sum, house) => sum + Number(house.due || 0), 0);
  const paid = houses.reduce((sum, house) => sum + Number(house.paid || 0), 0);
  const debtors = houses.filter((house) => Number(house.debt || 0) > 0);
  const overpaid = houses.filter((house) => Number(house.overpaid || 0) > 0);
  const settled = houses.filter((house) => !Number(house.debt || 0) && !Number(house.overpaid || 0));
  return {
    houses,
    due,
    paid,
    debtors,
    overpaid,
    settled,
    collectionRate: percent(paid, due)
  };
}

function renderDashboardHero(target, data) {
  const metrics = dashboardMetrics(data);
  const balance = data.totals.balance;
  target.innerHTML = `
    <span>Остаток кассы</span>
    <strong class="${balance >= 0 ? "amount-ok" : "amount-danger"}">${plainRub(balance)}</strong>
    <div class="progress-line" aria-label="Собрано ${metrics.collectionRate}%">
      <span style="width: ${metrics.collectionRate}%"></span>
    </div>
    <small>Собрано ${metrics.collectionRate}% начислений</small>
  `;
}

function renderDashboardStats(target, data) {
  const metrics = dashboardMetrics(data);
  target.innerHTML = [
    stat("Долг", rub(data.totals.debt), data.totals.debt > 0 ? "amount-danger" : "amount-ok", `${metrics.debtors.length} домов`),
    stat("Аванс", rub(data.totals.overpaid), "amount-ok", `${metrics.overpaid.length} домов`)
  ].join("");
}

function renderStatusSummary(target, data) {
  const metrics = dashboardMetrics(data);
  const cards = [
    ["Оплачено", metrics.settled.length, "без долга и аванса", "ok"],
    ["Есть долг", metrics.debtors.length, rub(data.totals.debt), "danger"],
    ["Есть аванс", metrics.overpaid.length, rub(data.totals.overpaid), "info"]
  ];

  target.innerHTML = cards
    .map(
      ([label, count, detail, tone]) => `
        <article class="status-card status-card-${tone}">
          <span>${label}</span>
          <strong>${count}</strong>
          <small>${detail}</small>
        </article>
      `
    )
    .join("");
}

function renderHousesOverview(target, data) {
  const metrics = dashboardMetrics(data);
  target.innerHTML = `
    <div>
      <span class="summary-label">Собираемость</span>
      <strong>${metrics.collectionRate}%</strong>
    </div>
    <div class="summary-progress">
      <span style="width: ${metrics.collectionRate}%"></span>
    </div>
    <div>
      <span class="summary-label">Всего домов</span>
      <strong>${metrics.houses.length}</strong>
    </div>
  `;
}

function houseBalanceCell(house) {
  if (house.debt > 0) return `<span class="amount-danger">${houseBalanceText(house)}</span>`;
  if (house.overpaid > 0) return `<span class="amount-ok">${houseBalanceText(house)}</span>`;
  return `<span class="amount-ok">оплачено</span>`;
}

function houseBalanceText(house) {
  if (house.debt > 0) return rub(house.debt);
  if (house.overpaid > 0) return `+${rub(house.overpaid)}`;
  return "оплачено";
}

function houseStatusLabel(house) {
  if (house.debt > 0) return "долг";
  if (house.overpaid > 0) return "аванс";
  return "оплачено";
}

function housePaymentLabel(house) {
  if (house.debt > 0) return "к оплате";
  if (house.overpaid > 0) return "аванс";
  return "статус";
}

function streetTone(house) {
  if (!house) return "empty";
  if (house.debt > 0) return "debt";
  if (house.overpaid > 0) return "overpaid";
  return "paid";
}

function renderStreetMap(target, houses) {
  if (!houses.length) {
    target.innerHTML = `<p class="muted">Дома появятся здесь после загрузки базы.</p>`;
    return;
  }

  const byNumber = new Map(houses.map((house) => [Number(house.number), house]));
  const numbers = houses.map((house) => Number(house.number));
  const minNumber = Math.min(...numbers);
  const maxNumber = Math.max(...numbers);
  const minEven = minNumber % 2 === 0 ? minNumber : minNumber + 1;
  const maxEven = maxNumber % 2 === 0 ? maxNumber : maxNumber + 1;
  const rows = [];

  for (let even = maxEven; even >= minEven; even -= 2) {
    rows.push({
      even: byNumber.get(even),
      odd: byNumber.get(even - 1),
      expectedEven: even <= maxNumber ? even : null,
      expectedOdd: even - 1 >= minNumber ? even - 1 : null
    });
  }

  const houseTile = (house, expectedNumber) => {
    if (!expectedNumber) {
      return `<div class="street-house street-house-spacer" aria-hidden="true"></div>`;
    }

    if (!house) {
      return `
        <div class="street-house street-house-empty">
          <div class="street-house-number">№ ${expectedNumber}</div>
          <strong>нет данных</strong>
          <span>участок</span>
        </div>
      `;
    }

    const href = housePageUrl(house);
    const tag = href ? "a" : "article";
    const link = href ? ` href="${href}"` : "";

    return `
      <${tag}${link} class="street-house street-house-${streetTone(house)}">
        <div class="street-house-number">№ ${house.number}</div>
        <strong>${houseBalanceText(house)}</strong>
        <span>${housePaymentLabel(house)}</span>
      </${tag}>
    `;
  };

  target.innerHTML = `
    <div class="street-map-legend">
      <span><b class="legend-dot legend-paid"></b>оплачено</span>
      <span><b class="legend-dot legend-debt"></b>долг</span>
      <span><b class="legend-dot legend-overpaid"></b>аванс</span>
    </div>
    <div class="street-road">
      <div class="street-name">Уютная</div>
      ${rows
        .map(
          (row) => `
          <div class="street-row">
            <div class="street-side street-side-left">${houseTile(row.even, row.expectedEven)}</div>
            <div class="road-lane" aria-hidden="true"></div>
            <div class="street-side street-side-right">${houseTile(row.odd, row.expectedOdd)}</div>
          </div>
        `
        )
        .join("")}
    </div>
  `;
}

function renderHousesTable(target, houses, includeLinks = false) {
  target.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Дом</th>
          <th>Состояние</th>
          <th>Начало пользования</th>
          <th>Оплачено</th>
          <th>Начислено</th>
          <th>Баланс</th>
          ${includeLinks ? "<th>Ссылка</th>" : ""}
        </tr>
      </thead>
      <tbody>
        ${houses
          .map(
            (house) => `
            <tr>
              <td>${escapeHtml(house.displayName || `Дом ${house.number}`)}</td>
              <td><span class="house-status ${balanceClass(house)}">${houseStatusLabel(house)}</span></td>
              <td>${house.startsOn || "-"}</td>
              <td>${rub(house.paid)}</td>
              <td>${rub(house.due)}</td>
              <td>${houseBalanceCell(house)}</td>
              ${includeLinks ? `<td><a href="${housePageUrl(house)}">открыть</a></td>` : ""}
            </tr>
          `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderHouseCards(target, houses) {
  target.innerHTML = houses
    .map((house) => {
      const rate = percent(house.paid, house.due);
      return `
        <article class="house-card">
          <div class="house-card-head">
            <strong>${escapeHtml(house.displayName || `Дом ${house.number}`)}</strong>
            <span class="${balanceClass(house)}">${houseBalanceText(house)}</span>
          </div>
          <div class="progress-line" aria-label="Оплачено ${rate}%">
            <span style="width: ${rate}%"></span>
          </div>
          <dl>
            <div><dt>Оплачено</dt><dd>${rub(house.paid)}</dd></div>
            <div><dt>Начислено</dt><dd>${rub(house.due)}</dd></div>
            <div><dt>Начало</dt><dd>${house.startsOn || "-"}</dd></div>
          </dl>
        </article>
      `;
    })
    .join("");
}

function renderAdminHousesTable(target, houses) {
  target.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Дом</th>
          <th>Начало пользования</th>
          <th>Оплачено</th>
          <th>Начислено</th>
          <th>Баланс</th>
          <th>Ссылка</th>
          <th>Telegram</th>
          <th>MAX</th>
        </tr>
      </thead>
      <tbody>
        ${houses
          .map(
            (house) => `
            <tr>
              <td>${escapeHtml(house.displayName || `Дом ${house.number}`)}</td>
              <td>
                <div class="inline-edit">
                  <input type="month" value="${house.startsOn || ""}" data-house-start="${house.number}" />
                  <button type="button" data-save-start="${house.number}">Сохр.</button>
                </div>
              </td>
              <td>${rub(house.paid)}</td>
              <td>${rub(house.due)}</td>
              <td>${houseBalanceCell(house)}</td>
              <td><a href="${housePageUrl(house)}">открыть</a></td>
              <td>${renderHouseTelegramHistory(house.telegramMessages || [])}</td>
              <td>${renderHouseMaxHistory(house.maxMessages || [])}</td>
            </tr>
          `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderExpenses(target, expenses) {
  target.innerHTML = expenses.length
    ? expenses
        .map(
          (expense) => `
          <article class="compact-row">
            <div>
              <strong>${expense.title}</strong>
              <span>${formatDate(expense.spentAt || expense.spent_at)} · ${expense.category || "прочее"}</span>
            </div>
            <strong>${rub(expense.amount)}</strong>
          </article>
        `
        )
        .join("")
    : `<p class="muted">Расходов пока нет.</p>`;
}

function renderPriorityList(target, houses) {
  const debtors = houses
    .filter((house) => Number(house.debt || 0) > 0)
    .sort((a, b) => Number(b.debt || 0) - Number(a.debt || 0))
    .slice(0, 6);

  target.innerHTML = debtors.length
    ? debtors
        .map(
          (house) => `
          <article class="compact-row">
            <div>
              <strong>${escapeHtml(house.displayName || `Дом ${house.number}`)}</strong>
              <span>последний платеж: ${formatDate(house.lastPaymentAt)}</span>
            </div>
            <strong class="amount-danger">${rub(house.debt)}</strong>
          </article>
        `
        )
        .join("")
    : `<p class="muted">Домов с долгом нет.</p>`;
}

function renderAdminPayments(target, payments) {
  target.innerHTML = payments.length
    ? payments
        .map(
          (payment) => {
            const summary = `платеж дома ${payment.houseNumber} на ${rub(payment.amount)} от ${formatDate(payment.paidAt)}`;
            return `
          <article class="item">
            <div class="item-row">
              <strong>Дом ${payment.houseNumber}</strong>
              <div class="item-actions">
                <strong>${rub(payment.amount)}</strong>
                <button
                  type="button"
                  class="button-small danger-button"
                  data-payment-delete="${payment.id}"
                  data-payment-summary="${escapeHtml(summary)}"
                >Удалить</button>
              </div>
            </div>
            <p class="muted">#${payment.id} · ${formatDate(payment.paidAt)} · ${payment.method} · ${payment.source}</p>
          </article>
        `;
          }
        )
        .join("")
    : `<p class="muted">Платежей пока нет.</p>`;
}

function renderAdminExpenses(target, expenses) {
  target.innerHTML = expenses.length
    ? expenses
        .map(
          (expense) => `
          <article class="item">
            <div class="item-row">
              <strong>${expense.title}</strong>
              <strong>${rub(expense.amount)}</strong>
            </div>
            <p class="muted">${formatDate(expense.spent_at)} · ${expense.category || "прочее"} · ${expense.source}</p>
          </article>
        `
        )
        .join("")
    : `<p class="muted">Расходов пока нет.</p>`;
}

async function initDashboard() {
  const data = await api("/api/dashboard");
  renderDashboardHero(document.querySelector("#balanceHero"), data);
  renderDashboardStats(document.querySelector("#dashboardStats"), data);
  renderStatusSummary(document.querySelector("#statusSummary"), data);
  renderHousesOverview(document.querySelector("#housesOverview"), data);
  renderStreetMap(document.querySelector("#streetMap"), data.houses);
  renderHousesTable(document.querySelector("#housesTable"), data.houses);
  renderHouseCards(document.querySelector("#housesCards"), data.houses);
  renderPriorityList(document.querySelector("#priorityList"), data.houses);
  renderExpenses(document.querySelector("#expensesList"), data.recentExpenses);
  document.querySelector("#asOfMonth").textContent = `на ${data.asOfMonth}`;
  document.querySelector("#updatedAt").textContent = `Обновлено ${new Date(data.updatedAt).toLocaleString("ru-RU")}`;
}

function monthTitle(month) {
  const [year, number] = month.split("-");
  return `${number}.${year}`;
}

async function initHouse() {
  const pathCode = location.pathname.includes("/h/") ? location.pathname.split("/h/").pop().replace(/\/$/, "") : "";
  const code = decodeURIComponent(pathCode || new URLSearchParams(location.search).get("code"));
  const data = await api(`/api/house/${encodeURIComponent(code)}`);
  document.querySelector("#houseTitle").textContent = data.house.displayName;
  document.querySelector("#housePeriod").textContent = `начало пользования ${data.house.startsOn || "-"} · расчет на ${data.asOfMonth}`;
  renderHouseStats(document.querySelector("#houseStats"), data.house);

  document.querySelector("#monthsGrid").innerHTML = data.months
    .map(
      (month) => `
      <div class="month status-${month.status}">
        <strong>${monthTitle(month.month)}</strong>
        <span>${rub(month.paid)} / ${rub(month.charge)}</span>
        <span>${statusLabel(month.status)}</span>
      </div>
    `
    )
    .join("");

  document.querySelector("#housePayments").innerHTML = data.payments.length
    ? data.payments
        .map(
          (payment) => `
          <article class="item">
            <div class="item-row">
              <strong>${formatDate(payment.paidAt)}</strong>
              <strong>${rub(payment.amount)}</strong>
            </div>
            ${payment.comment ? `<p class="muted">${payment.comment}</p>` : ""}
          </article>
        `
        )
        .join("")
    : `<p class="muted">Платежей пока нет.</p>`;
  document.querySelector("#paymentInstruction").textContent = data.paymentInstruction;
}

function statusLabel(status) {
  return {
    paid: "оплачено",
    partial: "частично",
    unpaid: "долг",
    not_applicable: "не участвует",
    overpaid: "аванс"
  }[status] || status;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function renderMonthlyChargeForm(monthlyChargeYear) {
  const target = document.querySelector("#monthlyChargeForm");
  if (!target) return;

  const year = monthlyChargeYear?.year || new Date().getFullYear();
  const months = monthlyChargeYear?.months || [];
  const monthLabel = (month) => {
    const [itemYear, itemMonth] = String(month || "").split("-").map(Number);
    return new Intl.DateTimeFormat("ru-RU", { month: "long" }).format(new Date(itemYear, itemMonth - 1, 1));
  };

  target.innerHTML = `
    <input name="year" type="hidden" value="${escapeHtml(year)}" />
    <div class="monthly-charge-list full">
      ${months
        .map(
          (charge) => `
            <label class="monthly-charge-row">
              <span>
                <strong>${escapeHtml(monthLabel(charge.month))}</strong>
                <small>${escapeHtml(charge.month)} · база ${rub(charge.baseAmount)}${charge.extraAmount ? ` · доп. ${rub(charge.extraAmount)}` : ""}${charge.isOverridden ? " · вручную" : ""}</small>
              </span>
              <input
                name="amount-${escapeHtml(charge.month)}"
                type="number"
                min="0"
                step="1"
                value="${Number(charge.amount || 0)}"
                data-monthly-charge="${escapeHtml(charge.month)}"
                required
              />
            </label>
          `
        )
        .join("")}
    </div>
    <button type="submit" class="full">Сохранить суммы года</button>
  `;
}

function renderPaymentForm(houses) {
  const options = houses.map((house) => `<option value="${house.number}">${house.displayName}</option>`).join("");
  document.querySelector("#paymentForm").innerHTML = `
    <label>Дом<select name="houseNumber" required>${options}</select></label>
    <label>Дата<input name="paidAt" type="date" value="${today()}" required /></label>
    <label>Сумма<input name="amount" type="number" min="1" step="1" required /></label>
    <label>Способ
      <select name="method">
        <option value="other">другое</option>
        <option value="cash">наличные</option>
        <option value="bank_transfer">перевод</option>
        <option value="sbp">СБП</option>
        <option value="card">карта</option>
      </select>
    </label>
    <label>Распределять с месяца<input name="startMonth" type="month" /></label>
    <label class="full">Комментарий<textarea name="commentPrivate"></textarea></label>
    <button type="submit" class="full">Сохранить платеж</button>
  `;
}

function renderExpenseForm(categories) {
  const options = categories.map((category) => `<option value="${category.name}">${category.name}</option>`).join("");
  document.querySelector("#expenseForm").innerHTML = `
    <label>Дата<input name="spentAt" type="date" value="${today()}" required /></label>
    <label>Сумма<input name="amount" type="number" min="1" step="1" required /></label>
    <label>Категория<select name="category">${options}</select></label>
    <label>Название<input name="title" required /></label>
    <label class="full">Публичное описание<textarea name="descriptionPublic"></textarea></label>
    <button type="submit" class="full">Сохранить расход</button>
  `;
}

function renderHouseForm() {
  document.querySelector("#houseForm").innerHTML = `
    <label>Номер<input name="number" type="number" min="1" required /></label>
    <label>Название<input name="displayName" placeholder="ул. Уютная 25" /></label>
    <label>Статус
      <select name="status">
        <option value="active">active</option>
        <option value="paused">paused</option>
        <option value="disconnected">disconnected</option>
        <option value="archived">archived</option>
      </select>
    </label>
    <label>Начало пользования<input name="startsOn" type="month" /></label>
    <label class="full">Приватная заметка<textarea name="privateNotes"></textarea></label>
    <button type="submit" class="full">Сохранить дом</button>
  `;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function formatDateTime(value) {
  if (!value) return "-";
  const normalized = typeof value === "string" && value.includes(" ") ? value.replace(" ", "T") : value;
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "medium"
  }).format(new Date(normalized));
}

function renderTelegramStatus(target, status) {
  if (!target) return;

  const isStarting = status.enabled && status.startedAt && !status.lastPollAt && !status.lastError;
  const stateText = !status.configured
    ? "Токен не задан"
    : status.running
      ? "Бот слушает Telegram"
      : isStarting
        ? "Бот запускается"
        : "Бот не отвечает";
  const stateClass = status.running || isStarting ? "amount-ok" : "amount-danger";

  target.innerHTML = `
    <h3>Telegram-бот</h3>
    <p><strong class="${stateClass}">${stateText}</strong></p>
    <dl>
      <div><dt>Username</dt><dd>${status.username ? `@${escapeHtml(status.username)}` : "-"}</dd></div>
      <div><dt>Админов</dt><dd>${Number(status.adminCount || 0)}</dd></div>
      <div><dt>Последний опрос</dt><dd>${formatDateTime(status.lastPollAt)}</dd></div>
      <div><dt>Последнее сообщение</dt><dd>${formatDateTime(status.lastUpdateAt)}</dd></div>
      <div><dt>Обработано</dt><dd>${Number(status.processedUpdates || 0)}</dd></div>
    </dl>
    ${status.lastError ? `<p class="telegram-error">${escapeHtml(status.lastError)}</p>` : ""}
  `;
}

function renderMaxStatus(target, status) {
  if (!target) return;

  const isReady = status.running || status.webhookSubscribed;
  const modeText =
    status.mode === "webhook" ? "Webhook" : status.mode === "polling" ? "Long polling" : "ожидает настройки";
  const stateText = !status.configured
    ? "Токен не задан"
    : isReady
      ? `Бот MAX подключен (${modeText})`
      : "Бот MAX не отвечает";
  const stateClass = isReady ? "amount-ok" : "amount-danger";

  target.innerHTML = `
    <h3>MAX-бот</h3>
    <p><strong class="${stateClass}">${stateText}</strong></p>
    <dl>
      <div><dt>Username</dt><dd>${status.username ? `@${escapeHtml(status.username)}` : "-"}</dd></div>
      <div><dt>Админов</dt><dd>${Number(status.adminCount || 0)}</dd></div>
      <div><dt>Режим</dt><dd>${escapeHtml(modeText)}</dd></div>
      <div><dt>Webhook</dt><dd>${status.webhookUrl ? escapeHtml(status.webhookUrl) : "-"}</dd></div>
      <div><dt>Последний опрос</dt><dd>${formatDateTime(status.lastPollAt)}</dd></div>
      <div><dt>Последнее событие</dt><dd>${formatDateTime(status.lastUpdateAt)}</dd></div>
      <div><dt>Обработано</dt><dd>${Number(status.processedUpdates || 0)}</dd></div>
    </dl>
    ${status.lastError ? `<p class="telegram-error">${escapeHtml(status.lastError)}</p>` : ""}
  `;
}

function telegramUserName(user) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const username = user.username ? `@${user.username}` : "";
  return fullName && username ? `${fullName} (${username})` : fullName || username || `id ${user.telegram_user_id}`;
}

function telegramFileUrl(fileId) {
  return `/api/admin/telegram/file?fileId=${encodeURIComponent(fileId)}`;
}

function telegramImagePreview(fileId, label = "Скрин платежа") {
  if (!fileId) return "";
  const url = telegramFileUrl(fileId);
  return `
    <button type="button" class="telegram-thumb" data-image-preview="${url}" aria-label="${escapeHtml(label)}">
      <img src="${url}" alt="${escapeHtml(label)}" loading="lazy" />
    </button>
  `;
}

function renderTelegramClaims(target, claims) {
  if (!target) return;
  target.innerHTML = claims.length
    ? claims
        .map((claim) => {
          const screenshotPreview = claim.screenshot_file_id
            ? telegramImagePreview(claim.screenshot_file_id, `Скрин заявки #${claim.id}`)
            : `<span class="amount-danger">нет скрина</span>`;
          return `
            <article class="item telegram-claim">
              <div class="item-row">
                <strong>#${claim.id} · Дом ${claim.house_number}</strong>
                <strong>${rub(claim.amount)}</strong>
              </div>
              <p class="muted">${formatDate(claim.paid_at)} · ${escapeHtml(claim.submitted_by_name || telegramUserName(claim))}</p>
              ${screenshotPreview}
              ${claim.comment_public ? `<p>${escapeHtml(claim.comment_public)}</p>` : ""}
              <div class="button-row">
                <button type="button" class="button-small" data-claim-action="approve" data-claim-id="${claim.id}">Подтвердить</button>
                <button type="button" class="button-small danger-button" data-claim-action="reject" data-claim-id="${claim.id}">Отклонить</button>
              </div>
            </article>
          `;
        })
        .join("")
    : `<p class="muted">Необработанных платежей нет.</p>`;
}

function renderTelegramUsers(target, users, houses) {
  if (!target) return;
  const houseByNumber = new Map(houses.map((house) => [String(house.number), house]));
  const houseOptionLabel = (house) => `Дом ${house.number} · ${house.displayName}`;
  const userHouseLabel = (user) => {
    if (!user.house_number) return "Дом не привязан";
    const house = houseByNumber.get(String(user.house_number));
    return `Дом ${user.house_number} · ${user.house_display_name || house?.displayName || `ул. Уютная ${user.house_number}`}`;
  };
  const houseOptions = (selected) =>
    [
      `<option value="">не привязан</option>`,
      ...houses.map((house) => {
        const value = String(house.number);
        return `<option value="${value}" ${String(selected || "") === value ? "selected" : ""}>${escapeHtml(houseOptionLabel(house))}</option>`;
      })
    ].join("");

  target.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Пользователь</th>
          <th>Дом</th>
          <th>Сообщений</th>
          <th>Последнее</th>
        </tr>
      </thead>
      <tbody>
        ${users
          .map(
            (user) => `
              <tr>
                <td>
                  <strong>${escapeHtml(telegramUserName(user))}</strong>
                  <span class="muted">id ${escapeHtml(user.telegram_user_id)}</span>
                </td>
                <td>
                  <strong class="telegram-house-summary">${escapeHtml(userHouseLabel(user))}</strong>
                  <select data-telegram-user-house="${escapeHtml(user.telegram_user_id)}">
                    ${houseOptions(user.house_number)}
                  </select>
                </td>
                <td>${Number(user.message_count || 0)}</td>
                <td>${formatDateTime(user.last_message_at)}</td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderTelegramUserForm(houses) {
  const target = document.querySelector("#telegramUserForm");
  if (!target) return;
  const options = houses
    .map((house) => `<option value="${house.number}">${escapeHtml(`Дом ${house.number} · ${house.displayName}`)}</option>`)
    .join("");
  target.innerHTML = `
    <label>Telegram ID<input name="telegramUserId" inputmode="numeric" required /></label>
    <label>Username<input name="username" placeholder="@username" /></label>
    <label>Имя<input name="firstName" /></label>
    <label>Дом<select name="houseNumber" required>${options}</select></label>
    <button type="submit" class="full">Добавить аккаунт</button>
  `;
}

function telegramMessageTitle(message) {
  return message.direction === "out" ? "Бот" : telegramUserName(message);
}

function telegramMessageDetail(message) {
  return [
    message.direction === "out" ? "исходящее" : "входящее",
    message.kind,
    message.house_number ? `дом ${message.house_number}` : "",
    formatDateTime(message.created_at)
  ]
    .filter(Boolean)
    .join(" · ");
}

function telegramMessageText(message) {
  return message.callback_data ? `Кнопка: ${message.callback_data}` : message.text || (message.photo_file_id ? "Фото" : "");
}

function renderTelegramMessageCard(message) {
  const screenshotLink = message.photo_file_id ? telegramImagePreview(message.photo_file_id, "Фото из Telegram") : "";
  return `
    <article class="telegram-message telegram-message-${message.direction}">
      <div>
        <strong>${escapeHtml(telegramMessageTitle(message))}</strong>
        <span>${escapeHtml(telegramMessageDetail(message))}</span>
      </div>
      <p>${escapeHtml(telegramMessageText(message) || "-")}</p>
      ${screenshotLink}
    </article>
  `;
}

function renderHouseTelegramHistory(messages) {
  if (!messages.length) return `<span class="muted">-</span>`;
  return `
    <details class="house-telegram-history">
      <summary>Последние ${messages.length}</summary>
      <div class="house-telegram-list">
        ${messages
          .map(
            (message) => `
              <article class="telegram-message-compact telegram-message-${message.direction}">
                <strong>${escapeHtml(telegramMessageTitle(message))}</strong>
                <span>${escapeHtml(telegramMessageDetail(message))}</span>
                <p>${escapeHtml(telegramMessageText(message) || "-")}</p>
              </article>
            `
          )
          .join("")}
      </div>
    </details>
  `;
}

function renderTelegramMessages(target, messages) {
  if (!target) return;
  target.innerHTML = messages.length
    ? messages.map((message) => renderTelegramMessageCard(message)).join("")
    : `<p class="muted">История пока пустая.</p>`;
}

function maxUserName(user) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const username = user.username ? `@${user.username}` : "";
  return fullName && username ? `${fullName} (${username})` : fullName || username || `id ${user.max_user_id}`;
}

function maxClaimHasScreenshot(claim) {
  return Boolean(String(claim.screenshot_attachment || "").trim() && String(claim.screenshot_attachment || "").trim() !== "{}");
}

function renderMaxClaims(target, claims) {
  if (!target) return;
  target.innerHTML = claims.length
    ? claims
        .map((claim) => {
          const screenshotText = maxClaimHasScreenshot(claim)
            ? `<span class="amount-ok">скрин приложен</span>`
            : `<span class="amount-danger">нет скрина</span>`;
          return `
            <article class="item telegram-claim">
              <div class="item-row">
                <strong>#${claim.id} · Дом ${claim.house_number}</strong>
                <strong>${rub(claim.amount)}</strong>
              </div>
              <p class="muted">${formatDate(claim.paid_at)} · ${escapeHtml(claim.submitted_by_name || maxUserName(claim))}</p>
              <p>${screenshotText}</p>
              ${claim.comment_public ? `<p>${escapeHtml(claim.comment_public)}</p>` : ""}
              <div class="button-row">
                <button type="button" class="button-small" data-max-claim-action="approve" data-max-claim-id="${claim.id}">Подтвердить</button>
                <button type="button" class="button-small danger-button" data-max-claim-action="reject" data-max-claim-id="${claim.id}">Отклонить</button>
              </div>
            </article>
          `;
        })
        .join("")
    : `<p class="muted">Необработанных платежей из MAX нет.</p>`;
}

function renderMaxUsers(target, users, houses) {
  if (!target) return;
  const houseByNumber = new Map(houses.map((house) => [String(house.number), house]));
  const houseOptionLabel = (house) => `Дом ${house.number} · ${house.displayName}`;
  const userHouseLabel = (user) => {
    if (!user.house_number) return "Дом не привязан";
    const house = houseByNumber.get(String(user.house_number));
    return `Дом ${user.house_number} · ${user.house_display_name || house?.displayName || `ул. Уютная ${user.house_number}`}`;
  };
  const houseOptions = (selected) =>
    [
      `<option value="">не привязан</option>`,
      ...houses.map((house) => {
        const value = String(house.number);
        return `<option value="${value}" ${String(selected || "") === value ? "selected" : ""}>${escapeHtml(houseOptionLabel(house))}</option>`;
      })
    ].join("");

  target.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Пользователь</th>
          <th>Дом</th>
          <th>Сообщений</th>
          <th>Последнее</th>
        </tr>
      </thead>
      <tbody>
        ${users
          .map(
            (user) => `
              <tr>
                <td>
                  <strong>${escapeHtml(maxUserName(user))}</strong>
                  <span class="muted">id ${escapeHtml(user.max_user_id)}</span>
                </td>
                <td>
                  <strong class="telegram-house-summary">${escapeHtml(userHouseLabel(user))}</strong>
                  <select data-max-user-house="${escapeHtml(user.max_user_id)}">
                    ${houseOptions(user.house_number)}
                  </select>
                </td>
                <td>${Number(user.message_count || 0)}</td>
                <td>${formatDateTime(user.last_message_at)}</td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderMaxUserForm(houses) {
  const target = document.querySelector("#maxUserForm");
  if (!target) return;
  const options = houses
    .map((house) => `<option value="${house.number}">${escapeHtml(`Дом ${house.number} · ${house.displayName}`)}</option>`)
    .join("");
  target.innerHTML = `
    <label>MAX ID<input name="maxUserId" inputmode="numeric" required /></label>
    <label>Username<input name="username" placeholder="@username" /></label>
    <label>Имя<input name="firstName" /></label>
    <label>Дом<select name="houseNumber" required>${options}</select></label>
    <button type="submit" class="full">Добавить аккаунт</button>
  `;
}

function maxMessageTitle(message) {
  return message.direction === "out" ? "Бот" : maxUserName(message);
}

function maxMessageDetail(message) {
  return [
    "MAX",
    message.direction === "out" ? "исходящее" : "входящее",
    message.kind,
    message.house_number ? `дом ${message.house_number}` : "",
    formatDateTime(message.created_at)
  ]
    .filter(Boolean)
    .join(" · ");
}

function maxMessageText(message) {
  return message.callback_payload
    ? `Кнопка: ${message.callback_payload}`
    : message.text || (message.attachment_json ? "Вложение" : "");
}

function renderMaxMessageCard(message) {
  return `
    <article class="telegram-message telegram-message-${message.direction}">
      <div>
        <strong>${escapeHtml(maxMessageTitle(message))}</strong>
        <span>${escapeHtml(maxMessageDetail(message))}</span>
      </div>
      <p>${escapeHtml(maxMessageText(message) || "-")}</p>
    </article>
  `;
}

function renderHouseMaxHistory(messages) {
  if (!messages.length) return `<span class="muted">-</span>`;
  return `
    <details class="house-telegram-history">
      <summary>Последние ${messages.length}</summary>
      <div class="house-telegram-list">
        ${messages
          .map(
            (message) => `
              <article class="telegram-message-compact telegram-message-${message.direction}">
                <strong>${escapeHtml(maxMessageTitle(message))}</strong>
                <span>${escapeHtml(maxMessageDetail(message))}</span>
                <p>${escapeHtml(maxMessageText(message) || "-")}</p>
              </article>
            `
          )
          .join("")}
      </div>
    </details>
  `;
}

function renderMaxMessages(target, messages) {
  if (!target) return;
  target.innerHTML = messages.length
    ? messages.map((message) => renderMaxMessageCard(message)).join("")
    : `<p class="muted">История MAX пока пустая.</p>`;
}

async function loadTelegramAdmin(data) {
  const telegram = await api("/api/admin/telegram/data");
  renderTelegramUserForm(data.houses || []);
  renderTelegramClaims(document.querySelector("#telegramClaims"), telegram.pendingClaims || []);
  renderTelegramUsers(document.querySelector("#telegramUsers"), telegram.users || [], data.houses || []);
  renderTelegramMessages(document.querySelector("#telegramMessages"), telegram.messages || []);
  return telegram;
}

async function loadMaxAdmin(data) {
  const max = await api("/api/admin/max/data");
  renderMaxUserForm(data.houses || []);
  renderMaxClaims(document.querySelector("#maxClaims"), max.pendingClaims || []);
  renderMaxUsers(document.querySelector("#maxUsers"), max.users || [], data.houses || []);
  renderMaxMessages(document.querySelector("#maxMessages"), max.messages || []);
  return max;
}

function openImagePreview(url) {
  document.querySelector(".image-preview")?.remove();
  document.body.insertAdjacentHTML(
    "beforeend",
    `
      <div class="image-preview" role="dialog" aria-modal="true">
        <button type="button" class="image-preview-backdrop" data-image-preview-close aria-label="Закрыть"></button>
        <div class="image-preview-box">
          <button type="button" class="image-preview-close" data-image-preview-close>Закрыть</button>
          <img src="${escapeHtml(url)}" alt="Скрин платежа" />
        </div>
      </div>
    `
  );
}

async function loadTelegramStatus() {
  const target = document.querySelector("#telegramStatus");
  if (!target) return;
  try {
    renderTelegramStatus(target, await api("/api/admin/telegram"));
  } catch (error) {
    target.innerHTML = `<p class="telegram-error">${escapeHtml(error.message)}</p>`;
  }
}

async function loadMaxStatus() {
  const target = document.querySelector("#maxStatus");
  if (!target) return;
  try {
    renderMaxStatus(target, await api("/api/admin/max"));
  } catch (error) {
    target.innerHTML = `<p class="telegram-error">${escapeHtml(error.message)}</p>`;
  }
}

async function loadAdmin() {
  const data = await api("/api/admin/summary");
  document.querySelector("#loginPanel").classList.add("hidden");
  document.querySelector("#adminPanel").classList.remove("hidden");
  document.querySelector("#logoutButton").classList.remove("hidden");
  renderStats(document.querySelector("#adminStats"), data.dashboard.totals);
  renderMonthlyChargeForm(data.monthlyChargeYear);
  renderPaymentForm(data.houses);
  renderExpenseForm(data.categories);
  renderHouseForm();
  await loadTelegramStatus();
  await loadMaxStatus();
  let telegram = { messagesByHouse: {} };
  try {
    telegram = await loadTelegramAdmin(data);
  } catch (error) {
    document.querySelector("#telegramMessages").innerHTML = `<p class="telegram-error">${escapeHtml(error.message)}</p>`;
  }
  let max = { messagesByHouse: {} };
  try {
    max = await loadMaxAdmin(data);
  } catch (error) {
    document.querySelector("#maxMessages").innerHTML = `<p class="telegram-error">${escapeHtml(error.message)}</p>`;
  }
  const messagesByHouse = telegram.messagesByHouse || {};
  const maxMessagesByHouse = max.messagesByHouse || {};
  renderAdminHousesTable(
    document.querySelector("#adminHouses"),
    data.houses.map((house) => {
      const publicRow = data.dashboard.houses.find((item) => item.number === house.number) || {};
      return {
        ...house,
        ...publicRow,
        telegramMessages: messagesByHouse[String(house.number)] || [],
        maxMessages: maxMessagesByHouse[String(house.number)] || []
      };
    })
  );
  renderAdminPayments(document.querySelector("#adminPayments"), data.recentPayments);
  renderAdminExpenses(document.querySelector("#adminExpenses"), data.recentExpenses);
}

async function initAdmin() {
  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await api("/api/login", { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
    await loadAdmin();
  });

  document.querySelector("#logoutButton").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    location.reload();
  });

  document.querySelector("#monthlyChargeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const status = document.querySelector("#monthlyChargeStatus");
    button.disabled = true;
    status.textContent = "Сохраняем...";
    try {
      const charges = [...form.querySelectorAll("[data-monthly-charge]")].map((input) => ({
        month: input.dataset.monthlyCharge,
        amount: input.value
      }));
      await api("/api/admin/monthly-charge", {
        method: "POST",
        body: JSON.stringify({ year: form.elements.year.value, charges })
      });
      await loadAdmin();
      document.querySelector("#monthlyChargeStatus").textContent = "Суммы года сохранены.";
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });

  document.querySelector("#paymentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await api("/api/admin/payments", { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
    await loadAdmin();
  });

  document.querySelector("#expenseForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await api("/api/admin/expenses", { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
    await loadAdmin();
  });

  document.querySelector("#houseForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await api("/api/admin/houses", { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
    await loadAdmin();
  });

  document.querySelector("#databaseForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.database.files[0];
    if (!file) return;
    if (!confirm("Заменить текущую базу на выбранный файл?")) return;

    const button = form.querySelector("button");
    const status = document.querySelector("#databaseStatus");
    button.disabled = true;
    status.textContent = "Загрузка...";
    try {
      const result = await uploadDatabase(file);
      const summary = result.summary || {};
      status.textContent = `Загружено: домов ${summary.houses || 0}, платежей ${summary.payments || 0}, расходов ${summary.expenses || 0}.`;
      await loadAdmin();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#adminHouses").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-save-start]");
    if (!button) return;
    const number = button.dataset.saveStart;
    const input = document.querySelector(`[data-house-start="${number}"]`);
    button.disabled = true;
    await api("/api/admin/houses", {
      method: "POST",
      body: JSON.stringify({ number, startsOn: input.value })
    });
    await loadAdmin();
  });

  document.querySelector("#adminPayments").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-payment-delete]");
    if (!button) return;
    const paymentId = button.dataset.paymentDelete;
    const summary = button.dataset.paymentSummary || `платеж #${paymentId}`;
    if (!confirm(`Удалить ${summary}? Это действие нельзя отменить.`)) return;

    button.disabled = true;
    try {
      await api(`/api/admin/payments/${encodeURIComponent(paymentId)}`, { method: "DELETE" });
      await loadAdmin();
    } catch (error) {
      button.disabled = false;
      alert(error.message);
    }
  });

  document.querySelector("#telegramClaims").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-claim-action]");
    if (!button) return;
    button.disabled = true;
    try {
      await api("/api/admin/telegram/claims/review", {
        method: "POST",
        body: JSON.stringify({ claimId: button.dataset.claimId, action: button.dataset.claimAction })
      });
      await loadAdmin();
    } catch (error) {
      button.disabled = false;
      alert(error.message);
    }
  });

  document.querySelector("#telegramUsers").addEventListener("change", async (event) => {
    const select = event.target.closest("[data-telegram-user-house]");
    if (!select) return;
    select.disabled = true;
    try {
      await api("/api/admin/telegram/users/link", {
        method: "POST",
        body: JSON.stringify({ telegramUserId: select.dataset.telegramUserHouse, houseNumber: select.value })
      });
      await loadAdmin();
    } catch (error) {
      select.disabled = false;
      alert(error.message);
    }
  });

  document.querySelector("#telegramUserForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await api("/api/admin/telegram/users", { method: "POST", body: JSON.stringify(formData(form)) });
      form.reset();
      await loadAdmin();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#maxClaims").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-max-claim-action]");
    if (!button) return;
    button.disabled = true;
    try {
      await api("/api/admin/max/claims/review", {
        method: "POST",
        body: JSON.stringify({ claimId: button.dataset.maxClaimId, action: button.dataset.maxClaimAction })
      });
      await loadAdmin();
    } catch (error) {
      button.disabled = false;
      alert(error.message);
    }
  });

  document.querySelector("#maxUsers").addEventListener("change", async (event) => {
    const select = event.target.closest("[data-max-user-house]");
    if (!select) return;
    select.disabled = true;
    try {
      await api("/api/admin/max/users/link", {
        method: "POST",
        body: JSON.stringify({ maxUserId: select.dataset.maxUserHouse, houseNumber: select.value })
      });
      await loadAdmin();
    } catch (error) {
      select.disabled = false;
      alert(error.message);
    }
  });

  document.querySelector("#maxUserForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await api("/api/admin/max/users", { method: "POST", body: JSON.stringify(formData(form)) });
      form.reset();
      await loadAdmin();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  });

  document.addEventListener("click", (event) => {
    const preview = event.target.closest("[data-image-preview]");
    if (preview) {
      openImagePreview(preview.dataset.imagePreview);
      return;
    }
    if (event.target.closest("[data-image-preview-close]")) {
      document.querySelector(".image-preview")?.remove();
    }
  });

  await loadAdmin().catch(() => {
    document.querySelector("#loginPanel").classList.remove("hidden");
  });
}

try {
  if (page === "dashboard") await initDashboard();
  if (page === "house") await initHouse();
  if (page === "admin") await initAdmin();
} catch (error) {
  document.querySelector("main").insertAdjacentHTML("beforeend", `<div class="notice">${error.message}</div>`);
}
