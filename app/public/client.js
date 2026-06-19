const page = document.body.dataset.page;

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
    stat("Начислено", rub(metrics.due), "", `на ${data.asOfMonth}`),
    stat("Оплачено", rub(metrics.paid), "", `${metrics.houses.length} домов`),
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
      <span class="summary-label">Оплачено / начислено</span>
      <strong>${rub(metrics.paid)} / ${rub(metrics.due)}</strong>
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

    return `
      <article class="street-house street-house-${streetTone(house)}">
        <div class="street-house-number">№ ${house.number}</div>
        <strong>${houseBalanceText(house)}</strong>
        <span>${housePaymentLabel(house)}</span>
      </article>
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
              ${includeLinks ? `<td><a href="${house.url}">открыть</a></td>` : ""}
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
              <td><a href="${house.url}">открыть</a></td>
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
          (payment) => `
          <article class="item">
            <div class="item-row">
              <strong>Дом ${payment.houseNumber}</strong>
              <strong>${rub(payment.amount)}</strong>
            </div>
            <p class="muted">${formatDate(payment.paidAt)} · ${payment.method} · ${payment.source}</p>
          </article>
        `
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
  const code = decodeURIComponent(location.pathname.replace("/h/", "") || new URLSearchParams(location.search).get("code"));
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
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "medium"
  }).format(new Date(value));
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

async function loadTelegramStatus() {
  const target = document.querySelector("#telegramStatus");
  if (!target) return;
  try {
    renderTelegramStatus(target, await api("/api/admin/telegram"));
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
  renderPaymentForm(data.houses);
  renderExpenseForm(data.categories);
  renderHouseForm();
  renderAdminHousesTable(
    document.querySelector("#adminHouses"),
    data.houses.map((house) => {
      const publicRow = data.dashboard.houses.find((item) => item.number === house.number) || {};
      return { ...house, ...publicRow };
    })
  );
  renderAdminPayments(document.querySelector("#adminPayments"), data.recentPayments);
  renderAdminExpenses(document.querySelector("#adminExpenses"), data.recentExpenses);
  await loadTelegramStatus();
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
