const page = document.body.dataset.page;

const money = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0
});

function rub(value) {
  return money.format(Number(value || 0));
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

function stat(label, value, tone = "") {
  return `<div class="stat ${tone}"><span>${label}</span><strong>${value}</strong></div>`;
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

function houseBalanceCell(house) {
  if (house.debt > 0) return `<span class="amount-danger">${rub(house.debt)}</span>`;
  if (house.overpaid > 0) return `<span class="amount-ok">+${rub(house.overpaid)}</span>`;
  return `<span class="amount-ok">закрыто</span>`;
}

function renderHousesTable(target, houses, includeLinks = false) {
  target.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Дом</th>
          <th>Должен платить с</th>
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

function renderAdminHousesTable(target, houses) {
  target.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Дом</th>
          <th>Должен платить с</th>
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
          <article class="item">
            <div class="item-row">
              <strong>${expense.title}</strong>
              <strong>${rub(expense.amount)}</strong>
            </div>
            <p class="muted">${formatDate(expense.spentAt || expense.spent_at)} · ${expense.category || "прочее"}</p>
          </article>
        `
        )
        .join("")
    : `<p class="muted">Расходов пока нет.</p>`;
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
  renderStats(document.querySelector("#dashboardStats"), data.totals);
  renderHousesTable(document.querySelector("#housesTable"), data.houses);
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
  document.querySelector("#housePeriod").textContent = `должен платить с ${data.house.startsOn || "-"} · расчет на ${data.asOfMonth}`;
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
    <label>Должен платить с месяца<input name="startsOn" type="month" /></label>
    <label class="full">Приватная заметка<textarea name="privateNotes"></textarea></label>
    <button type="submit" class="full">Сохранить дом</button>
  `;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
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
