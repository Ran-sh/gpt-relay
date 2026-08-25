export class ConsoleNotificationTransport {
  #write;

  constructor({ write = (line) => process.stderr.write(line) } = {}) {
    this.#write = write;
  }

  async send(payload) {
    this.#write(`[gpt-relay] ${payload.type} ${payload.attention_id}: ${payload.message}\n`);
  }
}
