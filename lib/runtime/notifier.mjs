import { redactSecrets } from '../relay/events.mjs';

export class NotificationDispatcher {
  #store;
  #transports;

  constructor({ store, transports = {} }) {
    if (!store) throw new Error('NotificationDispatcher requires store');
    this.#store = store;
    this.#transports = { ...transports };
  }

  enqueue(attention, transportNames = Object.keys(this.#transports)) {
    let inserted = 0;
    for (const transport of transportNames) {
      if (!this.#transports[transport]) throw new Error(`unknown notification transport: ${transport}`);
      if (this.#store.enqueueNotification({
        notification_id: `N-${attention.attention_id}-${transport}`,
        attention_id: attention.attention_id,
        transport,
        payload: redactSecrets(structuredClone(attention))
      })) inserted += 1;
    }
    return inserted;
  }

  async drain({ limit = 100 } = {}) {
    let delivered = 0;
    let failed = 0;
    for (const notification of this.#store.listNotificationDeliveries({ status: 'PENDING', limit })) {
      const transport = this.#transports[notification.transport];
      if (!transport) {
        this.#store.markNotificationFailed(notification.notification_id, 'transport unavailable');
        failed += 1;
        continue;
      }
      try {
        await transport.send(notification.payload);
        this.#store.markNotificationDelivered(notification.notification_id);
        delivered += 1;
      } catch (error) {
        this.#store.markNotificationFailed(
          notification.notification_id,
          error instanceof Error ? error.message : String(error)
        );
        failed += 1;
      }
    }
    return { delivered, failed };
  }
}
