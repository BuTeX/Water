let paymentCreatedHandler = null;

export function setPaymentCreatedHandler(handler) {
  paymentCreatedHandler = typeof handler === "function" ? handler : null;
}

export async function publishPaymentCreated(payment, options = {}) {
  if (!paymentCreatedHandler) return null;

  try {
    return await paymentCreatedHandler(payment, options);
  } catch (error) {
    console.warn(`Failed to handle payment-created event: ${error.message}`);
    return { error: error.message };
  }
}
