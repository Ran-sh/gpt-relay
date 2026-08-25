import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export class JsonlFileNotificationTransport {
  #file;

  constructor(file) {
    this.#file = path.resolve(file);
  }

  async send(payload) {
    await mkdir(path.dirname(this.#file), { recursive: true });
    await appendFile(this.#file, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'a' });
  }
}
