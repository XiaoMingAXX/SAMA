import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export class Store {
  constructor(directory) { this.directory = directory; this.samples = []; this.lines = 0; fs.mkdirSync(directory, { recursive: true }); }
  async load() {
    const file = path.join(this.directory, 'samples.ndjson');
    if (fs.existsSync(file)) {
      const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
      for await (const line of lines) {
        this.lines++;
        try { const row = JSON.parse(line); if (row.timestamp && row.values && ['demo','hardware'].includes(row.source)) this.samples.push(row); } catch { /* Ignore an incomplete last line after a power loss. */ }
        if (this.samples.length > 12000) this.samples.splice(0, 2000);
      }
      this.samples = this.samples.slice(-10000);
    }
  }
  settings() {
    const file = path.join(this.directory, 'settings.json');
    if (!fs.existsSync(file)) return {};
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error(`配置文件损坏：${file}；请备份后移走该文件再启动`); }
  }
  saveSettings(settings) { this.atomic('settings.json', JSON.stringify(settings, null, 2)); }
  atomic(name, text) {
    const file = path.join(this.directory, name), temp = `${file}.tmp`;
    fs.writeFileSync(temp, text, 'utf8'); fs.renameSync(temp, file);
  }
  add(sample) {
    fs.appendFileSync(path.join(this.directory, 'samples.ndjson'), `${JSON.stringify(sample)}\n`);
    this.samples.push(sample); this.lines++;
    if (this.samples.length > 10000) this.samples.shift();
    if (this.lines >= 12000) {
      this.atomic('samples.ndjson', this.samples.map(s => JSON.stringify(s)).join('\n') + '\n');
      this.lines = this.samples.length;
    }
  }
  history({ source, host, address, since = 0, limit = 10000 } = {}) {
    return this.samples.filter(s => (!source || s.source === source) && (!host || s.host === host) && (!address || s.address === address) && Date.parse(s.timestamp) >= since).slice(-limit);
  }
}
